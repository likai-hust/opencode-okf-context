#!/usr/bin/env node
/**
 * okf — CLI access to OKF knowledge bundles.
 *
 * Ships inside the opencode-okf-context package as the `okf` bin. It exposes the same
 * operations as the opencode plugin's okf_* tools (shared code: operations.ts) for
 * environments the plugin cannot reach: other agents (via their shell tool), humans,
 * and CI scripts (e.g. `okf validate --all` as a repo gate).
 *
 * Differences from the plugin, by design:
 *  - No unload: rewriting outbound message history is an opencode-runtime capability.
 *    The CLI's context lever is INTAKE control (--fields / --section / --max-chars), and
 *    the read footer explicitly does not mention okf_unload.
 *  - Read-only by default: write/update/delete need --write or write.enabled in .okf.jsonc.
 *
 * Config: <project>/.okf.jsonc (or .okf.json) — same schema as the plugin's okf.jsonc.
 * Exit codes: 0 ok · 1 runtime error (not found, validation errors, write refused) · 2 usage.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverBundles } from "./discovery.js";
import { loadCliConfig, type OkfConfig } from "./config.js";
import { listOp, readOp, searchOp, writeOp, validateOp, refsOp, type OpCtx } from "./operations.js";
import { remoteBundleEntries, syncRemotes, type SyncMode, type SyncResult } from "./sync.js";
import { PLUGIN_VERSION } from "./version.js";
import type { Bundle } from "./types.js";

// ---------- IO + errors ----------

export interface CliIO {
  write(s: string): void;
  err(s: string): void;
}

/** Usage errors exit with code 2; everything else is a runtime error (code 1). */
class UsageError extends Error {}

// ---------- arg parsing ----------

/** Flags that take a value; every other flag is boolean. */
const VALUE_FLAGS = new Set([
  "bundle", "ids", "max", "max-chars", "section",
  "type", "title", "description", "tags", "body", "body-file", "root",
]);

interface Args {
  command?: string;
  pos: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      for (const rest of argv.slice(i + 1)) pos.push(rest);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const v = argv[i + 1];
        if (v === undefined) throw new UsageError(`Missing value for --${name}`);
        flags.set(name, v);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      pos.push(a);
    }
  }
  return { command: pos.shift(), pos, flags };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagNumber(flags: Map<string, string | true>, name: string): number | undefined {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`Expected a non-negative number for --${name}, got "${v}"`);
  return Math.floor(n);
}

// ---------- context loading ----------

async function loadBundles(
  cwd: string,
  cfg: OkfConfig,
  root: string | undefined,
  remoteMode: SyncMode | null,
): Promise<Bundle[]> {
  // --root targets one bundle directly (no scan); otherwise honor remotes + config bundles + scan.
  let remoteEntries: Array<{ path: string; name?: string; origin: "remote" }> = [];
  if (!root && remoteMode !== null && cfg.remotes.length > 0) {
    // CLI default is "on-clone": routine reads stay offline, the first use clones once.
    // `okf sync` (or --sync) forces a full update.
    const results = await syncRemotes(cfg.remotes, remoteMode ?? "on-clone");
    remoteEntries = await remoteBundleEntries(results);
  }
  const configured = root
    ? [{ path: resolve(cwd, root) }]
    : [
        ...remoteEntries,
        ...cfg.bundles.map((b) => ({ path: resolve(cwd, b.path), name: b.name })),
      ];
  return discoverBundles({
    projectRoot: cwd,
    scan: root ? false : cfg.scan.enabled,
    maxDepth: cfg.scan.maxDepth,
    configured,
  });
}

/** Build the CLI OpCtx (syntax "cli") + whether the config file explicitly enables writes. */
async function loadOpCtx(
  cwd: string,
  flags: Map<string, string | true>,
): Promise<OpCtx & { writeExplicitlyEnabled: boolean }> {
  const { cfg, writeExplicitlyEnabled } = await loadCliConfig(cwd);
  // --no-sync: skip remote sync entirely (cache-only). --sync: force update, not just clone.
  const remoteMode: SyncMode | null =
    flags.get("no-sync") === true ? null : flags.get("sync") === true ? "always" : "on-clone";
  const bundles = await loadBundles(cwd, cfg, flagString(flags, "root"), remoteMode);
  if (bundles.length === 0) {
    throw new Error(
      `No OKF bundles found under ${cwd}. Put an OKF bundle (markdown concepts with a \`type\` frontmatter + root index.md) in the project, pass --root <path>, or declare bundles in .okf.jsonc.`,
    );
  }
  return { cfg, bundles, projectDir: cwd, syntax: "cli", writeExplicitlyEnabled };
}

// ---------- commands ----------

