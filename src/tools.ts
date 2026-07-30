/**
 * The five custom tools registered by the plugin:
 *   okf_list   — browse a bundle / directory index (L1 progressive disclosure)
 *   okf_read   — load a full concept (L2); footer nudges the model to unload when done
 *   okf_search — keyword search across titles/descriptions/tags/body; returns snippets, not full docs
 *   okf_write  — create/update a concept; updates parent index.md and prepends to log.md
 *   okf_unload — explicitly unload one or all loaded concepts; reports chars freed
 *
 * Tools return strings (opencode renders tool output as text). okf_read output is what the
 * messages-transform layer later replaces with placeholders — it is the only output we track.
 */
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { serializeDoc, splitFrontmatter } from "./frontmatter.js";
import { toPosix } from "./discovery.js";
import { renderIndex } from "./indexing.js";
import {
  describeConcept,
  normalizeId,
  relPathFor,
  renderConceptFull,
  resolveBundle,
  resolveConcept,
} from "./registry.js";
import { state } from "./state.js";
import { conceptKey } from "./registry.js";
import type { OkfConfig } from "./config.js";
import type { Bundle, Concept } from "./types.js";

/** Header line giving the on-disk file path, so the agent can Read/Edit directly. */
function readHeader(c: Concept, projectDir: string): string {
  return `<!-- file: ${relPathFor(c, projectDir)} -->\n`;
}

/** Footer appended to okf_read output so the model knows how to release the context. */
function readFooter(c: { id: string }, bundleName: string): string {
  return `\n\n---\n_This OKF concept is now in context. When you no longer need it, call okf_unload(id: "${c.id}", bundle: "${bundleName}") to free the context._`;
}

/** Helper: ensure bundles are loaded; returns them or throws a friendly message. */
async function requireBundles(): Promise<Bundle[]> {
  const bundles = await state.ensureLoaded();
  if (bundles.length === 0) {
    throw new Error("No OKF bundles found. Put markdown files with YAML frontmatter (type: ...) in your project, or configure bundles in .opencode/okf.jsonc.");
  }
  return bundles;
}

