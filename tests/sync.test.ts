/**
 * Remote knowledge source tests: a real local git repo (file:// URL) acts as the
 * "intranet" origin. Covers the sync lifecycle (clone → fetch+reset → offline degrade
 * → hard failure), bundle discovery from a synced checkout, the remote write guard,
 * auth URL injection, and the `okf sync` / implicit on-clone CLI paths.
 *
 * The shared cache is pointed at a per-suite tmpdir via $OKF_REMOTE_CACHE so tests
 * never touch ~/.cache/opencode-okf.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discoverBundles } from "../src/discovery.js";
import {
  applyAuth,
  gitEnv,
  remoteBundleEntries,
  remoteCacheDir,
  repoKey,
  setSyncDebug,
  syncLogPath,
  syncRemotes,
  syncRemote,
} from "../src/sync.js";
import { writeOp, type OpCtx } from "../src/operations.js";
import { runCli } from "../src/cli.js";

const exec = promisify(execFile);

/** Run git in a directory with a throwaway identity (no global config needed). */
function git(cwd: string, ...args: string[]): Promise<string> {
  return exec("git", ["-c", "user.email=t@t.test", "-c", "user.name=tester", ...args], { cwd }).then(
    (r) => r.stdout.toString(),
  );
}

let cacheDir: string;
let originDir: string; // the "remote" repository working tree (source of truth)
let originUrl: string;
let projectDir: string; // an empty "project" whose config points at the remote

/** Commit one more concept into the origin repo (the upstream author pushing an update). */
async function pushConcept(id: string, title: string): Promise<void> {
  await writeFile(
    join(originDir, "kb", "tables", `${id}.md`),
    `---\ntype: "Table"\ntitle: "${title}"\ndescription: "table ${id}"\n---\n# ${title}\n\nbody of ${id}\n`,
    "utf8",
  );
  await git(originDir, "add", "-A");
  await git(originDir, "commit", "-m", `add ${id}`);
}

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "okf-cache-"));
  projectDir = await mkdtemp(join(tmpdir(), "okf-proj-"));
  process.env.OKF_REMOTE_CACHE = cacheDir;

  originDir = await mkdtemp(join(tmpdir(), "okf-origin-"));
  await mkdir(join(originDir, "kb", "tables"), { recursive: true });
  await writeFile(join(originDir, "kb", "index.md"), '---\nokf_version: "0.2"\n---\n# KB\n', "utf8");
  await writeFile(join(originDir, "kb", "log.md"), "", "utf8");
  await writeFile(
    join(originDir, "kb", "tables", "customers.md"),
    '---\ntype: "Table"\ntitle: "Customers"\ndescription: "customer table"\n---\n# Customers\n\nprimary table\n',
    "utf8",
  );
  await git(originDir, "init", "-b", "main");
  await git(originDir, "add", "-A");
  await git(originDir, "commit", "-m", "init kb");
  originUrl = `file://${originDir}`;
}, 60_000);

