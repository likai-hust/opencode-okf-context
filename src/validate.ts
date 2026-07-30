/**
 * Concept-level validation for OKF documents.
 *
 * OKF v0.2 reference (see types.ts):
 * - A concept is a `.md` file with YAML frontmatter; `type` is the only always-required key.
 * - Convenience frontmatter fields: `type`, `title`, `description`, `tags`.
 *
 * This module is pure (no filesystem I/O) so it can be unit tested directly. It takes a
 * parsed `Concept` and returns a list of `ValidationIssue`s — one per rule violation. The
 * `okf_validate` tool (tools.ts) wraps this to produce a human-readable report, and emits
 * precise `okf_write(...)` fix commands. Auto-fixable issues are repaired via the partial
 * update mode of `okf_write`; content-generating issues (type/description/body) are surfaced
 * as templates so the model/user can supply the value rather than having one fabricated.
 */
import type { Concept } from "./types.js";

/** A single rule violation found while validating a concept. */
export interface ValidationIssue {
  /** How severe: "error" blocks spec compliance; "warning" is advisory. */
  severity: "error" | "warning";
  /** The frontmatter key or "body" / "frontmatter" the issue concerns. */
  field: "type" | "title" | "description" | "tags" | "frontmatter" | "body";
  /** Stable machine code identifying the rule that fired. */
  code: ValidationCode;
  /** Human-readable explanation (shown in the validate report). */
  message: string;
  /**
   * Whether this can be fixed deterministically without generating content.
   * - true  → `suggested` holds the concrete value; a ready-to-run okf_write command is emitted.
   * - false → the fix needs content the validator cannot invent (type/description/body); a
   *           template command with a placeholder is emitted instead.
   */
  autoFixable: boolean;
  /** Suggested value when `autoFixable`; otherwise undefined. */
  suggested?: unknown;
}

/** All validation rule codes. */
export type ValidationCode =
  | "frontmatter-missing"
  | "type-missing"
  | "type-not-string"
  | "title-missing"
  | "description-missing"
  | "tags-not-array"
  | "body-empty";

/**
 * Validate a single parsed concept against the OKF concept rules.
 *
 * Rules (severity → autoFixable):
 *  - frontmatter-missing   error   ✅  no `---` block at all
 *  - type-missing          error   ❌  `type` empty (spec's only hard requirement)
 *  - type-not-string       warning ✅  `type` present but not a string
 *  - title-missing         warning ✅  `title` empty (defaults to the id segment)
 *  - description-missing   warning ❌  `description` empty (needed for progressive disclosure)
 *  - tags-not-array        warning ✅  `tags` present but not a string array
 *  - body-empty            warning ❌  markdown body is empty
 *
 * Returns an empty array for a fully-conforming concept.
 */
export function validateConcept(c: Concept): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // --- frontmatter presence ---
  if (Object.keys(c.frontmatter).length === 0 && c.body.trim().length === 0) {
    // No frontmatter at all and empty body: can't infer much; still flag frontmatter.
    issues.push({
      severity: "error",
      field: "frontmatter",
      code: "frontmatter-missing",
      message:
        "Missing YAML frontmatter block. OKF concepts must start with `---\\ntype: ...\\n---`.",
      autoFixable: true,
    });
  }

  // --- type (the only spec-required key) ---
  const rawType = c.frontmatter.type;
  if (rawType === undefined || rawType === null || String(rawType).trim() === "") {
    issues.push({
      severity: "error",
      field: "type",
      code: "type-missing",
      message:
        "`type` is missing or empty. The OKF spec requires `type` (e.g. \"Metric\", \"BigQuery Table\", \"Runbook\").",
      autoFixable: false,
    });
  } else if (typeof rawType !== "string") {
    issues.push({
      severity: "warning",
      field: "type",
      code: "type-not-string",
      message: `\`type\` is a ${typeof rawType} (${JSON.stringify(rawType)}); it should be a string.`,
      autoFixable: true,
      suggested: String(rawType),
    });
  }

  // --- title (convenience; defaults to the id basename) ---
  const rawTitle = c.frontmatter.title;
  if (rawTitle === undefined || rawTitle === null || String(rawTitle).trim() === "") {
    const baseId = c.id.includes("/") ? c.id.slice(c.id.lastIndexOf("/") + 1) : c.id;
    issues.push({
      severity: "warning",
      field: "title",
      code: "title-missing",
      message: `\`title\` is missing; defaulting to the concept id "${baseId}".`,
      autoFixable: true,
      suggested: baseId,
    });
  } else if (typeof rawTitle !== "string") {
    // Non-string title is normalized to a string, like type.
    issues.push({
      severity: "warning",
      field: "title",
      code: "type-not-string",
      message: `\`title\` is a ${typeof rawTitle} (${JSON.stringify(rawTitle)}); it should be a string.`,
      autoFixable: true,
      suggested: String(rawTitle),
    });
  }

  // --- description (drives progressive disclosure; can't be auto-generated) ---
  const rawDesc = c.frontmatter.description;
  if (rawDesc === undefined || rawDesc === null || String(rawDesc).trim() === "") {
    issues.push({
      severity: "warning",
      field: "description",
      code: "description-missing",
      message:
        "`description` is missing. A one-line description powers index rendering and unload placeholders.",
      autoFixable: false,
    });
  }

  // --- tags (must be a string array when present) ---
  const rawTags = c.frontmatter.tags;
  if (rawTags !== undefined && rawTags !== null) {
    if (!Array.isArray(rawTags)) {
      issues.push({
        severity: "warning",
        field: "tags",
        code: "tags-not-array",
        message: `\`tags\` is ${JSON.stringify(rawTags)} (${typeof rawTags}); it should be an array of strings.`,
        autoFixable: true,
        suggested: normalizeTags(rawTags),
      });
    } else {
      const norm = normalizeTags(rawTags);
      // Detect mixed/non-string entries inside the array (e.g. [1, "a"]).
      const allStrings = rawTags.every((t) => typeof t === "string");
      if (!allStrings) {
        issues.push({
          severity: "warning",
          field: "tags",
          code: "tags-not-array",
          message: `\`tags\` contains non-string entries (${JSON.stringify(rawTags)}); coercing to ${JSON.stringify(norm)}.`,
          autoFixable: true,
          suggested: norm,
        });
      }
    }
  }

  // --- body ---
  if (c.body.trim().length === 0) {
    issues.push({
      severity: "warning",
      field: "body",
      code: "body-empty",
      message: "Markdown body is empty. Add documentation content after the frontmatter.",
      autoFixable: false,
    });
  }

  return issues;
}

/** Coerce an unknown tags value into a clean string array. */
function normalizeTags(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)))
    .filter((s) => s.length > 0);
}

/** Count issues by severity. */
export function summarize(issues: ValidationIssue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    if (i.severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}
