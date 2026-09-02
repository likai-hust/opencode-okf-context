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
import { listTypedConceptsForIndex, listSubdirsForIndex, describeConcept, relPathFor } from "./registry.js";
import { extractLinks } from "./validate.js";
import { PLUGIN_VERSION } from "./version.js";
import type { Bundle } from "./types.js";

/** Render a directory index for display in okf_list. */
export async function renderIndex(bundle: Bundle, dirRel: string, projectDir?: string): Promise<string> {
  const indexExists = bundle.indexDirs.has(dirRel);
  const authored = indexExists ? await readAuthoredIndex(bundle, dirRel) : "";

  const concepts = listTypedConceptsForIndex(bundle, dirRel);
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
    const raw = (await readFile(abs, "utf8"))
      .replace(/^---[\s\S]*?\n---\n?/, "") // strip frontmatter
      .trim();
    // Drop lines linking to .md files WITHOUT a `type`, so the listing stays consistent
    // with the scheme-B guard (only typed concepts are shown).
    return filterUntypedLinks(raw, bundle, dirRel);
  } catch {
    return "";
  }
}

/**
 * Remove lines from authored index content that link to in-bundle concepts without a `type`.
 * A line is dropped if it contains a markdown link whose target resolves to a concept in the
 * bundle AND that concept has no `type`. Lines without links, external links, and links to
 * typed concepts are always kept.
 */
function filterUntypedLinks(authored: string, bundle: Bundle, dirRel: string): string {
  const lines = authored.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const links = extractLinks(line, dirRel === "." ? "" : dirRel);
    let drop = false;
    for (const link of links) {
      const id = link.replace(/\.md$/i, "");
      const concept = bundle.concepts.get(id);
      if (concept && (concept.type === undefined || concept.type === "")) {
        drop = true; // links to an untyped file → hide this line
        break;
      }
    }
    if (!drop) out.push(line);
  }
  return out.join("\n").trim();
}

/** Render a top-level bundle manifest (bundle names + concept counts + root index hint). */
export function renderManifest(bundles: Bundle[], maxChars: number): string {
  const lines: string[] = [
    "# OKF knowledge bundles available",
    "",
    "Trigger the okf_* tools whenever you need domain knowledge — in BOTH situations:",
    "- (reactive) the user asks to understand/explain a concept, metric, table, or term;",
    "- (proactive) YOU need context to write correct code — e.g. you encounter a domain",
    "  noun (metric/table/business term) you're unsure about, or you're about to hardcode",
    "  a value the bundle may define. When unsure, okf_search the term before guessing.",
    "",
    'Trigger phrases (any language): "什么是X / 给我讲讲X / X怎么定义的 / X的口径",',
    '"what is X / explain X / how is X defined".',
    "",
    "Prefer okf_* tools over generic read/glob/grep for any topic the bundles cover.",
    "Only fall back to file tools if the topic is clearly NOT covered here.",
    "",
    "Quick decision guide:",
    "- Heard a specific term/name → okf_search(term) first",
    "- Browse what a bundle contains → okf_list",
    "- Already know the concept id → okf_read directly",
    "- Impact / dependency analysis → okf_refs(id) (who references X / what X references)",
    "",
    "Knowledge loads progressively: okf_list shows titles+descriptions (cheap); okf_read",
    "loads full text. Loaded concepts auto-unload after a few turns — call okf_unload to",
    "release sooner, okf_read to reload.",
    "",
    `Plugin: opencode-okf-context v${PLUGIN_VERSION}`,
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