export function buildTools(cfg: OkfConfig) {
  return {
    okf_list: tool({
      description:
        "List the index of an OKF knowledge bundle (or a sub-directory). Returns concept titles + descriptions only (progressive disclosure), never full documents. Use this before okf_read to discover what's available. Args: bundle (name; omit if only one bundle), path (sub-directory relative to bundle root; default root).",
      args: {
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
        path: tool.schema.string().optional().describe('Sub-directory path (e.g. "tables"). Default: root.'),
      },
      async execute(args, context) {
        const bundles = await requireBundles();
        const bundle = resolveBundle(bundles, args.bundle);
        if (!bundle) {
          throw new Error(`Bundle not found: ${args.bundle ?? "(none)"}. Available: ${bundles.map((b) => b.name).join(", ")}`);
        }
        const dirRel = normalizeDir(args.path);
        return await renderIndex(bundle, dirRel, context.directory);
      },
    }),

    okf_read: tool({
      description:
        'Load the FULL markdown of an OKF concept into context. Only load what you actually need — loaded concepts occupy context until auto-unloaded (after a few turns) or until you call okf_unload. Args: id (concept path, e.g. "tables/customers"), bundle (name; omit if only one).',
      args: {
        id: tool.schema.string().describe('Concept id, e.g. "tables/customers" (no leading slash, no .md).'),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
      },
      async execute(args, context) {
        const bundles = await requireBundles();
        const found = resolveConcept(bundles, args.id, args.bundle);
        if (!found) {
          const id = normalizeId(args.id);
          throw new Error(`Concept not found: ${id}${args.bundle ? ` in bundle ${args.bundle}` : ""}. Use okf_list to browse the index.`);
        }
        const { bundle, concept } = found;
        const body = renderConceptFull(concept);
        return readHeader(concept, context.directory) + body + readFooter(concept, bundle.name);
      },
    }),

    okf_search: tool({
      description:
        "Keyword search across an OKF bundle's concepts. Matches title, description, tags and body. Returns concise matches (path + title: description + a line snippet), NOT full documents — use okf_read on a matched id to load the full text. Args: query, bundle (optional), maxResults (default 10).",
      args: {
        query: tool.schema.string().describe("Search term (case-insensitive)."),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit to search all bundles."),
        maxResults: tool.schema.number().optional().describe("Max matches to return (default 10)."),
      },
      async execute(args, context) {
        const bundles = await requireBundles();
        const scope = args.bundle ? bundles.filter((b) => b.name === args.bundle) : bundles;
        if (scope.length === 0) {
          throw new Error(`Bundle not found: ${args.bundle}`);
        }
        const q = args.query.toLowerCase();
        const limit = args.maxResults ?? 10;
        const hits: string[] = [];
        for (const b of scope) {
          for (const c of b.concepts.values()) {
            const snippet = matchSnippet(c, q);
            if (snippet) {
              const file = relPathFor(c, context.directory);
              hits.push(`- [${b.name}] ${describeConcept(c)}  (file: ${file})  → okf_read(id: "${c.id}", bundle: "${b.name}")\n    ${snippet}`);
              if (hits.length >= limit) break;
            }
          }
          if (hits.length >= limit) break;
        }
        if (hits.length === 0) return `No matches for "${args.query}".`;
        return `${hits.length} match${hits.length === 1 ? "" : "es"} for "${args.query}":\n\n${hits.join("\n")}\n`;
      },
    }),

    okf_write: tool({
      description:
        'Create or update an OKF concept document. Writes YAML frontmatter + body to <bundle>/<id>.md, updates the parent directory index.md entry, and prepends a log.md entry under today\'s date. Args: id, type (required), title?, description?, tags?, body (markdown), bundle?, mode ("create"|"update", default update).',
      args: {
        id: tool.schema.string().describe('Concept id, e.g. "tables/new_table" (no leading slash, no .md).'),
        type: tool.schema.string().describe('Concept type, e.g. "BigQuery Table", "Metric".'),
        title: tool.schema.string().optional().describe("Display title. Defaults to the id."),
        description: tool.schema.string().optional().describe("One-line description (used in indexes & placeholders)."),
        tags: tool.schema.array(tool.schema.string()).optional().describe("Tags."),
        body: tool.schema.string().describe("Markdown body of the concept."),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
        mode: tool.schema.enum(["create", "update"]).optional().describe('"create" fails if it exists; "update" (default) overwrites.'),
      },
      async execute(args) {
        if (!cfg.write.enabled) {
          throw new Error("okf_write is disabled in config (write.enabled = false).");
        }
        const bundles = await requireBundles();
        const bundle = resolveBundle(bundles, args.bundle);
        if (!bundle) {
          throw new Error(`Bundle not found: ${args.bundle ?? "(none)"}`);
        }
        const id = normalizeId(args.id);
        if (!id || id.includes("..") || isReservedId(id)) {
          throw new Error(`Invalid concept id: "${args.id}". Must not be empty, must not escape the bundle, and must not use reserved name index/log.`);
        }

        const existed = bundle.concepts.has(id);
        if (args.mode === "create" && existed) {
          throw new Error(`Concept already exists: ${id} (mode was "create").`);
        }

        const relPath = id + ".md";
        const absPath = join(bundle.root, relPath);
        // Path-traversal guard: resolved path must stay inside bundle root.
        const rel = toPosix(relative(bundle.root, absPath));
        if (rel.startsWith("..") || rel === "" || rel.includes("..")) {
          throw new Error("Invalid path: escapes the bundle root.");
        }

        const fm: Record<string, unknown> = { type: args.type };
        if (args.title !== undefined) fm.title = args.title;
        if (args.description !== undefined) fm.description = args.description;
        if (args.tags !== undefined) fm.tags = args.tags;
        const content = serializeDoc(fm, args.body);

        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content, "utf8");

        const sideEffects: string[] = [];
        if (cfg.write.updateIndex) {
          try {
            await updateParentIndex(bundle, id, args.title ?? id, args.description);
            sideEffects.push("parent index.md updated");
          } catch {
            /* best-effort */
          }
        }
        if (cfg.write.appendLog) {
          try {
            await appendLog(bundle, `${existed ? "Updated" : "Created"} concept ${id}.`);
            sideEffects.push("log.md appended");
          } catch {
            /* best-effort */
          }
        }

        // Refresh in-memory cache for this concept.
        const { parseConcept } = await import("./discovery.js");
        bundle.concepts.set(id, await parseConcept(absPath, bundle.root));
        state.markStale();

        return `${existed ? "Updated" : "Created"} concept ${id} in bundle ${bundle.name}.\n${sideEffects.join("; ")}.\nFile: ${absPath}\n\nYou can read it back with okf_read(id: "${id}", bundle: "${bundle.name}").`;
      },
    }),

    okf_unload: tool({
      description:
        'Release one or all loaded OKF concepts from context immediately. The auto-unload would happen anyway after a few turns; call this when you are done with a concept to free context now. The concept stays on disk — okf_read can reload it later. Args: id (one concept), or all: true (every loaded concept), bundle (optional).',
      args: {
        id: tool.schema.string().optional().describe("Concept id to unload."),
        all: tool.schema.boolean().optional().describe("If true, unload every loaded concept."),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
      },
      async execute(args, context) {
        if (args.all) {
          // Collect all known concept keys (best-effort: all concepts in scope).
          const bundles = await requireBundles();
          const scope = args.bundle ? bundles.filter((b) => b.name === args.bundle) : bundles;
          const keys: string[] = [];
          for (const b of scope) for (const c of b.concepts.values()) keys.push(conceptKey(b.name, c.id));
          const n = state.unloadAll(context.sessionID, keys);
          return `Marked ${n} concept(s) for unload in bundle(s): ${scope.map((b) => b.name).join(", ")}. They will be replaced with placeholders on the next request.`;
        }
        if (!args.id) throw new Error("Provide id or all:true.");
        const bundles = await requireBundles();
        const found = resolveConcept(bundles, args.id, args.bundle);
        if (!found) throw new Error(`Concept not found: ${args.id}`);
        const key = conceptKey(found.bundle.name, found.concept.id);
        const wasNew = state.unload(context.sessionID, key);
        return `${wasNew ? "Marked" : "Already marked"} concept ${found.concept.id} (bundle ${found.bundle.name}) for unload. It will be replaced with a placeholder on the next request.`;
      },
    }),
  };
}

