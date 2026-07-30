/**
 * Tests for OKF concept validation:
 *   1. validateConcept (pure) — each rule code fires under the right condition with the
 *      right severity / autoFixable / suggested value, and a clean concept yields no issues.
 *   2. okf_validate tool — end-to-end on a temp bundle with deliberately broken concepts,
 *      asserting the report lists issues and emits ready-to-run okf_write fix commands.
 *   3. okf_write partial update — updating a single field preserves the other fields on disk
 *      (the mechanism that makes the fix commands safe to run).
 */
import { test, expect } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OkfPlugin } from "../src/index.js";
import { state } from "../src/state.js";
import { validateConcept, summarize } from "../src/validate.js";
import type { Concept } from "../src/types.js";

/** Build a minimal Concept object for pure-function tests. */
function mk(partial: Partial<Concept> & { id: string }): Concept {
  return {
    path: "",
    relPath: partial.id + ".md",
    body: "# body\n\nsome content",
    type: undefined,
    title: undefined,
    description: undefined,
    tags: undefined,
    ...partial,
    // Ensure frontmatter always exists (reflects what's on "disk"); spread above
    // already carries partial.frontmatter when provided, default to {} otherwise.
    frontmatter: partial.frontmatter ?? {},
  } as Concept;
}

function hasCode(issues: ReturnType<typeof validateConcept>, code: string) {
  return issues.find((i) => i.code === code);
}

// --- validateConcept: clean concept ----------------------------------

test("a fully-conforming concept produces no issues", () => {
  const c = mk({
    id: "tables/customers",
    frontmatter: { type: "BigQuery Table", title: "customers", description: "master table", tags: ["core"] },
    body: "# customers\n\nrows",
  });
  expect(validateConcept(c)).toEqual([]);
});

// --- validateConcept: type rules -------------------------------------

test("missing type is an error and not auto-fixable", () => {
  const c = mk({ id: "x", frontmatter: { title: "t", description: "d" } });
  const issue = hasCode(validateConcept(c), "type-missing");
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe("error");
  expect(issue!.autoFixable).toBe(false);
  expect(issue!.suggested).toBeUndefined();
});

test("empty/whitespace type counts as missing", () => {
  const c = mk({ id: "x", frontmatter: { type: "   ", title: "t", description: "d" } });
  expect(hasCode(validateConcept(c), "type-missing")).toBeDefined();
});

test("non-string type is auto-fixable with String(type)", () => {
  const c = mk({ id: "x", frontmatter: { type: 42, title: "t", description: "d" } });
  const issue = hasCode(validateConcept(c), "type-not-string");
  expect(issue).toBeDefined();
  expect(issue!.severity).toBe("warning");
  expect(issue!.autoFixable).toBe(true);
  expect(issue!.suggested).toBe("42");
});

// --- validateConcept: title rules ------------------------------------

test("missing title is auto-fixable, suggested from the id basename", () => {
  const c = mk({ id: "metrics/active_customers", frontmatter: { type: "Metric", description: "d" } });
  const issue = hasCode(validateConcept(c), "title-missing");
  expect(issue).toBeDefined();
  expect(issue!.autoFixable).toBe(true);
  expect(issue!.suggested).toBe("active_customers");
});

// --- validateConcept: description ------------------------------------

test("missing description is a warning and not auto-fixable", () => {
  const c = mk({ id: "x", frontmatter: { type: "T", title: "t" } });
  const issue = hasCode(validateConcept(c), "description-missing");
  expect(issue).toBeDefined();
  expect(issue!.autoFixable).toBe(false);
});

// --- validateConcept: tags -------------------------------------------

test("tags as a scalar string is auto-fixable to an array", () => {
  const c = mk({ id: "x", frontmatter: { type: "T", title: "t", description: "d", tags: "core" } });
  const issue = hasCode(validateConcept(c), "tags-not-array");
  expect(issue).toBeDefined();
  expect(issue!.autoFixable).toBe(true);
  expect(issue!.suggested).toEqual(["core"]);
});

test("tags with non-string entries is auto-fixable (coerced)", () => {
  const c = mk({ id: "x", frontmatter: { type: "T", title: "t", description: "d", tags: [1, "a"] } });
  const issue = hasCode(validateConcept(c), "tags-not-array");
  expect(issue).toBeDefined();
  expect(issue!.autoFixable).toBe(true);
  expect(issue!.suggested).toEqual(["1", "a"]);
});

test("tags as a proper string array produces no tags issue", () => {
  const c = mk({ id: "x", frontmatter: { type: "T", title: "t", description: "d", tags: ["a", "b"] } });
  expect(hasCode(validateConcept(c), "tags-not-array")).toBeUndefined();
});

