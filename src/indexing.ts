/**
 * Index rendering for okf_list.
 *
 * If a directory has an `index.md`, we parse it (preserve the human-authored entries) and
 * *augment* it with any concepts that aren't listed yet. If no index.md exists, we synthesize
 * one from the bundle's concepts (the OKF spec explicitly allows consumers to do this).
 *
 * Output is always a plain-text list (titles + descriptions), never full concept bodies —
 * that is the whole point of progressive disclosure.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toPosix } from "./discovery.js";
import { listConceptsForIndex, listSubdirsForIndex, describeConcept, relPathFor } from "./registry.js";
import type { Bundle } from "./types.js";

/** Render a directory index for display in okf_list. */
export async function renderIndex(bundle: Bundle, dirRel: string, projectDir?: string): Promise<string> {
  const indexExists = bundle.indexDirs.has(dirRel);
  const authored = indexExists ? await readAuthoredIndex(bundle, dirRel) : "";

  const concepts = listConceptsForIndex(bundle, dirRel);
  const subdirs = listSubdirsForIndex(bundle, dirRel);

  const lines: string[] = [];
  lines.push(`# ${bundle.name} — ${dirRel === "." ? "(root)" : dirRel}/`);
  if (authored) {
    lines.push("", authored.trimEnd());
  }
  if (concepts.length > 0 || subdirs.length > 0) {
    if (authored) lines.push("");
    lines.push("## Concepts");
    for (const c of concepts) {
      const fileHint = projectDir ? `  (file: ${relPathFor(c, projectDir)})` : "";
      lines.push(`- ${describeConcept(c)}  → okf_read(id: "${c.id}", bundle: "${bundle.name}")${fileHint}`);
    }
    for (const sub of subdirs) {
      lines.push(`- 📁 ${toPosix(sub)}/  → okf_list(path: "${toPosix(sub)}", bundle: "${bundle.name}")`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Read the authored index.md body (everything after the optional frontmatter). */
async function readAuthoredIndex(bundle: Bundle, dirRel: string): Promise<string> {
  const abs = dirRel === "." ? join(bundle.root, "index.md") : join(bundle.root, dirRel, "index.md");
  try {
    return (await readFile(abs, "utf8"))
      .replace(/^---[\s\S]*?\n---\n?/, "") // strip frontmatter
      .trim();
  } catch {
    return "";
  }
}

/** Render a top-level bundle manifest (bundle names + concept counts + root index hint). */
export function renderManifest(bundles: Bundle[], maxChars: number): string {
  const lines: string[] = [
    "# OKF knowledge bundles available",
    "",
    "When the user asks to look up, read, or explain knowledge, documentation, concepts,",
    "tables, metrics, or any domain knowledge in this project, you MUST prefer the OKF tools",
    "below over generic file tools (read/glob/grep). Browse the index with okf_list first,",
    "then load a concept with okf_read. Only fall back to read/glob/grep if the topic is",
    "clearly NOT covered by the bundles listed here.",
    "",
    "Knowledge is loaded progressively: okf_list shows titles + descriptions only (cheap);",
    "okf_read loads the full text. Loaded concepts are auto-unloaded after a few turns to",
    "keep the context lean — call okf_unload to release them sooner, or okf_read to reload.",
    "",
  ];
  let budget = maxChars - lines.join("\n").length;
  for (const b of bundles) {
    const header = `## ${b.name} (${b.concepts.size} concepts${b.hasLog ? ", has log" : ""})`;
    const hint = `Start: okf_list(bundle: "${b.name}")`;
    const entry = `${header}\n${hint}`;
    if (budget < entry.length + 2) break;
    lines.push(entry, "");
    budget -= entry.length + 2;
  }
  return lines.join("\n").slice(0, maxChars) + "\n";
}
