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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discoverBundles } from "../src/discovery.js";
import { applyAuth, remoteBundleEntries, remoteCacheDir, syncRemote } from "../src/sync.js";
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
