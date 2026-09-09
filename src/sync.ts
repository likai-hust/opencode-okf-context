/**
 * Remote knowledge sources: sync git-hosted OKF bundles into a shared local cache.
 *
 * A `remotes` entry in okf.jsonc points at a git repository (the source of truth for a
 * team knowledge base). Before discovery, the plugin clones/updates it into
 *   <cacheRoot>/<hash(url + ref)>/
 * and injects the bundle roots found inside as configured bundles (origin "remote").
 *
 * Design constraints:
 *  - ZERO network failure modes are fatal: on any git error the sync degrades to the
 *    existing cache (status "cached") or skips the remote entirely (status "failed")
 *    with a stderr warning — the plugin must never fail to load because a git server
 *    is unreachable (intranets flake).
 *  - The cache is SHARED across projects (keyed by url+ref only), like a package
 *    manager cache. Concurrent `git fetch` from two sessions can lose the .git lock
 *    race; that is handled by the same degrade-to-cache path.
 *  - `git reset --hard` is only safe because remote bundles are write-protected
 *    (okf_write refuses origin "remote") — no local edits exist to be clobbered.
 *  - No external deps: git is invoked as a subprocess via node:child_process.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { findBundleRoots } from "./discovery.js";
import type { RemoteSource } from "./config.js";

const exec = promisify(execFile);

/** When to talk to the network for a remote. */
export type SyncMode = "always" | "on-clone";

export type SyncStatus = "cloned" | "synced" | "cached" | "failed";

export interface SyncResult {
  remote: RemoteSource;
  /** Absolute cache directory for this remote (valid unless status is "failed"). */
  dir: string;
  status: SyncStatus;
  /** Human-readable detail (failure reason / commit pulled), never sensitive. */
  message?: string;
}

/** Root directory holding all remote caches. Override via $OKF_REMOTE_CACHE (tests, sandboxes). */
export function remoteCacheRoot(): string {
  return process.env.OKF_REMOTE_CACHE ?? join(homedir(), ".cache", "opencode-okf", "remotes");
}

// ---------- sync log ----------
//
// Every sync writes human-readable lines to <cacheRoot>/sync.log (override:
// $OKF_SYNC_LOG) so "did it actually update?" is answerable after the fact. The
// log is unconditional — it costs nothing and is the only record of successful
// syncs, which are silent on stderr. PRIVACY: lines never contain the remote URL
// (ssh URLs embed user@host); they carry the display name, ref, and the cache-dir
// hash instead. Messages are already token-sanitized by sanitize().

