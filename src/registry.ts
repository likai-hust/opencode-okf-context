/**
 * Shared helpers used by tools and the message-transform layer:
 *  - bundle/concept resolution
 *  - compact one-line summaries for index rendering
 *  - placeholder text for unloaded concepts
 *  - glob matching for protectedConcepts
 *
 * Kept dependency-free and pure so they can be unit tested directly.
 */
import { relative, sep } from "node:path";
import { conceptIdFromRelPath } from "./discovery.js";
import type { Bundle, Concept } from "./types.js";

/** Build the stable key used to track a loaded concept across session state. */
export function conceptKey(bundle: string, id: string): string {
  return `${bundle}::${id}`;
}

/**
 * A concept's file path relative to the project root (POSIX separators), for display to
 * the agent so it can Read/Edit the file directly without guessing the path. Falls back to
 * the absolute path if the concept sits outside the project.
 */
export function relPathFor(c: Concept, projectDir: string): string {
  let rel = relative(projectDir, c.path);
  if (!rel || rel.startsWith("..")) return c.path;
  return rel.split(sep).join("/");
}

/** Resolve a bundle by name (exact) or, if only one exists, by default. */
export function resolveBundle(bundles: Bundle[], name?: string): Bundle | undefined {
  if (!name) {
    return bundles.length === 1 ? bundles[0] : undefined;
  }
  return bundles.find((b) => b.name === name);
}

/** Find a concept by id, optionally constrained to a bundle name. */
export function resolveConcept(
  bundles: Bundle[],
  id: string,
  bundleName?: string,
): { bundle: Bundle; concept: Concept } | undefined {
  const normalized = normalizeId(id);
  const candidates = bundleName
    ? bundles.filter((b) => b.name === bundleName)
    : bundles;
  for (const b of candidates) {
    const c = b.concepts.get(normalized);
    if (c) return { bundle: b, concept: c };
  }
  return undefined;
}

/** Normalize a concept id: strip leading slash and .md suffix. */
export function normalizeId(id: string): string {
  let n = id.replace(/\\/g, "/");
  if (n.startsWith("/")) n = n.slice(1);
  n = n.replace(/\.md$/i, "");
  return n;
}

/** A compact, single-line descriptor for a concept (used in indexes & placeholders). */
export function describeConcept(c: Concept): string {
  const title = c.title ?? c.id;
  const type = c.type ? `[${c.type}]` : "";
  const desc = c.description ?? "";
  const descPart = desc ? ` — ${desc}` : "";
  return `${title}${type ? " " + type : ""}${descPart}`.trim();
}

/** Estimate the characters occupied by a concept's full rendered text. */
export function conceptCharCount(c: Concept): number {
  return renderConceptFull(c).length;
}

/** Render the full markdown of a concept (frontmatter + body) for okf_read output. */
export function renderConceptFull(c: Concept): string {
  const fmLines: string[] = ["---"];
  for (const [k, v] of Object.entries(c.frontmatter)) {
    fmLines.push(`${k}: ${renderValue(v)}`);
  }
  fmLines.push("---", "");
  return fmLines.join("\n") + c.body.trimEnd() + "\n";
}

function renderValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(renderValue).join(", ")}]`;
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return String(v);
}

/**
 * Build the placeholder text substituted in place of an unloaded concept's full output.
 * "description" mode keeps title + type + description so the model retains what it was.
 *
 * Wording matters: the placeholder must NOT read as a directive to reload. Models that see
 * "unloaded … Reload with okf_read" after every read can enter a read→unload→reload loop
 * (observed in the wild: a model re-reading a doc forever to "verify" it). So the text
 * states the unload is routine, that no action is needed, and that okf_read is only for
 * when the content is genuinely needed again.
 */
export function placeholderFor(
  bundleName: string,
  c: Concept,
  mode: "description" | "minimal",
  freedChars: number,
): string {
  const id = c.id;
  const freed = `[OKF] concept "${id}" auto-unloaded — ~${Math.round(freedChars)} chars freed. ` +
    `This is routine context management, not an error; no action is needed. ` +
    `Call okf_read(id: "${id}", bundle: "${bundleName}") ONLY if you genuinely need the full text again.`;
  if (mode === "minimal") {
    return freed;
  }
  const desc = describeConcept(c);
  return `${freed}\nSummary retained: ${desc}`;
}

/** Placeholder used when a concept was unloaded because it was re-read (dedup). */
export function dedupPlaceholder(bundleName: string, id: string): string {
  return `[OKF] earlier read of "${id}" deduplicated — the latest full text is retained below; no action is needed. Reload later with okf_read(id: "${id}", bundle: "${bundleName}") only if needed.`;
}

/** Build a sorted list of (concept) entries for an index. */
export function listConceptsForIndex(
  bundle: Bundle,
  dirRel: string,
): Concept[] {
  const prefix = dirRel === "." ? "" : dirRel + "/";
  const out: Concept[] = [];
  for (const c of bundle.concepts.values()) {
    const dir = c.id.includes("/") ? c.id.slice(0, c.id.lastIndexOf("/")) : ".";
    if (dir === dirRel || c.id.startsWith(prefix)) {
      // Only top-level concepts of that dir go in a synthesized per-dir index;
      // sub-directories are listed separately.
      if (dir === dirRel) out.push(c);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Same as listConceptsForIndex but filters OUT concepts without a `type`.
 * Used by okf_list so the index only shows real OKF concepts — plain .md files
 * (README, drafts, notes) that happen to live in the bundle are hidden from the
 * listing. They are still discovered (so okf_validate can report type-missing)
 * and still participate in the backlink index; only the list view hides them.
 */
export function listTypedConceptsForIndex(
  bundle: Bundle,
  dirRel: string,
): Concept[] {
  return listConceptsForIndex(bundle, dirRel).filter((c) => c.type !== undefined && c.type !== "");
}

/** List immediate subdirectories (POSIX, relative) that contain concepts or an index. */
export function listSubdirsForIndex(bundle: Bundle, dirRel: string): string[] {
  const prefix = dirRel === "." ? "" : dirRel + "/";
  const dirs = new Set<string>();
  for (const c of bundle.concepts.values()) {
    // Only typed concepts contribute a subdirectory entry — a dir containing only
    // plain .md docs (no `type`) should not appear as a navigable folder.
    if (c.type === undefined || c.type === "") continue;
    if (dirRel !== "." && !c.id.startsWith(prefix)) continue;
    const rest = dirRel === "." ? c.id : c.id.slice(prefix.length);
    if (!rest.includes("/")) continue;
    const sub = rest.slice(0, rest.indexOf("/"));
    dirs.add(prefix + sub);
  }
  for (const d of bundle.indexDirs) {
    if (d === "." ) continue;
    if (dirRel === "." || d.startsWith(prefix)) {
      const rest = dirRel === "." ? d : d.slice(prefix.length);
      if (rest && !rest.includes("/")) dirs.add(prefix + rest);
    }
  }
  return Array.from(dirs).sort();
}

/** Minimal glob matcher supporting * and trailing ** (sufficient for protectedConcepts). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const re = globToRegExp(pattern);
  return re.test(value);
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if ("/._-".includes(ch)) {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Re-export for tooling convenience. */
export { conceptIdFromRelPath };