async function cmdWrite(
  cmd: "write" | "update" | "delete",
  pos: string[],
  flags: Map<string, string | true>,
  io: CliIO,
  cwd: string,
): Promise<number> {
  const ctx = await loadOpCtx(cwd, flags);
  const id = pos[0];
  if (id === undefined) throw new UsageError(`Pass a concept id: okf ${cmd} <id>`);
  if (flags.get("write") !== true && !ctx.writeExplicitlyEnabled) {
    throw new Error(
      'Write commands are read-only by default. Pass --write, or set { "write": { "enabled": true } } in .okf.jsonc to enable.',
    );
  }
  const writeCtx: OpCtx = { ...ctx, cfg: { ...ctx.cfg, write: { ...ctx.cfg.write, enabled: true } } };

  let body = flagString(flags, "body");
  const bodyFile = flagString(flags, "body-file");
  if (bodyFile !== undefined) {
    body = bodyFile === "-" ? await readStdin() : await readFile(resolve(cwd, bodyFile), "utf8");
  }
  const tagsFlag = flagString(flags, "tags");
  const mode = cmd === "write" ? "create" : cmd === "delete" ? "delete" : "update";

  io.write(
    await writeOp(writeCtx, {
      id,
      type: flagString(flags, "type"),
      title: flagString(flags, "title"),
      description: flagString(flags, "description"),
      tags: tagsFlag !== undefined ? tagsFlag.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      body,
      bundle: flagString(flags, "bundle"),
      mode,
    }),
  );
  return 0;
}

/**
 * The L0 manifest in CLI flavor: same structure as the plugin's renderManifest but with
 * shell-command hints and no okf_unload mentions — meant to be pasted into the rule file
 * (AGENTS.md / CLAUDE.md / system prompt) of a non-opencode agent.
 */
function renderCliManifest(bundles: Bundle[], maxChars: number): string {
  const lines: string[] = [
    "# OKF knowledge base — access via the `okf` CLI",
    "",
    "Whenever you need domain knowledge (a metric, table, term, or runbook), query the",
    "knowledge base with `okf` shell commands instead of guessing or grepping files:",
    "- (reactive) the user asks to understand/explain a concept, metric, or term;",
    "- (proactive) you are about to write code that depends on a domain definition.",
    "",
    "Commands:",
    "- okf search <term>   find concepts by keyword (ids + snippets, never full text)",
    "- okf list            browse a bundle index (titles + descriptions only)",
    "- okf read <id>       load one concept — load less with --fields / --section / --max-chars",
    "- okf refs <id>       who references a concept / what it references",
    "",
    "A loaded concept stays in your context — do not re-read it in later turns.",
    "",
    `Bundle access via opencode-okf-context v${PLUGIN_VERSION}`,
    "",
  ];
  let budget = maxChars - lines.join("\n").length;
  for (const b of bundles) {
    const header = `## ${b.name} (${b.concepts.size} concepts${b.hasLog ? ", has log" : ""})`;
    const hint = `Start: okf list --bundle ${b.name}`;
    const entry = `${header}\n${hint}`;
    if (budget < entry.length + 2) break;
    lines.push(entry, "");
    budget -= entry.length + 2;
  }
  return lines.join("\n").slice(0, maxChars) + "\n";
}

const USAGE = `okf — access OKF knowledge bundles from the command line
(opencode-okf-context v${PLUGIN_VERSION}; the opencode plugin exposes the same operations
as okf_* tools with auto-unload — this CLI serves other agents, humans, and CI)

Usage: okf <command> [args] [flags]

Commands:
  list [path]               Browse a bundle index (titles + descriptions only)
  read <id>                 Load a concept's full markdown
  search <query>            Keyword search (metadata first); returns ids + snippets
  refs <id>                 Reference graph of a concept (incoming + outgoing)
  validate [id] | --all     Validate concepts / the whole bundle (exit 1 on errors)
  write <id> --type T ...   Create a concept (--write required)
  update <id> [...]         Partial update: only passed fields change (--write required)
  delete <id>               Delete a concept (--write required)
  sync                      Update all remotes in .okf.jsonc (exit 1 if any fails)
  manifest                  Print an agent-rule-file manifest (paste into AGENTS.md etc.)
  version                   Print the version
  help                      Show this help

Read intake control (load less into your context):
  --fields                  Metadata only (body not loaded)
  --section <heading>       Only that markdown section of the body
  --max-chars <n>           Truncate the body to n chars
  --ids a,b,c               Read several concepts as one batch

Common flags:
  --bundle <name>           Target a specific bundle
  --root <path>             Use this bundle root directly (skips scanning)
  --max <n>                 search: max results (default 10)
  --write                   Enable write/update/delete (read-only by default)
  --body-file <path|->      write/update: body from a file, or "-" for stdin
  --type/--title/--description/--tags a,b   write/update fields (--tags comma-separated)
  --sync                    Force a git update of remotes (default: clone once, then cache)
  --no-sync                 Skip remote sync entirely, use the local cache as-is

Config: <project>/.okf.jsonc (or .okf.json) — same schema as the plugin's okf.jsonc,
including "remotes" (git-hosted knowledge sources, synced read-only; see okf help sync).
Exit codes: 0 ok · 1 error (not found, validation errors, write refused) · 2 usage.

Examples:
  okf list
  okf search customer churn
  okf read tables/customers --max-chars 2000
  okf read reference/api_schema --section Authentication
  okf update tables/customers --description "New description" --write`;

