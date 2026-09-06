/**
 * CLI tests: exercise runCli() (the testable entry of src/cli.ts) against the committed
 * unload-bundle fixture plus throwaway tmp bundles for write/section scenarios.
 *
 * The load-bearing contract: CLI read output must NEVER mention okf_unload — there is no
 * unload mechanism outside opencode, and promising one would mislead the model.
 */
import { test, expect, describe } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "../src/cli.js";
import { PLUGIN_VERSION } from "../src/version.js";

const UNLOAD = resolve(import.meta.dir, "../fixtures/unload-bundle");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

/** A small tmp bundle with a known sectioned doc + one untyped (invalid) concept. */
async function makeTmpBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okf-cli-"));
  await writeFile(join(dir, "index.md"), '---\nokf_version: "0.2"\n---\n# Index\n', "utf8");
  await writeFile(join(dir, "log.md"), "", "utf8");
  await mkdir(join(dir, "reference"), { recursive: true });
  await writeFile(
    join(dir, "reference", "big.md"),
    [
      "---",
      'type: "Reference"',
      'title: "Big doc"',
      'description: "A doc with sections"',
      "---",
      "# Big doc",
      "",
      "intro line zero",
      "",
      "## Alpha",
      "",
      "alpha content one two three",
      "",
      "## Beta",
      "",
      "beta content four five six",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "tables"), { recursive: true });
  await writeFile(join(dir, "tables", "bad.md"), "no frontmatter at all\n", "utf8");
  return dir;
}

/** Clone the unload fixture so write tests never touch the committed dataset. */
async function cloneUnloadBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okf-cli-write-"));
  await cp(UNLOAD, dir, { recursive: true });
  return dir;
}

describe("okf CLI — basics", () => {
  test("version reports the plugin version", async () => {
    const c = capture();
    expect(await runCli(["version"], c.io)).toBe(0);
    expect(c.out()).toContain(PLUGIN_VERSION);
  });

  test("help lists commands and exits 0", async () => {
    const c = capture();
    expect(await runCli(["help"], c.io)).toBe(0);
    expect(c.out()).toContain("read <id>");
    expect(c.out()).toContain("--max-chars");
  });

  test("unknown command is a usage error (exit 2)", async () => {
    const c = capture();
    expect(await runCli(["frobnicate"], c.io)).toBe(2);
    expect(c.errText()).toContain("Unknown command");
  });

  test("no command is a usage error (exit 2)", async () => {
    const c = capture();
    expect(await runCli([], c.io)).toBe(2);
  });
});

describe("okf CLI — read paths (footer contract)", () => {
  test("list uses CLI-syntax hints, not tool-call syntax", async () => {
    const c = capture();
    expect(await runCli(["list"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("# unload-bundle — (root)/");
    expect(c.out()).toContain("okf list tables --bundle unload-bundle");
    expect(c.out()).not.toContain("okf_list(");
  });

  test("read full text: CLI footer, never mentions okf_unload", async () => {
    const c = capture();
    expect(await runCli(["read", "glossary/mrr"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("loaded via the okf CLI");
    expect(c.out()).not.toContain("okf_unload");
  });

  test("--fields loads metadata only", async () => {
    const c = capture();
    expect(await runCli(["read", "glossary/mrr", "--fields"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("- type:");
    expect(c.out()).toContain("not loaded");
  });

  test("--ids reads a batch as one unit", async () => {
    const c = capture();
    expect(await runCli(["read", "--ids", "glossary/aov,glossary/mrr", "--fields"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("glossary/aov");
    expect(c.out()).toContain("glossary/mrr");
  });

  test("--section extracts only the requested section", async () => {
    const dir = await makeTmpBundle();
    try {
      const c = capture();
      expect(await runCli(["read", "reference/big", "--section", "Alpha"], c.io, dir)).toBe(0);
      expect(c.out()).toContain("alpha content");
      expect(c.out()).not.toContain("beta content");
      expect(c.out()).toContain('section "Alpha" only');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--section miss lists available sections and exits 1", async () => {
    const dir = await makeTmpBundle();
    try {
      const c = capture();
      expect(await runCli(["read", "reference/big", "--section", "Nope"], c.io, dir)).toBe(1);
      expect(c.errText()).toContain("Available sections");
      expect(c.errText()).toContain("Alpha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--max-chars truncates the body with a marker", async () => {
    const dir = await makeTmpBundle();
    try {
      const c = capture();
      expect(await runCli(["read", "reference/big", "--max-chars", "80"], c.io, dir)).toBe(0);
      expect(c.out()).toContain("truncated to 80");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("okf CLI — search / refs / validate", () => {
  test("search finds by metadata and suggests the CLI read command", async () => {
    const c = capture();
    expect(await runCli(["search", "sla"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("reference/sla_policy");
    expect(c.out()).toContain("okf read reference/sla_policy --bundle unload-bundle");
  });

  test("search with no matches exits 0 with a friendly message", async () => {
    const c = capture();
    expect(await runCli(["search", "zzznope"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("No matches");
  });

  test("refs renders the reference graph", async () => {
    const c = capture();
    expect(await runCli(["refs", "glossary/mrr"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("Reference graph for glossary/mrr");
  });

  test("validate --all on the clean dataset exits 0", async () => {
    const c = capture();
    expect(await runCli(["validate", "--all"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("Validated 40 concept(s)");
  });

  test("validate --all on a broken bundle exits 1 with fix commands", async () => {
    const dir = await makeTmpBundle();
    try {
      const c = capture();
      expect(await runCli(["validate", "--all"], c.io, dir)).toBe(1);
      expect(c.out()).toContain("tables/bad");
      expect(c.out()).toContain("fix:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("okf CLI — write gating", () => {
  test("update without --write is refused (exit 1)", async () => {
    const dir = await cloneUnloadBundle();
    try {
      const c = capture();
      expect(await runCli(["update", "tables/customers", "--title", "New Title"], c.io, dir)).toBe(1);
      expect(c.errText()).toContain("--write");
      // file untouched
      const raw = await readFile(join(dir, "tables", "customers.md"), "utf8");
      expect(raw).not.toContain("New Title");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("update with --write performs a partial update on disk", async () => {
    const dir = await cloneUnloadBundle();
    try {
      const c = capture();
      expect(await runCli(["update", "tables/customers", "--title", "New Title", "--write"], c.io, dir)).toBe(0);
      const raw = await readFile(join(dir, "tables", "customers.md"), "utf8");
      expect(raw).toContain("New Title");
      expect(raw).toContain("type:"); // preserved by the partial update
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("delete with --write removes the concept file", async () => {
    const dir = await cloneUnloadBundle();
    try {
      const c = capture();
      expect(await runCli(["delete", "glossary/aov", "--write"], c.io, dir)).toBe(0);
      await expect(readFile(join(dir, "glossary", "aov.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("okf CLI — manifest + smoke", () => {
  test("manifest uses CLI commands and never mentions okf_unload", async () => {
    const c = capture();
    expect(await runCli(["manifest"], c.io, UNLOAD)).toBe(0);
    expect(c.out()).toContain("okf search");
    expect(c.out()).toContain("unload-bundle");
    expect(c.out()).not.toContain("okf_unload");
  });

  test("spawn smoke: bun src/cli.ts read runs end-to-end", async () => {
    const proc = Bun.spawn(
      ["bun", resolve(import.meta.dir, "../src/cli.ts"), "read", "glossary/mrr"],
      { cwd: UNLOAD, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(stdout).toContain("loaded via the okf CLI");
  });
});
