/**
 * The six custom tools registered by the plugin:
 *   okf_list    — browse a bundle / directory index (L1 progressive disclosure)
 *   okf_read    — load a full concept (L2); footer nudges the model to unload when done
 *   okf_search  — keyword search across titles/descriptions/tags/body; returns snippets, not full docs
 *   okf_write   — create/update a concept (partial update supported); updates parent index.md and prepends to log.md
 *   okf_validate— read-only concept validation; emits okf_write fix commands for issues found
 *   okf_unload  — explicitly unload one or all loaded concepts; reports chars freed
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
import { validateConcept, summarize, type ValidationIssue } from "./validate.js";
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
        "Keyword search across an OKF bundle's concepts. Searches METADATA first (title + description + tags) — the cheap, index-level fields — and only falls back to the BODY when metadata yields no matches, so full text is scanned only as a last resort. Each hit is tagged with its match tier. Returns concise matches (path + title: description + a snippet), NOT full documents — use okf_read on a matched id to load the full text. Args: query, bundle (optional), maxResults (default 10).",
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

        // Pass 1: metadata only (title/description/tags) across all concepts in scope.
        // This is the progressive-disclosure preference — search the cheap index fields first.
        const metaHits: Array<{ bundle: Bundle; concept: Concept; hit: SearchHit }> = [];
        const remaining: Array<{ bundle: Bundle; concept: Concept }> = [];
        for (const b of scope) {
          for (const c of b.concepts.values()) {
            const hit = matchMetadata(c, q);
            if (hit) {
              metaHits.push({ bundle: b, concept: c, hit });
              if (metaHits.length >= limit) break;
            } else {
              remaining.push({ bundle: b, concept: c });
            }
          }
          if (metaHits.length >= limit) break;
        }

        // If metadata matched enough, return those without scanning any body.
        if (metaHits.length >= limit) {
          return formatSearchHits(args.query, metaHits.slice(0, limit), false, context.directory);
        }

        // Pass 2 (fallback): metadata found some but fewer than `limit`; top up by scanning
        // bodies of the concepts that did NOT match metadata.
        const bodyHits: Array<{ bundle: Bundle; concept: Concept; hit: SearchHit }> = [];
        let needed = limit - metaHits.length;
        if (needed > 0) {
          for (const { bundle, concept } of remaining) {
            const hit = matchBody(concept, q);
            if (hit) {
              bodyHits.push({ bundle, concept, hit });
              needed--;
              if (needed <= 0) break;
            }
          }
        }

        const all = [...metaHits, ...bodyHits];
        if (all.length === 0) return `No matches for "${args.query}".`;

        // Report whether a body fallback occurred, so the caller knows full text was scanned.
        const fellBack = bodyHits.length > 0;
        return formatSearchHits(args.query, all, fellBack, context.directory);
      },
    }),

    okf_write: tool({
      description:
        'Create or update an OKF concept document. Writes YAML frontmatter + body to <bundle>/<id>.md, updates the parent directory index.md entry, and prepends a log.md entry under today\'s date. In "update" mode (default), only the fields you pass are changed — others are read from disk and preserved, so you can fix a single field without restating the whole document. In "create" mode all provided fields are written fresh. Args: id, type? (required in create; optional in update), title?, description?, tags?, body? (required in create; optional in update), bundle?, mode ("create"|"update", default update).',
      args: {
        id: tool.schema.string().describe('Concept id, e.g. "tables/new_table" (no leading slash, no .md).'),
        type: tool.schema.string().optional().describe('Concept type, e.g. "BigQuery Table", "Metric". Required when creating; optional when updating (omitted = keep current).'),
        title: tool.schema.string().optional().describe("Display title. Defaults to the id. Omit in update to keep current."),
        description: tool.schema.string().optional().describe("One-line description (used in indexes & placeholders). Omit in update to keep current."),
        tags: tool.schema.array(tool.schema.string()).optional().describe("Tags. Omit in update to keep current."),
        body: tool.schema.string().optional().describe("Markdown body of the concept. Required when creating; optional when updating (omitted = keep current)."),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
        mode: tool.schema.enum(["create", "update"]).optional().describe('"create" fails if it exists; "update" (default) merges: only passed fields change, others are preserved from disk.'),
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

        const mode = args.mode ?? "update";
        let existed = bundle.concepts.has(id);

        const relPath = id + ".md";
        const absPath = join(bundle.root, relPath);
        // Path-traversal guard: resolved path must stay inside bundle root.
        const rel = toPosix(relative(bundle.root, absPath));
        if (rel.startsWith("..") || rel === "" || rel.includes("..")) {
          throw new Error("Invalid path: escapes the bundle root.");
        }

        if (mode === "create" && existed) {
          throw new Error(`Concept already exists: ${id} (mode was "create").`);
        }

        // --- Resolve final frontmatter + body ---
        // In "create" mode, everything is written fresh: `type` and `body` are required.
        // In "update" mode, only passed fields change; missing ones are read from disk so a
        // single field can be fixed without restating the whole document.
        let finalType = args.type;
        let finalBody = args.body;
        let baseFm: Record<string, unknown> = {};

        if (mode === "update") {
          if (!existed) {
            // File not tracked in cache — check the disk before treating as create.
            const onDisk = await readFile(absPath, "utf8").catch(() => null);
            existed = onDisk !== null;
          }
          if (existed) {
            const onDisk = await readFile(absPath, "utf8");
            const split = splitFrontmatter(onDisk);
            baseFm = { ...split.frontmatter };
            // type/body default to whatever is on disk when not supplied.
            if (finalType === undefined && typeof baseFm.type === "string") {
              finalType = baseFm.type;
            }
            if (finalBody === undefined) {
              finalBody = split.body;
            }
          }
        }

        // After merge, validate required fields for the resulting document.
        if (finalType === undefined || String(finalType).trim() === "") {
          throw new Error(
            `Concept ${id} would have no \`type\` after this write. The OKF spec requires \`type\` — pass type:"<your type>" (mode:"update" preserves the existing type).`,
          );
        }
        if (finalBody === undefined) {
          finalBody = "";
        }

        // Merge: start from disk baseline (update) or empty (create), overlay passed values.
        const fm: Record<string, unknown> = { ...baseFm, type: finalType };
        if (args.title !== undefined) fm.title = args.title;
        if (args.description !== undefined) fm.description = args.description;
        if (args.tags !== undefined) fm.tags = args.tags;
        const content = serializeDoc(fm, finalBody);

        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content, "utf8");

        const sideEffects: string[] = [];
        const displayTitle = (fm.title !== undefined ? String(fm.title) : undefined) ?? id;
        if (cfg.write.updateIndex) {
          try {
            await updateParentIndex(bundle, id, displayTitle, fm.description !== undefined ? String(fm.description) : undefined);
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

        const verb = existed ? "Updated" : "Created";
        const mergedNote = existed && mode === "update" ? " (partial: only changed fields written)" : "";
        return `${verb} concept ${id} in bundle ${bundle.name}${mergedNote}.\n${sideEffects.join("; ")}.\nFile: ${absPath}\n\nYou can read it back with okf_read(id: "${id}", bundle: "${bundle.name}").`;
      },
    }),

    okf_validate: tool({
      description:
        'Read-only validation of OKF concept documents against the concept-level rules (type required; type/title/description/tags well-formed; body non-empty). Does NOT write files. Returns a report listing issues per concept, each with a ready-to-run okf_write(...) fix command (auto-fixable issues are pre-filled; content issues like missing type/description show a placeholder). To actually fix an issue, call okf_write with mode:"update" passing only the changed field(s). Args: id (validate one concept), or bundle/all (validate a whole bundle). At least one of id / all must be given.',
      args: {
        id: tool.schema.string().optional().describe('Concept id to validate, e.g. "tables/customers".'),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
        all: tool.schema.boolean().optional().describe("Validate every concept in the bundle (ignored if id is given)."),
      },
      async execute(args) {
        const bundles = await requireBundles();
        const scope = args.bundle ? bundles.filter((b) => b.name === args.bundle) : bundles;
        if (scope.length === 0) {
          throw new Error(`Bundle not found: ${args.bundle ?? "(none)"}. Available: ${bundles.map((b) => b.name).join(", ")}`);
        }

        // Determine the set of (bundle, concept) pairs to validate.
        const targets: Array<{ bundle: Bundle; concept: Concept }> = [];
        if (args.id) {
          const id = normalizeId(args.id);
          let found = false;
          for (const b of scope) {
            const c = b.concepts.get(id);
            if (c) {
              targets.push({ bundle: b, concept: c });
              found = true;
              break;
            }
          }
          if (!found) {
            throw new Error(`Concept not found: ${id}. Use okf_list to browse available concepts.`);
          }
        } else {
          if (!args.all) {
            throw new Error('Provide id (validate one concept) or all:true (validate the whole bundle).');
          }
          for (const b of scope) {
            for (const c of b.concepts.values()) {
              targets.push({ bundle: b, concept: c });
            }
          }
        }
        targets.sort((a, b) => a.bundle.name.localeCompare(b.bundle.name) || a.concept.id.localeCompare(b.concept.id));

        // Validate each target and build the report.
        const report: string[] = [];
        const conceptsWithIssues: Array<{ bundle: Bundle; concept: Concept; issues: ValidationIssue[] }> = [];
        let totalErrors = 0;
        let totalWarnings = 0;
        for (const { bundle, concept } of targets) {
          const issues = validateConcept(concept);
          const { errors, warnings } = summarize(issues);
          totalErrors += errors;
          totalWarnings += warnings;
          if (issues.length === 0) continue;
          conceptsWithIssues.push({ bundle, concept, issues });
        }

        const validCount = targets.length - conceptsWithIssues.length;
        const bundleLabel = scope.length === 1 ? scope[0]!.name : `${scope.length} bundles`;
        report.push(`Validated ${targets.length} concept(s) in ${bundleLabel}: ${validCount} valid, ${conceptsWithIssues.length} with issues (${totalErrors} error${totalErrors === 1 ? "" : "s"}, ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}).`);

        if (conceptsWithIssues.length === 0) {
          report.push("", "All validated concepts conform to the OKF concept rules. ✓");
          return report.join("\n") + "\n";
        }

        for (const { bundle, concept, issues } of conceptsWithIssues) {
          report.push("", `▶ ${concept.id}  (bundle: ${bundle.name}, ${issues.length} issue${issues.length === 1 ? "" : "s"})`);
          for (const issue of issues) {
            const icon = issue.severity === "error" ? "✗" : "⚠";
            report.push(`  ${icon} [${issue.severity}] ${issue.field}: ${issue.message}`);
            report.push(`    → fix: ${buildFixCommand(bundle.name, concept.id, issue)}`);
          }
        }

        report.push(
          "",
          "Run the suggested okf_write calls to fix. Each uses mode:\"update\" so only the listed field changes.",
          "Issues marked as needing input (type/description/body) require your judgment — replace the <placeholder> with real content.",
        );
        return report.join("\n") + "\n";
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

/**
 * Build a ready-to-run okf_write(...) command string for a validation issue.
 * - Auto-fixable issues are pre-filled with the concrete value (quotes/escapes handled).
 * - Content issues (type/description/body) emit a placeholder for the model/user to fill in.
 * Always uses mode:"update" so only the changed field is written.
 */