async function dispatch(args: Args, io: CliIO, cwd: string): Promise<number> {
  const { command, pos, flags } = args;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      io.write(USAGE);
      return 0;

    case "version":
    case "--version":
    case "-v":
      io.write(`okf ${PLUGIN_VERSION} (opencode-okf-context)`);
      return 0;

    case "manifest": {
      const ctx = await loadOpCtx(cwd, flags);
      io.write(renderCliManifest(ctx.bundles, ctx.cfg.disclosure.maxManifestChars));
      return 0;
    }

    case "list": {
      const ctx = await loadOpCtx(cwd, flags);
      io.write(await listOp(ctx, { bundle: flagString(flags, "bundle"), path: pos[0] }));
      return 0;
    }

    case "read": {
      const ctx = await loadOpCtx(cwd, flags);
      const idsFlag = flagString(flags, "ids");
      const id = pos[0];
      if (id !== undefined && idsFlag !== undefined) {
        throw new UsageError("Pass a concept id or --ids, not both.");
      }
      if (id === undefined && idsFlag === undefined) {
        throw new UsageError('Pass a concept id (okf read tables/customers) or --ids "a,b".');
      }
      const ids = idsFlag !== undefined
        ? idsFlag.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      io.write(
        await readOp(
          ctx,
          { id, ids, bundle: flagString(flags, "bundle") },
          {
            footer: "cli",
            fieldsOnly: flags.get("fields") === true,
            section: flagString(flags, "section"),
            maxChars: flagNumber(flags, "max-chars"),
          },
        ),
      );
      return 0;
    }

    case "search": {
      const ctx = await loadOpCtx(cwd, flags);
      const query = pos.join(" ").trim();
      if (!query) throw new UsageError("Pass a search term: okf search <query>");
      io.write(
        await searchOp(ctx, {
          query,
          bundle: flagString(flags, "bundle"),
          maxResults: flagNumber(flags, "max"),
        }),
      );
      return 0;
    }

    case "write":
    case "update":
    case "delete":
      return cmdWrite(command, pos, flags, io, cwd);

    case "validate": {
      const ctx = await loadOpCtx(cwd, flags);
      const all = flags.get("all") === true;
      const id = pos[0];
      if (id === undefined && !all) throw new UsageError("Pass a concept id or --all.");
      const r = await validateOp(ctx, { id, bundle: flagString(flags, "bundle"), all });
      io.write(r.output);
      return r.errors > 0 ? 1 : 0;
    }

    case "sync": {
      const { cfg } = await loadCliConfig(cwd);
      if (cfg.remotes.length === 0) {
        io.write("No remotes configured in .okf.jsonc — nothing to sync.");
        return 0;
      }
      const results: SyncResult[] = [];
      await syncRemotes(cfg.remotes, "always", (r) => results.push(r));
      const entries = await remoteBundleEntries(results);
      for (const r of results) {
        const name = r.remote.name ?? r.remote.url;
        io.write(`${r.status.padEnd(8)} ${name}${r.message ? ` — ${r.message}` : ""}`);
      }
      const bundleNames = entries.map((e) => e.name).filter(Boolean);
      if (bundleNames.length > 0) {
        io.write(`bundles: ${bundleNames.join(", ")}`);
      } else {
        io.write("bundles: (none found in the synced checkouts — is there an OKF bundle inside?)");
      }
      return results.some((r) => r.status === "failed") ? 1 : 0;
    }

    case "refs": {
      const ctx = await loadOpCtx(cwd, flags);
      const id = pos[0];
      if (id === undefined) throw new UsageError("Pass a concept id: okf refs <id>");
      io.write(await refsOp(ctx, { id, bundle: flagString(flags, "bundle") }));
      return 0;
    }

    default:
      throw new UsageError(`Unknown command: ${command ?? "(none)"}`);
  }
}

/**
 * Entry point for tests and embedding: run one command, write output via `io`,
 * return the process exit code (0 ok · 1 error · 2 usage).
 */
export async function runCli(argv: string[], io: CliIO, cwd: string = process.cwd()): Promise<number> {
  try {
    return await dispatch(parseArgs(argv), io, cwd);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`okf: ${e.message}`);
      io.err("Run 'okf help' for usage.");
      return 2;
    }
    io.err(`okf: ${(e as Error).message}`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString("utf8");
}

// Run as a script (node dist/cli.js / bun src/cli.ts), not when imported by tests.
const isMain = (() => {
  const argv1 = process.argv[1];
  return !!argv1 && import.meta.url === pathToFileURL(argv1).href;
})();

if (isMain) {
  const code = await runCli(process.argv.slice(2), {
    write: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
  });
  process.exitCode = code;
}
