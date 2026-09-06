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
 * This file is a thin `tool()` wrapper layer: the business logic lives in operations.ts,
 * shared with the `okf` CLI. Tool descriptions and rendered output are a wording contract
 * (tests/prompt-trigger.test.ts) — the plugin path always runs with syntax:"tool" and
 * footer:"plugin", which are byte-identical to the pre-extraction output.
 *
 * Tools return strings (opencode renders tool output as text). okf_read output is what the
 * messages-transform layer later replaces with placeholders — it is the only output we track.
 */
import { tool } from "@opencode-ai/plugin";
import {
  listOp,
  readOp,
  searchOp,
  writeOp,
  validateOp,
  refsOp,
  type OpCtx,
} from "./operations.js";
import { state } from "./state.js";
import { conceptKey } from "./registry.js";
import { normalizeId, resolveConcept } from "./registry.js";
import type { OkfConfig } from "./config.js";
import type { Bundle } from "./types.js";

/** Helper: ensure bundles are loaded; returns them or throws a friendly message. */
async function requireBundles(): Promise<Bundle[]> {
  const bundles = await state.ensureLoaded();
  if (bundles.length === 0) {
    throw new Error("No OKF bundles found. Put markdown files with YAML frontmatter (type: ...) in your project, or configure bundles in .opencode/okf.jsonc.");
  }
  return bundles;
}

export function buildTools(cfg: OkfConfig) {
  /** Plugin execution context: tool syntax + plugin footer (byte-identical output). */
  async function opCtx(directory: string): Promise<OpCtx> {
    return { cfg, bundles: await requireBundles(), projectDir: directory, syntax: "tool" };
  }

  return {
    okf_list: tool({
      description:
        "List the index of an OKF knowledge bundle (or a sub-directory). Returns concept titles + descriptions only (progressive disclosure), never full documents. Use this before okf_read to discover what's available. Args: bundle (name; omit to list all available bundles), path (sub-directory relative to bundle root; default root).",
      args: {
        bundle: tool.schema.string().optional().describe("Bundle name. Omit to list all available bundles."),
        path: tool.schema.string().optional().describe('Sub-directory path (e.g. "tables"). Default: root.'),
      },
      async execute(args, context) {
        return listOp(await opCtx(context.directory), args);
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
        return readOp(await opCtx(context.directory), args, { footer: "plugin" });
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
        return searchOp(await opCtx(context.directory), args);
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
      async execute(args, context) {
        return writeOp(await opCtx(context.directory), args, () => state.markStale());
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
      async execute(args, context) {
        const result = await validateOp(await opCtx(context.directory), args);
        return result.output;
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
      async execute(args, context) {
        return refsOp(await opCtx(context.directory), args);
      },
    }),
  };
}

// Re-export splitFrontmatter for tooling that wants to reparse after writes.
export { splitFrontmatter } from "./frontmatter.js";
