/**
 * Tests for the v0.1.3 robustness + validation enhancements:
 *  H1  malformed YAML frontmatter must not break bundle discovery, and okf_validate
 *      reports it as yaml-error.
 *  H2  bundle-root heuristic: a dir with index.md/log.md + a typed concept is accepted
 *      without okf_version; a plain markdown dir is not.
 *  M2  okf_validate all:true reports bundle-level issues (okf_version missing, log.md
 *      missing, broken cross-links).
 *  M3  okf_write mode:"delete" removes the file, its index.md entry, and logs it.
 *  M4  okf_read ids:[...] returns multiple concepts, and the batch unloads as a unit.
 */
import { test, expect } from "bun:test";
import { mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OkfPlugin } from "../src/index.js";
import { state } from "../src/state.js";
import { discoverBundles, parseConcept } from "../src/discovery.js";
import { splitFrontmatter } from "../src/frontmatter.js";
import { validateConcept, extractLinks, validateBundleIndex } from "../src/validate.js";
import { transformOutbound } from "../src/messages.js";
import type { Concept } from "../src/types.js";

const CTX = {
  sessionID: "s1", messageID: "m", agent: "build",
  directory: "", worktree: "", abort: new AbortController().signal, metadata() {}, async ask() {},
} as any;

async function makeBundle(files: Record<string, string>): Promise<{ project: string; bundleRoot: string }> {
  const project = join(tmpdir(), `okf-rob-${Math.random().toString(36).slice(2)}`);
  const bundleRoot = join(project, "kb");
  await mkdir(bundleRoot, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(bundleRoot, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  return { project, bundleRoot };
}

async function plugin(project: string) {
  return await OkfPlugin(
    { directory: project, worktree: project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
    { scan: { enabled: false }, bundles: [{ path: "kb", name: "kb" }] },
  );
}

// ---------------------------------------------------------------------
// H1: malformed YAML tolerance
// ---------------------------------------------------------------------

test("splitFrontmatter does not throw on malformed YAML and reports yamlError", () => {
  const doc = splitFrontmatter("---\ntype: \n  bad: [unclosed\n---\n\n# body\n");
  expect(doc.hasFrontmatter).toBe(true);
  expect(doc.yamlError).toBeDefined();
  expect(doc.frontmatter).toEqual({});
});

test("parseConcept tolerates malformed YAML (no crash)", async () => {
  const { bundleRoot } = await makeBundle({
    "index.md": '---\nokf_version: "0.2"\n---\n\n# KB\n',
    "bad.md": "---\ntype: \n  bad: [unclosed\n---\n\n# bad\n",
  });
  try {
    const c = await parseConcept(join(bundleRoot, "bad.md"), bundleRoot);
    expect(c.yamlError).toBeDefined();
    expect(c.type).toBeUndefined();
  } finally {
    await rm(bundleRoot, { recursive: true, force: true });
  }
});

test("bundle with a malformed-YAML concept still discovers and validates", async () => {
  const { project } = await makeBundle({
    "index.md": '---\nokf_version: "0.2"\n---\n\n# KB\n',
    "log.md": "# Changelog\n",
    "good.md": "---\ntype: T\ntitle: good\ndescription: d\n---\n\n# good\nbody\n",
    "bad.md": "---\ntype: \n  bad: [unclosed\n---\n\n# bad\n",
  });
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    // Discovery works (no crash) and the bad concept is present.
    const list = await hooks.tool!.okf_list.execute({ bundle: "kb" }, ctx);
    expect(list).toContain("bad");

    // Validate reports the yaml parse error on the bad concept.
    const report = await hooks.tool!.okf_validate.execute({ all: true, bundle: "kb" }, ctx);
    expect(report).toContain("[error] yaml");
    expect(report).toContain("could not be parsed");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("validateConcept surfaces yaml-error", async () => {
  const c = {
    id: "x", path: "", relPath: "x.md", frontmatter: {}, body: "# x",
    yamlError: "boom: bad yaml", type: undefined, title: undefined, description: undefined, tags: undefined,
  } as Concept;
  const issues = validateConcept(c);
  const issue = issues.find((i) => i.code === "yaml-error");
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe("error");
  expect(issue!.autoFixable).toBe(false);
});

// ---------------------------------------------------------------------
// H2: bundle-root heuristic
// ---------------------------------------------------------------------

test("dir with index.md/log.md + typed concept is a bundle even without okf_version", async () => {
  const project = join(tmpdir(), `okf-h2-${Math.random().toString(36).slice(2)}`);
  const bundleRoot = join(project, "kb");
  await mkdir(bundleRoot, { recursive: true });
  await writeFile(join(bundleRoot, "index.md"), "# Plain index (no okf_version)\n");
  await writeFile(join(bundleRoot, "c.md"), "---\ntype: Metric\ntitle: c\ndescription: d\n---\n\n# c\nbody\n");
  try {
    const bundles = await discoverBundles({
      projectRoot: project,
      scan: true,
      maxDepth: 4,
      configured: [],
    });
    expect(bundles.length).toBe(1);
    expect(bundles[0]!.concepts.has("c")).toBe(true);
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("plain markdown dir (no index/log/type) is NOT a bundle", async () => {
  const project = join(tmpdir(), `okf-h2b-${Math.random().toString(36).slice(2)}`);
  const docs = join(project, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(join(docs, "readme.md"), "# just some docs\n");
  await writeFile(join(docs, "notes.md"), "notes without frontmatter\n");
  try {
    const bundles = await discoverBundles({
      projectRoot: project,
      scan: true,
      maxDepth: 4,
      configured: [],
    });
    expect(bundles.length).toBe(0);
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

// ---------------------------------------------------------------------
// M2: bundle-level validation
// ---------------------------------------------------------------------

test("okf_validate all:true reports bundle-level issues (okf_version / log / broken links)", async () => {
  // Root index WITHOUT okf_version, no log.md, one concept with a dangling link.
  const { project } = await makeBundle({
    "index.md": "# KB without okf_version\n",
    "tables/a.md": "---\ntype: T\ntitle: a\ndescription: d\ntags: [x]\n---\n\n# a\n\nSee [missing](/tables/ghost.md) and [exists](/tables/b.md).\n",
    "tables/b.md": "---\ntype: T\ntitle: b\ndescription: d\ntags: [x]\n---\n\n# b\nbody\n",
  });
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    const report = await hooks.tool!.okf_validate.execute({ all: true, bundle: "kb" }, ctx);

    // Bundle-level issues reported (human-readable messages, not codes).
    expect(report).toContain('does not declare `okf_version`');
    expect(report).toContain("No log.md at the bundle root");
    expect(report).toContain('Cross-link "tables/ghost.md" does not resolve');
    // The link to an existing concept must not be flagged as broken.
    expect(report).not.toContain('Cross-link "tables/b.md"');
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("extractLinks normalizes absolute, relative, dot segments, and skips external/anchor", () => {
  const links = extractLinks(
    "See [x](/tables/a.md), [y](b.md), [z](../c.md#sec), ![img](/img.png), [ext](https://example.com), [a](#anchor).",
    "tables/sub/x",
  );
  expect(links).toContain("tables/a.md");
  expect(links).toContain("tables/sub/b.md");
  expect(links).toContain("tables/c.md"); // ../c.md from tables/sub/x resolves to tables/c.md
  expect(links).not.toContain("/img.png");
  expect(links).not.toContain("https://example.com");
  expect(links).not.toContain("#anchor");
});

test("extractLinks drops links that escape the bundle root", () => {
  const links = extractLinks("Go [up](../../up.md).", "tables/sub/x");
  expect(links).not.toContain("../../up.md");
});

test("validateBundleIndex flags missing okf_version with a fixable suggestion", () => {
  const issue = validateBundleIndex({});
  expect(issue).toBeDefined();
  expect(issue!.code).toBe("bundle-okf-version-missing");
  expect(issue!.autoFixable).toBe(true);
  expect(validateBundleIndex({ okf_version: "0.2" })).toBeUndefined();
});

// ---------------------------------------------------------------------
// M3: okf_write mode:"delete"
// ---------------------------------------------------------------------

test("okf_write delete removes file, index.md entry, and logs it", async () => {
  // Entries live in the concept's own directory index.md (kb/tables/index.md), matching
  // updateParentIndex's semantics.
  const { project } = await makeBundle({
    "index.md": '---\nokf_version: "0.2"\n---\n\n# KB\n',
    "log.md": "# Changelog\n",
    "tables/index.md": "# Tables\n\n* [a](./a.md) - desc a\n* [b](./b.md) - desc b\n",
    "tables/a.md": "---\ntype: T\ntitle: a\ndescription: desc a\n---\n\n# a\nbody\n",
    "tables/b.md": "---\ntype: T\ntitle: b\ndescription: desc b\n---\n\n# b\nbody\n",
  });
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };

    const out = await hooks.tool!.okf_write.execute(
      { id: "tables/a", bundle: "kb", mode: "delete" },
      ctx,
    );
    expect(out).toContain("Deleted concept tables/a");
    expect(out).toContain("index.md entry removed");
    expect(out).toContain("log.md appended");

    // File gone.
    await expect(access(join(project, "kb", "tables", "a.md"))).rejects.toThrow();

    // tables/index.md entry for a removed, b preserved.
    const idx = await readFile(join(project, "kb", "tables", "index.md"), "utf8");
    expect(idx).not.toContain("a.md");
    expect(idx).toContain("b.md");

    // log.md records deletion.
    const log = await readFile(join(project, "kb", "log.md"), "utf8");
    expect(log).toContain("Deleted concept tables/a");

    // Deleting a missing concept errors.
    await expect(
      hooks.tool!.okf_write.execute({ id: "tables/a", bundle: "kb", mode: "delete" }, ctx),
    ).rejects.toThrow(/nothing to delete/i);
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

// ---------------------------------------------------------------------
// M4: okf_read batch ids + batch unload
// ---------------------------------------------------------------------

test("okf_read ids returns both concepts separated by a delimiter", async () => {
  const { project } = await makeBundle({
    "index.md": '---\nokf_version: "0.2"\n---\n\n# KB\n',
    "a.md": "---\ntype: T\ntitle: a\ndescription: d\n---\n\n# a\nbody-a\n",
    "b.md": "---\ntype: T\ntitle: b\ndescription: d\n---\n\n# b\nbody-b\n",
  });
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    const out = await hooks.tool!.okf_read.execute({ ids: ["a", "b"], bundle: "kb" }, ctx);
    expect(out).toContain("body-a");
    expect(out).toContain("body-b");
    expect(out).toContain("\n---\n"); // batch separator
    expect(out).toContain("okf_unload"); // footer

    // id and ids are mutually exclusive.
    await expect(
      hooks.tool!.okf_read.execute({ id: "a", ids: ["b"], bundle: "kb" }, ctx),
    ).rejects.toThrow(/either id or ids/i);
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("batch okf_read output unloads as a unit via transformOutbound", async () => {
  const { project } = await makeBundle({
    "index.md": '---\nokf_version: "0.2"\n---\n\n# KB\n',
    "a.md": "---\ntype: T\ntitle: a\ndescription: d\n---\n\n# a\nbody-a\n",
    "b.md": "---\ntype: T\ntitle: b\ndescription: d\n---\n\n# b\nbody-b\n",
  });
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    const out = await hooks.tool!.okf_read.execute({ ids: ["a", "b"], bundle: "kb" }, ctx);

    // Build a synthetic message history with the completed batch tool part.
    const toolPart = {
      type: "tool",
      tool: "okf_read",
      callID: "c1",
      state: { status: "completed", input: { ids: ["a", "b"], bundle: "kb" }, output: out },
    } as any;
    const input = {
      messages: [
        { info: { role: "user" } as any, parts: [{ type: "text", text: "load" } as any] },
        { info: { role: "assistant" } as any, parts: [toolPart] },
        { info: { role: "user" } as any, parts: [{ type: "text", text: "next turn" } as any] },
      ],
    } as any;

    // afterTurns=1 -> the batch should be replaced by a single batch placeholder.
    const result = transformOutbound(input, {
      enabled: true,
      scan: { enabled: false, maxDepth: 4, ignore: [] },
      bundles: [],
      disclosure: { injectManifest: true, maxManifestChars: 2000 },
      unload: { enabled: true, afterTurns: 1, keepRecent: 0, placeholder: "minimal" },
      nudge: { enabled: false, threshold: 6000, frequency: 3, force: "soft" },
      write: { enabled: true, updateIndex: true, appendLog: true },
      protectedConcepts: [],
      debug: false,
    } as any, state.getBundles(), "s1");

    expect(result.unloaded).toBe(1);
    const replaced = input.messages[1]!.parts[0]!.state.output as string;
    expect(replaced).toContain("batch of 2 concepts unloaded");
    expect(replaced).toContain("okf_read");
    expect(replaced).not.toContain("body-a");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});
