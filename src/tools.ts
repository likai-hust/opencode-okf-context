/**
 * The seven custom tools registered by the plugin:
 *   okf_list    — browse a bundle / directory index (L1 progressive disclosure)
 *   okf_read    — load a full concept (L2); footer nudges the model to unload when done
 *   okf_search  — keyword search across titles/descriptions/tags/body; returns snippets, not full docs
 *   okf_write   — create/update a concept (partial update supported); updates parent index.md and prepends to log.md
 *   okf_validate— read-only concept validation; emits okf_write fix commands for issues found
 *   okf_unload  — explicitly unload one or all loaded concepts; reports chars freed
 *   okf_refs    — query a concept's reference graph (incoming + outgoing), metadata only; no body loaded
 *
 * Tools return strings (opencode renders tool output as text). okf_read output is what the
 * messages-transform layer later replaces with placeholders — it is the only output we track.
 */
import { readFile } from "node:fs/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import {
  validateConcept,
  summarize,
  extractLinks,
  validateBundleIndex,
  validateBundleLog,
  bundleIssueFix,
  type ValidationIssue,
} from "./validate.js";
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

/**
 * Build a reverse link index by scanning every concept's body in a bundle.
 * Returns Map<targetId, sourceId[]> — for each concept, the ids of concepts that link TO it.
 *
 * Real-time scan over the in-memory `bundle.concepts` map (bodies are already loaded at
 * discovery time), so this is zero extra I/O — same cost class as okf_search's body scan.
 * Not cached: always reflects the current on-disk state, so a freshly written concept is
 * visible immediately without any cache-invalidation bookkeeping.
 *
 * The index is intentionally complete (no `type` guard): it records the raw "who links to
 * whom" fact. The presentation layer (readReferences / okf_refs) applies the scheme-B
 * filter (source must have `type`) when rendering, keeping this index reusable + testable.
 */
function buildBacklinkIndex(bundle: Bundle): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const source of bundle.concepts.values()) {
    for (const link of extractLinks(source.body, source.id)) {
      const targetId = link.replace(/\.md$/i, "");
      if (!bundle.concepts.has(targetId)) continue; // unresolved link — skip
      let arr = index.get(targetId);
      if (!arr) {
        arr = [];
        index.set(targetId, arr);
      }
      if (!arr.includes(source.id)) arr.push(source.id); // dedup sources
    }
  }
  return index;
}

/**
 * Collect the OUTGOING concept links of `c` that qualify for display: the target must
 * resolve to a concept in its bundle AND have a `type` (scheme B — plain .md docs without
 * `type` are not knowledge concepts and are skipped). Returns concept refs in first-seen
 * order, deduped by id.
 */
function outgoingRefs(c: Concept, bundle: Bundle): Concept[] {
  const links = extractLinks(c.body, c.id);
  const seen = new Set<string>();
  const out: Concept[] = [];
  for (const link of links) {
    const id = link.replace(/\.md$/i, "");
    if (seen.has(id)) continue;
    seen.add(id);
    const target = bundle.concepts.get(id);
    if (!target) continue; // unresolved — okf_validate reports broken links
    if (!target.type) continue; // scheme B: skip plain MD docs without `type`
    out.push(target);
  }
  return out;
}

/**
 * Collect the INCOMING concept refs for `c` (who links to it), using a precomputed
 * backlink index. Scheme B: a source is listed only if it has a `type` (plain MD docs that
 * happen to link here are not knowledge concepts). Returns sources in first-seen order.
 */
function incomingRefs(c: Concept, bundle: Bundle, backlinks: Map<string, string[]>): Concept[] {
  const sourceIds = backlinks.get(c.id) ?? [];
  const out: Concept[] = [];
  for (const sid of sourceIds) {
    const source = bundle.concepts.get(sid);
    if (!source) continue;
    if (!source.type) continue; // scheme B: skip plain MD sources
    out.push(source);
  }
  return out;
}

/** Render one neighbor row: metadata + a ready-to-run okf_read reload command. */
function refsRow(target: Concept, bundleName: string): string {
  return `  - ${describeConcept(target)}  → okf_read(id: "${target.id}", bundle: "${bundleName}")`;
}

/**
 * Build the references annotation appended to okf_read output: BOTH outgoing (this concept
 * links to) and incoming (referenced by) neighbors, metadata only. Scheme B applies to the
 * listed neighbors (must have `type`). Returns "" when neither side has any qualifying ref
 * (so no empty annotation is appended for link-less / plain-doc-only concepts).
 *
 * `bundles` is the full bundle list because incoming refs may come from other concepts in
 * the same bundle; the concept's own bundle is located by identity.
 */