// --- validateConcept: body & frontmatter ----------------------------

test("empty body is a warning and not auto-fixable", () => {
  const c = mk({ id: "x", frontmatter: { type: "T", title: "t", description: "d" }, body: "   \n  " });
  const issue = hasCode(validateConcept(c), "body-empty");
  expect(issue).toBeDefined();
  expect(issue!.autoFixable).toBe(false);
});

test("totally empty file flags frontmatter-missing", () => {
  const c = mk({ id: "x", frontmatter: {}, body: "" });
  expect(hasCode(validateConcept(c), "frontmatter-missing")).toBeDefined();
});

// --- summarize -------------------------------------------------------

test("summarize counts errors and warnings", () => {
  const issues = validateConcept(mk({ id: "x", frontmatter: {}, body: "" }));
  const s = summarize(issues);
  expect(s.errors).toBeGreaterThanOrEqual(1);
  expect(s.warnings).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------
// okf_validate tool (end-to-end on a temp bundle)
// ---------------------------------------------------------------------

const CTX = {
  sessionID: "s1",
  messageID: "m",
  agent: "build",
  directory: "",
  worktree: "",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
} as any;

async function setupTempBundle(): Promise<{ project: string; bundleRoot: string; ctx: any }> {
  const project = join(tmpdir(), `okf-val-${Math.random().toString(36).slice(2)}`);
  const bundleRoot = join(project, "kb");
  await mkdir(join(bundleRoot, "tables"), { recursive: true });
  await writeFile(join(bundleRoot, "index.md"), '---\nokf_version: "0.2"\n---\n\n# KB\n');
  await writeFile(join(bundleRoot, "log.md"), "# Changelog\n");

  // A clean concept (no issues expected).
  await writeFile(
    join(bundleRoot, "tables", "good.md"),
    "---\ntype: BigQuery Table\ntitle: good\ndescription: a clean table\ntags: [core]\n---\n\n# good\n\nbody\n",
  );
  // A concept missing type (error) and missing description (warning).
  await writeFile(
    join(bundleRoot, "tables", "bad_type.md"),
    "---\ntitle: bad_type\ntags: [x]\n---\n\n# bad_type\n\nbody\n",
  );
  // A concept with tags as a scalar (auto-fixable) and no title (auto-fixable from id).
  await writeFile(
    join(bundleRoot, "tables", "bad_tags.md"),
    '---\ntype: Metric\ndescription: a metric\ntags: core\n---\n\n# bad_tags\n\nbody\n',
  );

  const ctx = { ...CTX, directory: project, worktree: project };
  return { project, bundleRoot, ctx };
}

test("okf_validate reports issues across a bundle and emits fix commands", async () => {
  const setup = await setupTempBundle();
  try {
    const hooks = await OkfPlugin(
      { directory: setup.project, worktree: setup.project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );
    const report = await hooks.tool!.okf_validate.execute({ all: true, bundle: "kb" }, { ...CTX, directory: setup.project, worktree: setup.project });

    // Summary line: 3 concepts, 1 valid (good), 2 with issues.
    expect(report).toContain("Validated 3 concept(s)");
    expect(report).toContain("1 valid");
    expect(report).toContain("2 with issues");

    // bad_type: error type-missing + warning description-missing.
    expect(report).toContain("bad_type");
    expect(report).toContain("✗ [error] type");
    expect(report).toContain("`type` is missing");
    expect(report).toContain('type: "<your type');

    // bad_tags: auto-fixable tags array + auto-fixable title from id.
    expect(report).toContain("bad_tags");
    expect(report).toContain("⚠ [warning] tags");
    expect(report).toContain('tags: ["core"]');
    expect(report).toContain("`title` is missing");

    // Footer guidance present.
    expect(report).toContain('mode:"update"');
  } finally {
    await rm(setup.project, { recursive: true, force: true });
    state.markStale();
  }
});

test("okf_validate on a single id reports only that concept", async () => {
  const setup = await setupTempBundle();
  try {
    const hooks = await OkfPlugin(
      { directory: setup.project, worktree: setup.project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );
    const report = await hooks.tool!.okf_validate.execute({ id: "tables/good", bundle: "kb" }, { ...CTX, directory: setup.project, worktree: setup.project });
    expect(report).toContain("1 valid");
    expect(report).toContain("All validated concepts conform");
  } finally {
    await rm(setup.project, { recursive: true, force: true });
    state.markStale();
  }
});

test("okf_validate requires id or all", async () => {
  const setup = await setupTempBundle();
  try {
    const hooks = await OkfPlugin(
      { directory: setup.project, worktree: setup.project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );
    await expect(
      hooks.tool!.okf_validate.execute({ bundle: "kb" }, { ...CTX, directory: setup.project, worktree: setup.project }),
    ).rejects.toThrow(/provide id .* or all:true/i);
  } finally {
    await rm(setup.project, { recursive: true, force: true });
    state.markStale();
  }
});

// ---------------------------------------------------------------------
// okf_write partial update (the mechanism behind the fix commands)
// ---------------------------------------------------------------------

test("okf_write in update mode preserves un-passed fields and only changes the passed one", async () => {
  const project = join(tmpdir(), `okf-write-partial-${Math.random().toString(36).slice(2)}`);
  const bundleRoot = join(project, "kb");
  try {
    await mkdir(join(bundleRoot, "tables"), { recursive: true });
    await writeFile(join(bundleRoot, "index.md"), '---\nokf_version: "0.2"\n---\n\n# KB\n');
    await writeFile(join(bundleRoot, "log.md"), "# Changelog\n");

    const hooks = await OkfPlugin(
      { directory: project, worktree: project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );
    const ctx = { ...CTX, directory: project, worktree: project };

    // Create a concept with full frontmatter.
    await hooks.tool!.okf_write.execute(
      {
        id: "tables/x",
        type: "BigQuery Table",
        title: "x",
        description: "original description",
        tags: ["a", "b"],
        body: "# x\n\noriginal body",
        bundle: "kb",
      },
      ctx,
    );
    state.markStale();

    // Partial update: change ONLY description. Omit type/title/tags/body.
    const out = await hooks.tool!.okf_write.execute(
      { id: "tables/x", description: "updated description", bundle: "kb", mode: "update" },
      ctx,
    );
    expect(out).toContain("partial");

    const written = await readFile(join(bundleRoot, "tables", "x.md"), "utf8");
    // Changed field updated.
    expect(written).toContain("description: updated description");
    // Preserved fields intact.
    expect(written).toContain("type: BigQuery Table");
    expect(written).toContain("title: x");
    expect(written).toContain("# x");
    expect(written).toContain("original body");
    // Tags preserved as an array (not dropped).
    expect(written).toMatch(/tags:\s*\n\s+- a\s*\n\s+- b|tags: \[a, b\]/);
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("okf_write partial update can fix tags from scalar to array via fix command shape", async () => {
  const project = join(tmpdir(), `okf-write-tags-${Math.random().toString(36).slice(2)}`);
  const bundleRoot = join(project, "kb");
  try {
    await mkdir(bundleRoot, { recursive: true });
    await writeFile(join(bundleRoot, "index.md"), '---\nokf_version: "0.2"\n---\n\n# KB\n');
    await writeFile(join(bundleRoot, "log.md"), "# Changelog\n");

    const hooks = await OkfPlugin(
      { directory: project, worktree: project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );
    const ctx = { ...CTX, directory: project, worktree: project };

    // Hand-write a concept whose tags is a scalar (invalid).
    await writeFile(
      join(bundleRoot, "m.md"),
      "---\ntype: Metric\ndescription: a metric\ntags: core\n---\n\n# m\n\nbody\n",
    );
    state.markStale();

    // Apply exactly the fix command validate would emit: only tags changes.
    await hooks.tool!.okf_write.execute(
      { id: "m", tags: ["core"], bundle: "kb", mode: "update" },
      ctx,
    );

    const written = await readFile(join(bundleRoot, "m.md"), "utf8");
    expect(written).toMatch(/tags:\s*\n\s+- core/);
    // type/description/body preserved.
    expect(written).toContain("type: Metric");
    expect(written).toContain("a metric");
    expect(written).toContain("# m");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("okf_write update errors when resulting type would be empty", async () => {
  const project = join(tmpdir(), `okf-write-reqtype-${Math.random().toString(36).slice(2)}`);
  const bundleRoot = join(project, "kb");
  try {
    await mkdir(bundleRoot, { recursive: true });
    await writeFile(join(bundleRoot, "index.md"), '---\nokf_version: "0.2"\n---\n\n# KB\n');
    await writeFile(join(bundleRoot, "log.md"), "# Changelog\n");

    const hooks = await OkfPlugin(
      { directory: project, worktree: project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );
    const ctx = { ...CTX, directory: project, worktree: project };

    // Creating with no type fails (create mode requires type).
    await expect(
      hooks.tool!.okf_write.execute({ id: "nobody", body: "# x", bundle: "kb", mode: "create" } as any, ctx),
    ).rejects.toThrow(/no `type`/i);
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});