// ---------- helpers ----------

function normalizeDir(p: string | undefined): string {
  if (!p) return ".";
  let n = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return n === "" ? "." : n;
}

function isReservedId(id: string): boolean {
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return base.toLowerCase() === "index" || base.toLowerCase() === "log";
}

/** Return a one-line snippet around the first match, or undefined if no match. */
function matchSnippet(c: import("./types.js").Concept, q: string): string | undefined {
  const haystacks = [
    c.title ?? "",
    c.description ?? "",
    (c.tags ?? []).join(" "),
    c.body,
  ];
  const joined = haystacks.join("\n").toLowerCase();
  const idx = joined.indexOf(q);
  if (idx === -1) return undefined;
  // Find which line the match is on (in the body) for a nicer snippet.
  const lineStart = joined.lastIndexOf("\n", idx) + 1;
  const lineEnd = joined.indexOf("\n", idx);
  const snippet = joined.slice(lineStart, lineEnd === -1 ? lineStart + 120 : lineEnd).trim();
  return snippet.length > 0 ? `…${snippet}…` : undefined;
}

/** Update the parent directory's index.md: ensure an entry for this concept exists. */
async function updateParentIndex(
  bundle: import("./types.js").Bundle,
  id: string,
  title: string,
  description: string | undefined,
): Promise<void> {
  const dirRel = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : ".";
  const indexAbs = join(bundle.root, dirRel, "index.md");
  const existing = await readFile(indexAbs, "utf8").catch(() => null);
  const link = `${id.slice(id.lastIndexOf("/") + 1)}.md`;
  const entry = `* [${title}](./${link})${description ? ` - ${description}` : ""}`;
  if (existing === null) {
    // No index.md in this dir: create a minimal one.
    await mkdir(dirname(indexAbs), { recursive: true });
    await writeFile(indexAbs, `# Index\n\n${entry}\n`, "utf8");
    bundle.indexDirs.add(dirRel);
    return;
  }
  // If an entry linking to this file already exists, replace it; else append under first list.
  const linkRe = new RegExp(`^.*\\]\\(\\./?${escapeRegExp(link)}\\).*$`, "m");
  if (linkRe.test(existing)) {
    await writeFile(indexAbs, existing.replace(linkRe, entry), "utf8");
    return;
  }
  // Append after the first markdown list item, or at the end.
  const listMatch = existing.match(/(\n\*.*)/);
  if (listMatch && listMatch.index !== undefined) {
    const insertAt = listMatch.index + listMatch[0].length;
    await writeFile(indexAbs, existing.slice(0, insertAt) + "\n" + entry + existing.slice(insertAt), "utf8");
  } else {
    await writeFile(indexAbs, existing.trimEnd() + "\n\n" + entry + "\n", "utf8");
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Prepend a bullet under today's ISO date heading to log.md (create file if missing). */
async function appendLog(bundle: import("./types.js").Bundle, message: string): Promise<void> {
  const logAbs = join(bundle.root, "log.md");
  const today = new Date().toISOString().slice(0, 10);
  const existing = await readFile(logAbs, "utf8").catch(() => "");
  const bullet = `- ${message}`;
  const headingRe = new RegExp(`^(## ${today})\\s*$`, "m");
  if (headingRe.test(existing)) {
    // Insert bullet right after the heading.
    await writeFile(
      logAbs,
      existing.replace(headingRe, `## ${today}\n${bullet}`),
      "utf8",
    );
    return;
  }
  // New heading at the top (after any H1 title), newest first.
  const lines = existing.split("\n");
  let insertAt = 0;
  if (lines.length > 0 && lines[0].startsWith("# ") && !lines[0].startsWith("## ")) {
    insertAt = 1;
    while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
  }
  const block = `## ${today}\n${bullet}\n\n`;
  lines.splice(insertAt, 0, block);
  await writeFile(logAbs, lines.join("\n"), "utf8");
  bundle.hasLog = true;
}

// Re-export splitFrontmatter for tooling that wants to reparse after writes.
export { splitFrontmatter };