afterAll(async () => {
  delete process.env.OKF_REMOTE_CACHE;
  await rm(cacheDir, { recursive: true, force: true });
  await rm(originDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe("sync — lifecycle", () => {
  test("first sync clones; bundle inside the checkout is discoverable (origin remote)", async () => {
    const r = await syncRemote({ url: originUrl }, "always");
    expect(r.status).toBe("cloned");

    const entries = await remoteBundleEntries([r]);
    expect(entries.length).toBe(1);
    // Single bundle in the repo → bare repo-basename name, no /kb suffix.
    expect(entries[0]!.name).toBe(basename(originDir));

    const bundles = await discoverBundles({
      projectRoot: projectDir,
      scan: false,
      maxDepth: 4,
      configured: entries,
    });
    expect(bundles.length).toBe(1);
    const b = bundles[0]!;
    expect(b.origin).toBe("remote");
    expect(b.concepts.has("tables/customers")).toBe(true);
  }, 60_000);

  test("upstream push + sync again → fetched, new concept visible", async () => {
    await pushConcept("orders", "Orders");
    const r = await syncRemote({ url: originUrl }, "always");
    expect(r.status).toBe("synced");
    expect(r.message).toMatch(/@ [0-9a-f]+/);

    const entries = await remoteBundleEntries([r]);
    const bundles = await discoverBundles({
      projectRoot: projectDir,
      scan: false,
      maxDepth: 4,
      configured: entries,
    });
    expect(bundles[0]!.concepts.has("tables/orders")).toBe(true);
  }, 60_000);

  test("on-clone mode with a warm cache stays offline", async () => {
    const r = await syncRemote({ url: originUrl }, "on-clone");
    expect(r.status).toBe("cached");
    expect(r.message).toContain("on-clone");
  });

  test("unreachable origin degrades to the cache (never throws)", async () => {
    const deadUrl = `file://${originDir}-does-not-exist`;
    const r = await syncRemote({ url: deadUrl }, "always"); // different hash, no cache
    expect(r.status).toBe("failed");
  }, 60_000);

  test("same url+ref shares one cache dir; different ref gets its own", () => {
    const a = remoteCacheDir({ url: originUrl });
    const b = remoteCacheDir({ url: originUrl });
    const c = remoteCacheDir({ url: originUrl, ref: "v1" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith(cacheDir)).toBe(true);
  });
});

describe("sync — offline degrade with a warm cache", () => {
  test("fetch failure keeps the cached copy usable", async () => {
    // Clone a second origin, then delete it: fetch must fail, cache must survive.
    const secondOrigin = await mkdtemp(join(tmpdir(), "okf-origin2-"));
    await mkdir(join(secondOrigin, "kb"), { recursive: true });
    await writeFile(join(secondOrigin, "kb", "index.md"), '---\nokf_version: "0.2"\n---\n# KB\n', "utf8");
    await writeFile(
      join(secondOrigin, "kb", "solo.md"),
      '---\ntype: "Doc"\ntitle: "Solo"\n---\n# Solo\n\nonly concept\n',
      "utf8",
    );
    await git(secondOrigin, "init", "-b", "main");
    await git(secondOrigin, "add", "-A");
    await git(secondOrigin, "commit", "-m", "init");

    const url = `file://${secondOrigin}`;
    const first = await syncRemote({ url }, "always");
    expect(first.status).toBe("cloned");

    await rm(secondOrigin, { recursive: true, force: true });
    const second = await syncRemote({ url }, "always");
    expect(second.status).toBe("cached");
    expect(second.message).toContain("using cache");

    // The degraded cache still yields its bundle.
    const entries = await remoteBundleEntries([second]);
    expect(entries.length).toBe(1);
    const bundles = await discoverBundles({
      projectRoot: projectDir,
      scan: false,
      maxDepth: 4,
      configured: entries,
    });
    expect(bundles[0]!.concepts.has("solo")).toBe(true);
  }, 120_000);
});

describe("sync — write guard", () => {
  test("okf_write refuses a remote-origin bundle with a pointer to the git source", async () => {
    const r = await syncRemote({ url: originUrl }, "on-clone");
    const entries = await remoteBundleEntries([r]);
    const bundles = await discoverBundles({
      projectRoot: projectDir,
      scan: false,
      maxDepth: 4,
      configured: entries,
    });
    const ctx: OpCtx = {
      cfg: { ...(await import("../src/config.js")).DEFAULT_CONFIG },
      bundles,
      projectDir,
      syntax: "cli",
    };
    expect(writeOp(ctx, { id: "tables/new", type: "Table", mode: "create" })).rejects.toThrow(
      /remote \(git-synced\) knowledge base — read-only/,
    );
  });
});

describe("sync — auth URL injection", () => {
  test("env:VAR token is injected into https URLs (encoded)", async () => {
    process.env.OKF_TEST_TOKEN = "tok/en+1";
    try {
      const u = applyAuth("https://git.example.com/team/kb.git", "env:OKF_TEST_TOKEN");
      expect(u).toBe("https://oauth2:tok%2Fen%2B1@git.example.com/team/kb.git");
      const u2 = applyAuth("https://git.example.com/team/kb.git", "env:OKF_TEST_TOKEN", "x-access-token");
      expect(u2).toBe("https://x-access-token:tok%2Fen%2B1@git.example.com/team/kb.git");
    } finally {
      delete process.env.OKF_TEST_TOKEN;
    }
  });

  test("missing env var / bad spec / non-https URLs", () => {
    expect(() => applyAuth("https://x.git", "env:OKF_DEFINITELY_UNSET_VAR_42")).toThrow(/is not set/);
    expect(() => applyAuth("https://x.git", "literal-token")).toThrow(/env:VARNAME/);
    expect(applyAuth("git@github.com:team/kb.git", "env:OKF_TEST_TOKEN")).toBe("git@github.com:team/kb.git");
  });
});

describe("sync — sync.log observability", () => {
  async function readLog(): Promise<string> {
    return readFile(syncLogPath(), "utf8").catch(() => "");
  }

  test("clone and update are logged with status, duration, and commit — but no URL", async () => {
    const r = await syncRemote({ url: originUrl, name: "log-kb" }, "always"); // update path (cache warm)
    expect(["cloned", "synced"]).toContain(r.status);
    const log = await readLog();
    const lines = log.trim().split("\n");

    // start + result pair for this remote, with duration.
    expect(lines.filter((l) => l.includes("start name=log-kb")).length).toBeGreaterThanOrEqual(1);
    const syncLine = lines.filter((l) => l.includes("name=log-kb") && l.includes("status=")).pop()!;
    expect(syncLine).toMatch(/status=(cloned|synced) \d+ms/);
    if (r.status === "synced") expect(syncLine).toContain("@ ");

    // Privacy: ssh-style URLs embed user@host — the log must carry neither the URL
    // scheme nor the origin path. (The repo basename may legitimately appear as a
    // derived display name; the URL and full path must not.)
    expect(log).not.toContain("file://");
    expect(log).not.toContain(originDir);
    expect(log).toContain(`cache=${basename(r.dir)}`);
  }, 60_000);

  test("failed sync logs an ERROR line", async () => {
    await syncRemote({ url: `file://${originDir}-still-missing`, name: "log-dead" }, "always");
    const lines = (await readLog()).trim().split("\n");
    const errLine = lines.filter((l) => l.includes("name=log-dead")).pop()!;
    expect(errLine).toContain("ERROR");
    expect(errLine).toMatch(/status=failed \d+ms/);
  }, 60_000);

  test("remoteBundleEntries logs the registered bundle names (or a WARN when none)", async () => {
    const r = await syncRemote({ url: originUrl, name: "log-kb" }, "on-clone");
    await remoteBundleEntries([r]);
    let lines = (await readLog()).trim().split("\n");
    expect(lines.pop()).toMatch(/bundles name=log-kb count=1 registered=log-kb/);

    const empty = await mkdtemp(join(tmpdir(), "okf-empty-"));
    try {
      // An initialized but commit-less repo clones fine (with a warning) and holds no bundle.
      await git(empty, "init", "-b", "main");
      const er = await syncRemote({ url: `file://${empty}`, name: "log-nobundle" }, "always");
      // An empty repo clones fine but yields no bundles.
      expect(er.status).toBe("cloned");
      await remoteBundleEntries([er]);
      lines = (await readLog()).trim().split("\n");
      expect(lines.pop()).toContain("bundles name=log-nobundle count=0");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }, 120_000);

  test("log rotates instead of growing forever", async () => {
    const rotDir = await mkdtemp(join(tmpdir(), "okf-rot-"));
    process.env.OKF_SYNC_LOG = join(rotDir, "sync.log");
    try {
      // Pre-fill past the rotation threshold.
      const filler = Array.from({ length: 6000 }, (_, i) => `filler line ${i} ${"x".repeat(100)}`).join("\n");
      await writeFile(process.env.OKF_SYNC_LOG, filler + "\n", "utf8");

      await syncRemote({ url: originUrl, name: "log-rot" }, "on-clone");
      const content = await readFile(process.env.OKF_SYNC_LOG, "utf8");
      expect(content).toContain("name=log-rot"); // the new line survived
      expect(content).not.toContain("filler line 0 "); // the head was dropped
      const size = (await stat(process.env.OKF_SYNC_LOG)).size;
      expect(size).toBeLessThan(600 * 1024);
    } finally {
      delete process.env.OKF_SYNC_LOG;
      await rm(rotDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("setSyncDebug mirrors lines to stderr (captured via console.error)", async () => {
    const orig = console.error;
    const seen: string[] = [];
    console.error = (s: unknown) => seen.push(String(s));
    setSyncDebug(true);
    try {
      await syncRemote({ url: originUrl, name: "log-mirror" }, "on-clone");
    } finally {
      setSyncDebug(false);
      console.error = orig;
    }
    expect(seen.some((s) => s.includes("name=log-mirror") && s.includes("status="))).toBe(true);
  });

  test("git subprocesses are hardened against interactive hangs", () => {
    const env = gitEnv();
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(env.GIT_SSH_COMMAND).toContain("ConnectTimeout=10");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("sync — self-origin guard", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { write: (s: string) => out.push(s), err: (s: string) => err.push(s) },
      out: () => out.join("\n"),
      errText: () => err.join("\n"),
    };
  }

  let selfProj: string;
  let selfOrigin: string; // its own repo, so the "no cache clone" assertion starts cold

  beforeAll(async () => {
    // A project whose git origin IS the remote configured in its .okf.jsonc.
    selfOrigin = await mkdtemp(join(tmpdir(), "okf-selforigin-"));
    await git(selfOrigin, "init", "-b", "main");
    await git(selfOrigin, "add", "-A");
    await git(selfOrigin, "commit", "--allow-empty", "-m", "init");
    const selfUrl = `file://${selfOrigin}`;

    selfProj = await mkdtemp(join(tmpdir(), "okf-self-"));
    await git(selfProj, "init", "-b", "main");
    await git(selfProj, "remote", "add", "origin", selfUrl);
    await writeFile(
      join(selfProj, ".okf.jsonc"),
      JSON.stringify({ scan: { enabled: false }, remotes: [{ url: selfUrl, name: "self-kb" }] }),
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(selfProj, { recursive: true, force: true });
    await rm(selfOrigin, { recursive: true, force: true });
  });

  test("repoKey is protocol/user/.git insensitive", () => {
    const a = repoKey("https://git.example.com/team/kb.git");
    expect(a).toBe(repoKey("git@git.example.com:team/kb"));
    expect(a).toBe(repoKey("ssh://git@git.example.com:22/team/kb"));
    expect(a).toBe(repoKey("https://git.example.com/team/kb/"));
    expect(a).not.toBe(repoKey("https://git.example.com/other/kb.git"));
    expect(repoKey("file:///tmp/x/repo")).toBe(repoKey("/tmp/x/repo"));
  });

  test("syncRemotes skips the project's own repository (no cache clone, no bundle)", async () => {
    const selfUrl = `file://${selfOrigin}`;
    const results = await syncRemotes([{ url: selfUrl, name: "self-kb" }], "always", undefined, selfProj);
    expect(results.length).toBe(1);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.message).toContain("self origin");

    // Nothing registered and nothing cloned into the shared cache.
    expect(await remoteBundleEntries(results)).toEqual([]);
    await expect(stat(remoteCacheDir({ url: selfUrl }))).rejects.toThrow();

    const log = await readFile(syncLogPath(), "utf8");
    expect(log).toContain('status=skipped 0ms "self origin');
  }, 60_000);

  test("okf sync reports the skip and exits 0", async () => {
    const c = capture();
    expect(await runCli(["sync"], c.io, selfProj)).toBe(0);
    expect(c.out()).toContain("skipped");
    expect(c.out()).toContain("self-kb");
    expect(c.out()).toContain("(none found");
  }, 60_000);
});

describe("okf CLI — remotes", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { write: (s: string) => out.push(s), err: (s: string) => err.push(s) },
      out: () => out.join("\n"),
      errText: () => err.join("\n"),
    };
  }

  test("plugin entry: remotes sync on first discovery and flow into tools", async () => {
    const { OkfPlugin } = await import("../src/index.js");
    const { state } = await import("../src/state.js");
    state.markStale();
    const hooks = await OkfPlugin(
      {
        directory: projectDir,
        worktree: projectDir,
        serverUrl: new URL("http://localhost:0"),
      } as any,
      { scan: { enabled: false }, remotes: [{ url: originUrl, name: "team-kb" }] },
    );
    const out = { system: [] as string[] };
    // @ts-ignore - input shape is partial for the test (same as integration.test.ts)
    await hooks["experimental.chat.system.transform"]!({ model: {} }, out);
    expect(out.system.join("\n")).toContain("team-kb");

    const root = await hooks.tool!.okf_list.execute(
      { bundle: "team-kb" },
      { sessionID: "s1", messageID: "m", agent: "build", directory: projectDir, worktree: projectDir, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
    );
    expect(root).toContain("tables/");
    const listed = await hooks.tool!.okf_list.execute(
      { bundle: "team-kb", path: "tables" },
      { sessionID: "s1", messageID: "m", agent: "build", directory: projectDir, worktree: projectDir, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
    );
    expect(listed).toContain("customers");
    state.markStale();
  }, 60_000);

  test("okf sync forces an update and lists the discovered bundles", async () => {
    await pushConcept("invoices", "Invoices");
    await writeFile(
      join(projectDir, ".okf.jsonc"),
      JSON.stringify({ scan: { enabled: false }, remotes: [{ url: originUrl, name: "team-kb" }] }),
      "utf8",
    );
    const c = capture();
    expect(await runCli(["sync"], c.io, projectDir)).toBe(0);
    expect(c.out()).toContain("synced");
    expect(c.out()).toContain("team-kb");

    // Routine reads: on-clone (offline) + remote bundle visible via list.
    const l = capture();
    expect(await runCli(["list"], l.io, projectDir)).toBe(0);
    expect(l.out()).toContain("team-kb");
    const rd = capture();
    expect(await runCli(["read", "tables/invoices", "--bundle", "team-kb"], rd.io, projectDir)).toBe(0);
    expect(rd.out()).toContain("Invoices");

    // Remote bundles are read-only even with --write.
    const w = capture();
    expect(await runCli(["update", "tables/invoices", "--description", "x", "--write"], w.io, projectDir)).toBe(1);
    expect(w.errText()).toContain("read-only");
  }, 120_000);

  test("okf sync with a broken remote exits 1 (CI gate)", async () => {
    await writeFile(
      join(projectDir, ".okf.jsonc"),
      JSON.stringify({ remotes: [{ url: "file:///nonexistent-okf-origin" }] }),
      "utf8",
    );
    const c = capture();
    expect(await runCli(["sync"], c.io, projectDir)).toBe(1);
    expect(c.out()).toContain("failed");
  }, 60_000);

  test("okf sync without remotes is a no-op success", async () => {
    await rm(join(projectDir, ".okf.jsonc"), { force: true });
    const c = capture();
    expect(await runCli(["sync"], c.io, projectDir)).toBe(0);
    expect(c.out()).toContain("No remotes");
  });
});
