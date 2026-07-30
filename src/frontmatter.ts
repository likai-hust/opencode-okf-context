/**
 * Minimal YAML frontmatter parsing / serialization.
 *
 * OKF files are markdown with an optional leading `---\n...\n---` block. We use the
 * `yaml` package for correctness but keep the frontmatter boundary handling here so
 * the rest of the code deals with plain {frontmatter, body} objects.
 */
import { parse, stringify } from "yaml";

/** Parsed split of a markdown document. */
export interface SplitDoc {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Whether the source started with a frontmatter block. */
  hasFrontmatter: boolean;
}

const DELIM = "---";
const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split raw markdown into frontmatter object and body string. */
export function splitFrontmatter(raw: string): SplitDoc {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    return { frontmatter: {}, body: raw, hasFrontmatter: false };
  }
  const fmText = m[1] ?? "";
  const body = raw.slice(m[0].length);
  let frontmatter: Record<string, unknown> = {};
  if (fmText.trim().length > 0) {
    const parsed = parse(fmText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  }
  return { frontmatter, body, hasFrontmatter: true };
}

/** Coerce an unknown frontmatter value into a plain string for display. */
export function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Coerce an unknown frontmatter value into a string array. */
export function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const out = arr.map((v) => asString(v)).filter((v): v is string => v !== undefined);
  return out.length > 0 ? out : undefined;
}

/**
 * Reconstruct a markdown document from frontmatter + body.
 * Always emits a frontmatter block (OKF concepts require at least `type`).
 */
export function serializeDoc(frontmatter: Record<string, unknown>, body: string): string {
  const fmText = stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `${DELIM}\n${fmText}\n${DELIM}\n\n${body.trimEnd()}\n`;
}