function buildFixCommand(bundleName: string, id: string, issue: ValidationIssue): string {
  const head = `okf_write(id: "${id}", bundle: "${bundleName}", mode: "update"`;
  const tail = ")";
  switch (issue.code) {
    case "type-missing":
      return `${head}, type: "<your type, e.g. Metric | BigQuery Table | Runbook>"${tail}`;
    case "type-not-string":
    case "title-missing":
      return `${head}, ${issue.field}: ${formatScalar(issue.suggested)}${tail}`;
    case "frontmatter-missing":
      return `${head}, type: "<your type>"${tail}`;
    case "description-missing":
      return `${head}, description: "<one-line description>"${tail}`;
    case "tags-not-array":
      return `${head}, tags: ${formatArray(issue.suggested)}${tail}`;
    case "body-empty":
      return `${head}, body: "<markdown body>"${tail}`;
    default:
      return `${head}${tail}`;
  }
}

/** Format a scalar value for embedding in an okf_write command (quoted string). */
function formatScalar(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(String(v ?? ""));
  // Use double quotes; escape any embedded double quotes/backslashes.
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Format a string array value for embedding in an okf_write command: ["a", "b"]. */
function formatArray(v: unknown): string {
  const arr = Array.isArray(v) ? v : [v];
  const items = arr.map((x) => formatScalar(x));
  return `[${items.join(", ")}]`;
}

function normalizeDir(p: string | undefined): string {
  if (!p) return ".";
  let n = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return n === "" ? "." : n;
}

function isReservedId(id: string): boolean {
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return base.toLowerCase() === "index" || base.toLowerCase() === "log";
}

/** Where a search match came from: metadata (cheap) vs body (fallback). */
type MatchTier = "metadata" | "body";

/** A single search hit with its tier and a one-line snippet. */
interface SearchHit {
  tier: MatchTier;
  snippet: string;
}

/**
 * Search a concept's METADATA only (title + description + tags).
 * Progressive disclosure prefers this: metadata is small, already parsed, and meant to be
 * surfaced before the (large) body. Returns the matched field as the snippet, or undefined.
 */
function matchMetadata(c: import("./types.js").Concept, q: string): SearchHit | undefined {
  const meta: Array<[string, string]> = [
    ["title", c.title ?? ""],
    ["description", c.description ?? ""],
    ["tags", (c.tags ?? []).join(" ")],
  ];
  for (const [field, value] of meta) {
    const lower = value.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx !== -1) {
      const snippet = value.trim().length > 0 ? `…${value.trim()}…` : "";
      return { tier: "metadata", snippet: `[metadata: ${field}] ${snippet}`.trim() };
    }
  }
  return undefined;
}

