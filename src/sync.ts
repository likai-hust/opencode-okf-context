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
import { basename, join } from "node:path";
import { rm, stat } from "node:fs/promises";
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

/** Run one git command; resolves stdout, rejects with the trimmed stderr on failure. */
async function git(args: string[], cwd: string | undefined, opts: GitOpts = {}): Promise<string> {
  const { stdout, stderr } = await exec("git", args, {
    cwd,
    timeout: opts.timeoutMs ?? 60_000,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
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
 */
export async function syncRemote(remote: RemoteSource, mode: SyncMode): Promise<SyncResult> {
  const dir = remoteCacheDir(remote);
  const hasCheckout = await isGitRepo(dir);
  if (hasCheckout && mode === "on-clone") {
    return { remote, dir, status: "cached", message: "cache present, update skipped (on-clone mode)" };
  }

  const ref = remote.ref ?? "HEAD";
  let url: string;
  try {
    url = applyAuth(remote.url, remote.auth, remote.authUser);
  } catch (e) {
    // Bad auth spec / missing token: fall back to the unauthenticated URL only when a
    // cache exists; otherwise this remote is unusable.
    if (hasCheckout) return { remote, dir, status: "cached", message: (e as Error).message };
    return { remote, dir, status: "failed", message: (e as Error).message };
  }

  if (hasCheckout) {
    try {
      const fetchSpec = remote.ref ?? "HEAD";
      await git(["fetch", "--depth", "1", "origin", fetchSpec], dir, { timeoutMs: 60_000 });
      const head = await git(["rev-parse", "--short", "FETCH_HEAD"], dir);
      await git(["reset", "--hard", "FETCH_HEAD"], dir);
      return { remote, dir, status: "synced", message: `updated to ${remote.ref ?? "default branch"} @ ${head}` };
    } catch (e) {
      // Network/lock failure with a usable checkout: degrade to the cached copy.
      // A corrupt cache (reset failed on a healthy fetch) gets one re-clone attempt.
      if (await isGitRepo(dir)) {
        return { remote, dir, status: "cached", message: `update failed, using cache: ${sanitize(e, url, remote.url)}` };
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
    return { remote, dir, status: "cloned", message: `cloned ${remote.ref ?? "default branch"}` };
  } catch (e) {
    await rm(dir, { recursive: true, force: true }); // drop partial clone
    return { remote, dir, status: "failed", message: sanitize(e, url, remote.url) };
  }
}

/**
 * Error messages from git embed the (possibly credential-carrying) URL — e.g.
 * "fatal: unable to access 'https://oauth2:SECRET@host/repo.git'". Replace the
 * authenticated form with the configured one before the message leaves this module.
 */
function sanitize(e: unknown, authedUrl: string, plainUrl: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split(authedUrl).join(plainUrl);
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
    for (const root of roots) {
      const leaf = basename(root);
      entries.push({
        path: root,
        name: roots.length === 1 || root === scanRoot ? base : `${base}/${leaf}`,
        origin: "remote",
      });
    }
  }
  return entries;
}