function readReferences(c: Concept, bundles: Bundle[]): string {
  const bundle = bundles.find((b) => b.concepts.has(c.id)) ?? bundles[0];
  if (!bundle) return "";
  const bundleName = bundle.name;

  const out = outgoingRefs(c, bundle);
  const backlinks = buildBacklinkIndex(bundle);
  const inc = incomingRefs(c, bundle, backlinks);

  if (out.length === 0 && inc.length === 0) return "";

  const sections: string[] = [];
  if (out.length > 0) {
    const label = out.length === 1 ? "Outgoing references (this concept links to):" : `Outgoing references (this concept links to ${out.length}):`;
    sections.push(`${label}\n${out.map((t) => refsRow(t, bundleName)).join("\n")}`);
  }
  if (inc.length > 0) {
    const label = inc.length === 1 ? "Incoming references (referenced by 1 concept):" : `Incoming references (referenced by ${inc.length} concepts):`;
    sections.push(`${label}\n${inc.map((t) => refsRow(t, bundleName)).join("\n")}`);
  }
  return `\n\n---\n${sections.join("\n\n")}`;
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
        'Load the FULL markdown of one or more OKF concepts into context. Only load what you actually need — loaded concepts occupy context until auto-unloaded (after a few turns) or until you call okf_unload. Pass id for a single concept, or ids (array) to load several at once (outputs are separated and the batch is tracked as a whole for unloading). Args: id (concept path, e.g. "tables/customers"), or ids ([...]), bundle (name; omit if only one). Provide exactly one of id / ids.',
      args: {
        id: tool.schema.string().optional().describe('Concept id, e.g. "tables/customers" (no leading slash, no .md). Mutually exclusive with ids.'),
        ids: tool.schema.array(tool.schema.string()).optional().describe('Array of concept ids, e.g. ["tables/customers", "metrics/active_customers"]. Mutually exclusive with id.'),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
      },
      async execute(args, context) {
        const bundles = await requireBundles();

        if (args.id !== undefined && args.ids !== undefined) {
          throw new Error('Pass either id or ids, not both.');
        }
        if (args.id === undefined && args.ids === undefined) {
          throw new Error('Pass id (one concept) or ids (an array of concepts).');
        }

        if (args.ids !== undefined) {
          if (args.ids.length === 0) throw new Error("ids must not be empty.");
          const resolved: Array<{ bundle: Bundle; concept: Concept }> = [];
          const missing: string[] = [];
          for (const rawId of args.ids) {
            const found = resolveConcept(bundles, rawId, args.bundle);
            if (found) resolved.push(found);
            else missing.push(normalizeId(rawId));
          }
          if (missing.length > 0) {
            throw new Error(`Concept(s) not found: ${missing.join(", ")}${args.bundle ? ` in bundle ${args.bundle}` : ""}. Use okf_list to browse the index.`);
          }
          const parts = resolved.map(({ bundle, concept }) => {
            const body = renderConceptFull(concept);
            return readHeader(concept, context.directory) + body;
          });
          // One footer for the whole batch; unload treats the batch as a single unit.
          // References annotation follows the last concept (same as the footer) so the batch
          // reads as one contiguous block.
          const last = resolved[resolved.length - 1]!;
          const refs = readReferences(last.concept, bundles);
          return parts.join("\n---\n") + refs + readFooter(last.concept, last.bundle.name);
        }

        const found = resolveConcept(bundles, args.id!, args.bundle);
        if (!found) {
          const id = normalizeId(args.id!);
          throw new Error(`Concept not found: ${id}${args.bundle ? ` in bundle ${args.bundle}` : ""}. Use okf_list to browse the index.`);
        }
        const { bundle, concept } = found;
        const body = renderConceptFull(concept);
        const refs = readReferences(concept, bundles);
        return readHeader(concept, context.directory) + body + refs + readFooter(concept, bundle.name);
      },
    }),

    okf_search: tool({
      description:
        'THE entry point when you hear a term and want to find what the knowledge base says about it — e.g. the user says "我想了解 customer churn", or you hit "active_customers" in code and aren\'t sure what it means. Keyword search across OKF concepts: metadata first (title/description/tags), body only as fallback. Returns path + snippet per hit, NOT full text — call okf_read on a matched id to load it. Args: query, bundle?(omit to search all), maxResults?(default 10).',
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
        'Create, update, or delete an OKF concept document. Writes YAML frontmatter + body to <bundle>/<id>.md, updates the parent directory index.md entry, and prepends a log.md entry under today\'s date. In "update" mode (default), only the fields you pass are changed — others are read from disk and preserved, so you can fix a single field without restating the whole document. In "create" mode all provided fields are written fresh. In "delete" mode the concept file is removed, its index.md entry is dropped, and log.md records the deletion. Args: id, type? (required in create; optional in update), title?, description?, tags?, body? (required in create; optional in update), bundle?, mode ("create"|"update"|"delete", default update).',
      args: {
        id: tool.schema.string().describe('Concept id, e.g. "tables/new_table" (no leading slash, no .md).'),
        type: tool.schema.string().optional().describe('Concept type, e.g. "BigQuery Table", "Metric". Required when creating; optional when updating (omitted = keep current).'),
        title: tool.schema.string().optional().describe("Display title. Defaults to the id. Omit in update to keep current."),
        description: tool.schema.string().optional().describe("One-line description (used in indexes & placeholders). Omit in update to keep current."),
        tags: tool.schema.array(tool.schema.string()).optional().describe("Tags. Omit in update to keep current."),
        body: tool.schema.string().optional().describe("Markdown body of the concept. Required when creating; optional when updating (omitted = keep current)."),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
        mode: tool.schema.enum(["create", "update", "delete"]).optional().describe('"create" fails if it exists; "update" (default) merges: only passed fields change, others are preserved from disk; "delete" removes the concept file, its index.md entry, and logs the deletion.'),
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

        // --- Delete mode: remove file + index.md entry + log entry, refresh cache. ---
        if (mode === "delete") {
          if (!existed) {
            const onDisk = await readFile(absPath, "utf8").catch(() => null);
            existed = onDisk !== null;
          }
          if (!existed) {
            throw new Error(`Concept not found: ${id} (nothing to delete).`);
          }
          await rm(absPath, { force: true });
          bundle.concepts.delete(id);
          state.markStale();

          const sideEffects: string[] = [];
          if (cfg.write.updateIndex) {
            try {
              await removeFromIndex(bundle, id);
              sideEffects.push("parent index.md entry removed");
            } catch {
              /* best-effort */
            }
          }
          if (cfg.write.appendLog) {
            try {
              await appendLog(bundle, `Deleted concept ${id}.`);
              sideEffects.push("log.md appended");
            } catch {
              /* best-effort */
            }
          }
          return `Deleted concept ${id} from bundle ${bundle.name}.\n${sideEffects.join("; ")}.\nFile removed: ${absPath}`;
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
        'Read-only validation of OKF documents against concept-level rules (type required; type/title/description/tags well-formed; body non-empty) and, in all:true mode, bundle-level rules (root index.md okf_version, log.md presence, broken cross-links). Does NOT write files. Returns a report listing issues, each with a ready-to-run okf_write(...) fix command (auto-fixable issues are pre-filled; content issues show a placeholder). To actually fix an issue, call okf_write with mode:"update" passing only the changed field(s). Args: id (validate one concept), or bundle/all (validate a whole bundle, incl. bundle-level checks). At least one of id / all must be given.',
      args: {
        id: tool.schema.string().optional().describe('Concept id to validate, e.g. "tables/customers".'),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
        all: tool.schema.boolean().optional().describe("Validate every concept in the bundle AND the bundle itself (ignored if id is given)."),
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

        // Bundle-level checks only in all:true mode (needs the full bundle context).
        const bundleIssues: Array<{ bundle: Bundle; issues: ValidationIssue[] }> = [];
        if (args.all) {
          for (const b of scope) {
            const issues: ValidationIssue[] = [];
            // okf_version: read root index.md frontmatter.
            try {
              const idxRaw = await readFile(join(b.root, "index.md"), "utf8");
              const { frontmatter } = splitFrontmatter(idxRaw);
              const idxIssue = validateBundleIndex(frontmatter);
              if (idxIssue) issues.push(idxIssue);
            } catch {
              // No root index.md at all: report okf_version missing (bundle not markable).
              const idxIssue = validateBundleIndex({});
              if (idxIssue) issues.push(idxIssue);
            }
            const logIssue = validateBundleLog(b.hasLog);
            if (logIssue) issues.push(logIssue);
            // Broken cross-links: check each concept's markdown links against the bundle.
            for (const c of b.concepts.values()) {
              const broken = checkBrokenLinks(b, c);
              issues.push(...broken);
            }
            const { errors, warnings } = summarize(issues);
            totalErrors += errors;
            totalWarnings += warnings;
            if (issues.length > 0) bundleIssues.push({ bundle: b, issues });
          }
        }

        if (conceptsWithIssues.length === 0 && bundleIssues.length === 0) {
          report.push(
            "",
            args.all
              ? "All validated concepts and bundles conform to the OKF rules. ✓"
              : "All validated concepts conform to the OKF concept rules. ✓",
          );
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

        for (const { bundle, issues } of bundleIssues) {
          report.push("", `▶ bundle "${bundle.name}"  (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
          for (const issue of issues) {
            const icon = issue.severity === "error" ? "✗" : "⚠";
            report.push(`  ${icon} [${issue.severity}] ${issue.field}: ${issue.message}`);
            const fix = bundleIssueFix(bundle.name, issue, bundle.root);
            if (fix) report.push(`    → fix: ${fix}`);
          }
        }

        report.push(
          "",
          "Concept-level fixes: run the suggested okf_write(id, mode:\"update\", <field>) calls — only the listed field changes.",
          "Bundle-level fixes (okf_version, log.md): edit the bundle's index.md / create log.md directly — these are reserved files okf_write cannot touch.",
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

    okf_refs: tool({
      description:
        'Query the reference graph of a concept WITHOUT loading its full text — returns the incoming (who links to it) and outgoing (what it links to) neighbors, metadata only (title/type/description). Use for impact analysis ("what breaks if I change X?", "who depends on this table?") and discovering hub concepts. Never returns bodies; call okf_read on a neighbor id to load it. Args: id (concept path), bundle (name; omit if only one).',
      args: {
        id: tool.schema.string().describe('Concept id, e.g. "tables/orders".'),
        bundle: tool.schema.string().optional().describe("Bundle name. Omit when only one bundle exists."),
      },
      async execute(args) {
        const bundles = await requireBundles();
        const found = resolveConcept(bundles, args.id, args.bundle);
        if (!found) {
          const id = normalizeId(args.id);
          throw new Error(`Concept not found: ${id}${args.bundle ? ` in bundle ${args.bundle}` : ""}. Use okf_list to browse available concepts.`);
        }
        const { bundle, concept } = found;

        const out = outgoingRefs(concept, bundle);
        const backlinks = buildBacklinkIndex(bundle);
        const inc = incomingRefs(concept, bundle, backlinks);

        const lines: string[] = [];
        lines.push(`Reference graph for ${concept.id}${concept.type ? ` [${concept.type}]` : ""}${concept.description ? ` — ${concept.description}` : ""}.`);
        lines.push("");

        if (out.length === 0 && inc.length === 0) {
          lines.push("No references: this concept links to nothing, and nothing links to it.");
          return lines.join("\n") + "\n";
        }

        if (out.length > 0) {
          const label = out.length === 1 ? "Outgoing (links to 1 concept):" : `Outgoing (links to ${out.length} concepts):`;
          lines.push(label);
          for (const t of out) lines.push(refsRow(t, bundle.name));
          lines.push("");
        }
        if (inc.length > 0) {
          const label = inc.length === 1 ? "Incoming (referenced by 1 concept):" : `Incoming (referenced by ${inc.length} concepts):`;
          lines.push(label);
          for (const t of inc) lines.push(refsRow(t, bundle.name));
          lines.push("");
        }
        lines.push("(Use okf_read to load any neighbor's full text.)");
        return lines.join("\n") + "\n";
      },
    }),
  };
}

// ---------- helpers ----------

/**
 * Check a concept's markdown cross-links against the bundle: every link target (after
 * normalization to a bundle-relative path) must resolve to an existing concept file or a
 * reserved file (index.md / log.md). Returns one link-broken issue per dangling link.
 */
function checkBrokenLinks(bundle: Bundle, c: Concept): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const link of extractLinks(c.body, c.id)) {
    const normalized = link.replace(/\.md$/i, "") || link;
    const exists = bundle.concepts.has(normalized) || link.toLowerCase().endsWith("index.md") || link.toLowerCase().endsWith("log.md");
    if (!exists) {
      out.push({
        severity: "warning",
        field: "body",
        code: "link-broken",
        message: `Cross-link "${link}" does not resolve to any concept in this bundle.`,
        autoFixable: false,
      });
    }
  }
  return out;
}

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

/**
 * Remove the index.md entry linking to a concept (inverse of updateParentIndex).
 * Deletes any list line that links to `<basename>.md`; drops the file if it becomes empty.
 */
async function removeFromIndex(
  bundle: import("./types.js").Bundle,
  id: string,
): Promise<void> {
  const dirRel = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : ".";
  const indexAbs = join(bundle.root, dirRel, "index.md");
  const existing = await readFile(indexAbs, "utf8").catch(() => null);
  if (existing === null) return; // nothing to clean up

  const link = `${id.slice(id.lastIndexOf("/") + 1)}.md`;
  // Match both plugin-authored entries ("./a.md") and hand-written relative links
  // ("tables/a.md", "a.md", "./tables/a.md") that resolve to this concept.
  const linkRe = new RegExp(`^.*\\]\\((?:[^)\\s]*/)?\\.?/?${escapeRegExp(link)}\\).*$`, "m");
  const updated = existing
    .split("\n")
    .filter((line) => !linkRe.test(line))
    .join("\n");

  // Drop the whole file if nothing (but whitespace) remains.
  if (updated.trim().length === 0) {
    await rm(indexAbs, { force: true });
    bundle.indexDirs.delete(dirRel);
    return;
  }
  await writeFile(indexAbs, updated, "utf8");
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
