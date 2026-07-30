/**
 * Integration test for okf_write: create a concept in a temp bundle copy and verify the
 * file + parent index.md + log.md are all updated. Uses a throwaway temp dir.
 */
import { test, expect } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OkfPlugin } from "../src/index.js";
import { state } from "../src/state.js";

const SAMPLE = join(import.meta.dir, "..", "fixtures", "sample-bundle");

async function cloneFixture(): Promise<{ project: string; bundleRoot: string }> {
  const project = join(tmpdir(), `okf-write-${Math.random().toString(36).slice(2)}`);
  const bundleRoot = join(project, "kb");
  await mkdir(bundleRoot, { recursive: true });
  // Minimal seed: a root index declaring okf_version + an empty log.
  await writeFile(join(bundleRoot, "index.md"), '---\nokf_version: "0.2"\n---\n\n# KB\n');
  await writeFile(join(bundleRoot, "log.md"), "# Changelog\n");
  return { project, bundleRoot };
}

test("okf_write creates a concept, updates index.md and prepends log.md", async () => {
  const { project, bundleRoot } = await cloneFixture();
  try {
    // Register the temp bundle by configuring it.
    const hooks = await OkfPlugin(
      { directory: project, worktree: project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );

    const ctx = { sessionID: "s1", messageID: "m", agent: "build", directory: project, worktree: project, abort: new AbortController().signal, metadata() {}, async ask() {} } as any;

    const out = await hooks.tool!.okf_write.execute(
      {
        id: "tables/payments",
        type: "BigQuery Table",
        title: "payments",
        description: "Payment records.",
        tags: ["core"],
        body: "# payments\n\nA table.",
        bundle: "kb",
      },
      ctx,
    );
    expect(out).toContain("Created concept tables/payments");
    expect(out).toContain("index.md updated");
    expect(out).toContain("log.md appended");

    // File written with frontmatter + body.
    const written = await readFile(join(bundleRoot, "tables", "payments.md"), "utf8");
    expect(written).toContain("type: BigQuery Table");
    expect(written).toContain("description: Payment records.");
    expect(written).toContain("# payments");

    // The concept lives in tables/, so the parent tables/index.md is created/updated
    // with an entry linking to the new concept.
    const tablesIdx = await readFile(join(bundleRoot, "tables", "index.md"), "utf8");
    expect(tablesIdx).toContain("payments");
    expect(tablesIdx).toContain("Payment records.");

    // log.md has today's date heading at/near the top.
    const log = await readFile(join(bundleRoot, "log.md"), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    expect(log).toContain(`## ${today}`);
    expect(log).toContain("Created concept tables/payments");

    // A root-level concept updates the root index.md (dirRel == ".").
    await hooks.tool!.okf_write.execute(
      { id: "top_level", type: "T", title: "Top", description: "root concept", body: "# Top", bundle: "kb" },
      ctx,
    );
    const rootIdx = await readFile(join(bundleRoot, "index.md"), "utf8");
    expect(rootIdx).toContain("top_level");
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("okf_write with mode create fails if concept exists", async () => {
  const { project } = await cloneFixture();
  try {
    const hooks = await OkfPlugin(
      { directory: project, worktree: project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );
    const ctx = { sessionID: "s1", messageID: "m", agent: "build", directory: project, worktree: project, abort: new AbortController().signal, metadata() {}, async ask() {} } as any;
    await hooks.tool!.okf_write.execute({ id: "a", type: "T", body: "x", bundle: "kb" }, ctx);
    // mark stale so the new concept is picked up on next discovery
    state.markStale();
    await expect(
      hooks.tool!.okf_write.execute({ id: "a", type: "T", body: "y", bundle: "kb", mode: "create" }, ctx),
    ).rejects.toThrow(/already exists/i);
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});

test("okf_write rejects path traversal and reserved ids", async () => {
  const { project } = await cloneFixture();
  try {
    const hooks = await OkfPlugin(
      { directory: project, worktree: project, serverUrl: new URL("http://x"), project: {} as any, client: {} as any, $: {} as any } as any,
      { bundles: [{ path: "kb", name: "kb" }] },
    );
    const ctx = { sessionID: "s1", messageID: "m", agent: "build", directory: project, worktree: project, abort: new AbortController().signal, metadata() {}, async ask() {} } as any;
    await expect(
      hooks.tool!.okf_write.execute({ id: "../escape", type: "T", body: "x", bundle: "kb" }, ctx),
    ).rejects.toThrow(/invalid concept id/i);
    await expect(
      hooks.tool!.okf_write.execute({ id: "index", type: "T", body: "x", bundle: "kb" }, ctx),
    ).rejects.toThrow(/invalid concept id/i);
  } finally {
    await rm(project, { recursive: true, force: true });
    state.markStale();
  }
});