/** Local time, second precision + millis: "2026-09-09 14:03:11.482". */
function formatTs(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function syncLogPath(): string {
  return process.env.OKF_SYNC_LOG ?? join(remoteCacheRoot(), "sync.log");
}

/** Log rotates at this size, keeping roughly the tail below. */
const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;

let debugMirror = false;

/**
 * When debug is on, mirror every log line to stderr as well (the plugin passes
 * cfg.debug). Off by default: stderr keeps its historical contract (only
 * degrade/fail warnings, printed by the plugin entry).
 */
export function setSyncDebug(on: boolean): void {
  debugMirror = on;
}

type LogLevel = "INFO" | "WARN" | "ERROR";

/** Append one line to sync.log. Best-effort: logging must never break a sync. */
async function appendSyncLog(level: LogLevel, msg: string): Promise<void> {
  const line = `${formatTs(new Date())} ${level.padEnd(5)} ${msg}`;
  if (debugMirror) {
    // eslint-disable-next-line no-console
    console.error(`[opencode-okf] ${line}`);
  }
  try {
    const p = syncLogPath();
    await mkdir(dirname(p), { recursive: true });
    let content = "";
    try {
      content = await readFile(p, "utf8");
    } catch {
      /* first line ever */
    }
    if (Buffer.byteLength(content) > LOG_MAX_BYTES) {
      const tail = content.slice(-LOG_KEEP_BYTES);
      const nl = tail.indexOf("\n");
      content = nl === -1 ? "" : tail.slice(nl + 1);
    }
    await writeFile(p, content + line + "\n", "utf8");
  } catch {
    /* unwritable cache dir: sync still proceeds */
  }
}

/** Stable per-remote cache dir: hash of url+ref, so the same remote is shared across projects. */
export function remoteCacheDir(remote: RemoteSource): string {
  const h = createHash("sha256").update(`${remote.url}\0${remote.ref ?? ""}`).digest("hex").slice(0, 16);
  return join(remoteCacheRoot(), h);
}

/** Derive a short display name from the git URL (repo basename minus .git). */
export function remoteNameFromUrl(url: string): string {
  const tail = url.replace(/\/+$/, "").split("/").pop() ?? url;
  return tail.replace(/\.git$/i, "") || url;
}

/**
 * Inject credentials into an https URL. `auth` must be "env:VARNAME"; the token is read
 * from the environment at sync time so secrets never live in okf.jsonc (which is usually
 * committed). Only https URLs are rewritten; ssh URLs rely on the user's ssh agent.
 */
export function applyAuth(url: string, auth: string | undefined, authUser = "oauth2"): string {
  if (!auth) return url;
  // ssh / file URLs rely on the ssh agent or plain local paths — no token injection.
  if (!/^https:\/\//i.test(url)) return url;
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(auth);
  if (!m) {
    throw new Error(`Unsupported auth spec "${auth}" — use "env:VARNAME" (an environment variable holding the token).`);
  }
  const token = process.env[m[1]!];
  if (!token) {
    throw new Error(`Environment variable ${m[1]} (auth token) is not set.`);
  }
  return url.replace(/^https:\/\//i, `https://${encodeURIComponent(authUser)}:${encodeURIComponent(token)}@`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface GitOpts {
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Extra env for every git subprocess: sync runs inside the agent's startup path, so a
 * git that waits for input is a hung session. BatchMode fails password/passphrase
 * prompts immediately, ConnectTimeout bounds silently-dropping routes, and
 * GIT_TERMINAL_PROMPT=0 does the same for https credential prompts.
 */
export function gitEnv(): Record<string, string> {
  return {
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Run one git command; resolves stdout, rejects with the trimmed stderr on failure. */
async function git(args: string[], cwd: string | undefined, opts: GitOpts = {}): Promise<string> {
  const { stdout, stderr } = await exec("git", args, {
    cwd,
    timeout: opts.timeoutMs ?? 60_000,
    env: { ...process.env, ...gitEnv(), ...(opts.env ?? {}) },
    maxBuffer: 16 * 1024 * 1024,
  });
  return (stdout || stderr).toString().trim();
}

/** Whether `dir` holds a git checkout (vs empty/absent/partially-written). */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync one remote into its cache dir. Never throws — failures are reported via the
 * returned status:
 *  - "cloned": fresh clone succeeded
 *  - "synced": fetch + reset --hard succeeded (cache updated to origin/<ref>)
 *  - "cached": update failed but a usable checkout already exists (offline degrade)
 *  - "failed": no usable local copy (first clone failed / cache unusable)
 *
 * Every invocation logs a `start` and a result line to sync.log (no URL — the
 * display name + cache-dir hash identify the remote).
 */
export async function syncRemote(remote: RemoteSource, mode: SyncMode): Promise<SyncResult> {
  const dir = remoteCacheDir(remote);
  const name = remote.name ?? remoteNameFromUrl(remote.url);
  const t0 = Date.now();
  const cacheTag = `name=${name}${remote.ref ? ` ref=${remote.ref}` : ""} cache=${basename(dir)}`;
  await appendSyncLog("INFO", `start ${cacheTag} mode=${mode}`);

  const finish = async (level: LogLevel, status: SyncStatus, message?: string): Promise<SyncResult> => {
    const ms = Date.now() - t0;
    await appendSyncLog(level, `sync ${cacheTag} status=${status} ${ms}ms${message ? ` "${message}"` : ""}`);
    return { remote, dir, status, message };
  };

  const hasCheckout = await isGitRepo(dir);
  if (hasCheckout && mode === "on-clone") {
    return finish("INFO", "cached", "cache present, update skipped (on-clone mode)");
  }

  const ref = remote.ref ?? "HEAD";
  let url: string;
  try {
    url = applyAuth(remote.url, remote.auth, remote.authUser);
  } catch (e) {
    // Bad auth spec / missing token: fall back to the unauthenticated URL only when a
    // cache exists; otherwise this remote is unusable.
    if (hasCheckout) return finish("WARN", "cached", (e as Error).message);
    return finish("ERROR", "failed", (e as Error).message);
  }

  if (hasCheckout) {
    try {
      const fetchSpec = remote.ref ?? "HEAD";
      await git(["fetch", "--depth", "1", "origin", fetchSpec], dir, { timeoutMs: 60_000 });
      const head = await git(["rev-parse", "--short", "FETCH_HEAD"], dir);
      await git(["reset", "--hard", "FETCH_HEAD"], dir);
      return finish("INFO", "synced", `updated to ${remote.ref ?? "default branch"} @ ${head}`);
    } catch (e) {
      // Network/lock failure with a usable checkout: degrade to the cached copy.
      // A corrupt cache (reset failed on a healthy fetch) gets one re-clone attempt.
      if (await isGitRepo(dir)) {
        return finish("WARN", "cached", `update failed, using cache: ${sanitize(e, url, remote.url, name)}`);
      }
    }
  }

  // Fresh clone (no cache, or the cache turned out unusable).
  await rm(dir, { recursive: true, force: true });
  const cloneArgs = ["clone", "--depth", "1", "--quiet"];
  if (remote.ref) cloneArgs.push("--branch", remote.ref);
  cloneArgs.push(url, dir);
  try {
    await git(cloneArgs, undefined, { timeoutMs: 120_000 });
    return finish("INFO", "cloned", `cloned ${remote.ref ?? "default branch"}`);
  } catch (e) {
    await rm(dir, { recursive: true, force: true }); // drop partial clone
    return finish("ERROR", "failed", sanitize(e, url, remote.url, name));
  }
}

/**
 * Error messages from git embed the URL it tried — e.g. "unable to access
 * 'https://oauth2:SECRET@host/repo.git'" or, for ssh, "git@intranet-host:team/repo"
 * (and git often strips the scheme before echoing the path). Both the credential-
 * carrying and the plain form are replaced with the remote's display name — with and
 * without their scheme — so no URL/host/user ever reaches sync.log, stderr, or output.
 */
function sanitize(e: unknown, authedUrl: string, plainUrl: string, label: string): string {
  let msg = e instanceof Error ? e.message : String(e);
  const variants = new Set<string>();
  for (const u of [authedUrl, plainUrl]) {
    variants.add(u);
    variants.add(u.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""));
  }
  for (const v of variants) {
    if (v) msg = msg.split(v).join(label);
  }
  return msg;
}

/**
 * Sync all remotes sequentially (they share a cache root; sequential keeps failure
 * reporting simple and avoids hammering one git server). Each remote degrades
 * independently — one bad URL never blocks the others.
 */
export async function syncRemotes(
  remotes: RemoteSource[],
  mode: SyncMode,
  onResult?: (r: SyncResult) => void,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const remote of remotes) {
    if (remote.autoSync === false) {
      const dir = remoteCacheDir(remote);
      if (await isGitRepo(dir)) {
        const name = remote.name ?? remoteNameFromUrl(remote.url);
        await appendSyncLog("INFO", `sync name=${name} cache=${basename(dir)} status=cached 0ms "autoSync disabled"`);
        const r = { remote, dir, status: "cached" as const, message: "autoSync disabled" };
        results.push(r);
        onResult?.(r);
      }
      continue;
    }
    const r = await syncRemote(remote, mode);
    results.push(r);
    onResult?.(r);
  }
  return results;
}

/** Stderr warning line for a degraded/failed remote (the plugin's only sync surface). */
export function syncWarnLine(r: SyncResult): string {
  const name = r.remote.name ?? remoteNameFromUrl(r.remote.url);
  return `[opencode-okf] remote "${name}": ${r.status}${r.message ? ` — ${r.message}` : ""}`;
}

/**
 * Turn successful sync results into discoverable bundle entries: for each usable cache,
 * locate bundle roots inside it (whole checkout, or `subdir` when configured) using the
 * same heuristic as the project auto-scan.
 *
 * Naming: a repo hosting exactly ONE bundle gets the configured name as-is (the common
 * case — "team-kb" is what the user wrote). A multi-bundle repo prefixes the leaf
 * directory to disambiguate (`team-kb/tables`, `team-kb/runbooks`).
 */
export async function remoteBundleEntries(
  results: SyncResult[],
): Promise<Array<{ path: string; name?: string; origin: "remote" }>> {
  const entries: Array<{ path: string; name?: string; origin: "remote" }> = [];
  for (const r of results) {
    if (r.status === "failed") continue;
    const scanRoot = r.remote.subdir ? join(r.dir, r.remote.subdir) : r.dir;
    const roots = await findBundleRoots(scanRoot, 6);
    const base = r.remote.name ?? remoteNameFromUrl(r.remote.url);
    const names = roots.map((root) =>
      roots.length === 1 || root === scanRoot ? base : `${base}/${basename(root)}`,
    );
    if (names.length > 0) {
      await appendSyncLog("INFO", `bundles name=${base} count=${names.length} registered=${names.join(",")}`);
    } else {
      await appendSyncLog("WARN", `bundles name=${base} count=0 (no OKF bundle roots found in the checkout)`);
    }
    for (const [i, root] of roots.entries()) {
      entries.push({ path: root, name: names[i], origin: "remote" });
    }
  }
  return entries;
}