/**
 * Search a concept's BODY as a fallback (only when metadata yielded nothing).
 * Returns a one-line snippet around the first match, or undefined.
 */
function matchBody(c: import("./types.js").Concept, q: string): SearchHit | undefined {
  const lower = c.body.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return undefined;
  const lineStart = c.body.lastIndexOf("\n", idx) + 1;
  const lineEnd = c.body.indexOf("\n", idx);
  const snippet = c.body.slice(lineStart, lineEnd === -1 ? lineStart + 120 : lineEnd).trim();
  if (snippet.length === 0) return undefined;
  return { tier: "body", snippet: `[body] …${snippet}…` };
}

/**
 * Render search hits as the tool's text output. Metadata hits are listed first, body hits
 * after. A header notes when a body fallback occurred (full text was scanned).
 */
function formatSearchHits(
  query: string,
  hits: Array<{ bundle: Bundle; concept: Concept; hit: SearchHit }>,
  fellBack: boolean,
  projectDir: string,
): string {
  const lines: string[] = [];
  const scope = `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}"`;
  const note = fellBack ? " (metadata match first; body fallback used for the rest)" : " (metadata match only — body not scanned)";
  lines.push(`${scope}${note}:`, "");
  for (const { bundle, concept, hit } of hits) {
    lines.push(`- [${bundle.name}] ${describeConcept(concept)}  (file: ${relPathFor(concept, projectDir)})  → okf_read(id: "${concept.id}", bundle: "${bundle.name}")`);
    lines.push(`    ${hit.snippet}`);
  }
  return lines.join("\n") + "\n";
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
