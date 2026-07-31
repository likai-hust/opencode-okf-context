/**
 * Tests for okf_search's two-tier (metadata-first, body-fallback) matching.
 *
 * Progressive disclosure says: search the cheap index fields (title/description/tags) first,
 * and only scan bodies as a last resort. These tests pin that behavior.
 */
import { test, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OkfPlugin } from "../src/index.js";
import { state } from "../src/state.js";

const CTX = {
  sessionID: "s1", messageID: "m", agent: "build",
  directory: "", worktree: "", abort: new AbortController().signal, metadata() {}, async ask() {},
} as any;

async function makeBundle(): Promise<{ project: string; bundleRoot: string }> {
  const project = join(tmpdir(), `okf-search-${Math.random().toString(36).slice(2)}`);
  const bundleRoot = join(project, "kb");
  await mkdir(join(bundleRoot, "g"), { recursive: true });
  await writeFile(join(bundleRoot, "index.md"), '---\nokf_version: "0.2"\n---\n\n# KB\n');
  await writeFile(join(bundleRoot, "log.md"), "# Changelog\n");

  // alpha: "widget" appears ONLY in metadata (title + description + tags). Body has no "widget".
  await writeFile(
    join(bundleRoot, "g", "alpha.md"),
    "---\ntype: Product\ntitle: widget-alpha\ndescription: a widget product\ntags: [widget, core]\n---\n\n# alpha\n\nThis describes a gadget with no mention of the w-word here.\n",
  );
  // beta: "widget" appears ONLY in body. Metadata says nothing about widgets.
  await writeFile(
    join(bundleRoot, "g", "beta.md"),
    "---\ntype: Product\ntitle: beta-tool\ndescription: a separate tool\ntags: [tool]\n---\n\n# beta\n\nInternally it integrates with the widget system.\n",
  );
  // gamma: no "widget" anywhere (control: should never match).
  await writeFile(
    join(bundleRoot, "g", "gamma.md"),
    "---\ntype: Product\ntitle: gamma-thing\ndescription: an unrelated thing\ntags: [misc]\n---\n\n# gamma\n\nNothing relevant here.\n",
  );

  return { project, bundleRoot };
}

async function plugin(project: string) {
  return await OkfPlugin(
    { directory: project, worktree: project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
    { scan: { enabled: false }, bundles: [{ path: "kb", name: "kb" }] },
  );
}

test("metadata match: returns alpha, does NOT scan beta's body (no fallback)", async () => {
  const { project } = await makeBundle();
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    const out = await hooks.tool!.okf_search.execute({ query: "widget-alpha", bundle: "kb" }, ctx);

    // alpha matched in metadata (title).
    expect(out).toContain("alpha");
    // Header says metadata-only — body was not scanned.
    expect(out).toContain("metadata match only");
    expect(out).not.toContain("body fallback");
    // beta (body-only match) must NOT appear, because metadata already matched.
    expect(out).not.toContain("beta");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("body fallback: when metadata matches nothing, body is scanned", async () => {
  const { project } = await makeBundle();
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    // "integrates" appears only in beta's body; no metadata has it.
    const out = await hooks.tool!.okf_search.execute({ query: "integrates", bundle: "kb" }, ctx);

    expect(out).toContain("beta");
    // Body fallback was used.
    expect(out).toContain("body fallback");
    expect(out).toContain("[body]");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("no match anywhere returns the not-found message", async () => {
  const { project } = await makeBundle();
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    const out = await hooks.tool!.okf_search.execute({ query: "zzznomatch", bundle: "kb" }, ctx);
    expect(out).toContain("No matches");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("tag match is a metadata hit (tags field searched in pass 1)", async () => {
  const { project } = await makeBundle();
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    // "core" is a tag on alpha; metadata pass should catch it without scanning bodies.
    const out = await hooks.tool!.okf_search.execute({ query: "core", bundle: "kb" }, ctx);
    expect(out).toContain("alpha");
    expect(out).toContain("metadata match");
    // A tag-only match on one concept does not trigger body fallback for others.
    expect(out).not.toContain("body fallback");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("maxResults limits hits; metadata hits preferred over body hits", async () => {
  const { project } = await makeBundle();
  try {
    const hooks = await plugin(project);
    const ctx = { ...CTX, directory: project, worktree: project };
    // "widget" is in alpha's metadata AND beta's body. With limit 1, alpha (metadata) wins.
    const out = await hooks.tool!.okf_search.execute({ query: "widget", bundle: "kb", maxResults: 1 }, ctx);
    expect(out).toContain("alpha");
    // Only 1 result allowed; beta (body) is dropped even though it also matches.
    expect(out).not.toContain("beta");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});
