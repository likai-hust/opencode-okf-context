/**
 * Integration test: load the real plugin entry against the fixture bundle and exercise
 * the hooks + tools end-to-end (without an opencode server or an LLM).
 *
 * This is the closest check to "does it actually work in opencode" short of a live run.
 */
import { test, expect } from "bun:test";
import { OkfPlugin } from "../src/index.js";
import { state } from "../src/state.js";
import { join } from "node:path";

const FIXTURE_PROJECT = join(import.meta.dir, "..");

/** Deterministic plugin options: load the sample bundle explicitly, disable auto-scan. */
const OPTS = {
  scan: { enabled: false },
  bundles: [{ path: "fixtures/sample-bundle", name: "sample-bundle" }],
};

function makeInput(): Parameters<typeof OkfPlugin>[0] {
  return {
    // PluginInput shape: only the fields we actually read (directory) matter here.
    directory: FIXTURE_PROJECT,
    worktree: FIXTURE_PROJECT,
    serverUrl: new URL("http://localhost:0"),
    project: {} as any,
    client: {} as any,
    $: {} as any,
  } as any;
}

test("plugin loads, registers 6 tools + system transform hook", async () => {
  const hooks = await OkfPlugin(makeInput(), OPTS);
  expect(hooks.tool).toBeDefined();
  expect(Object.keys(hooks.tool!)).toEqual(
    expect.arrayContaining(["okf_list", "okf_read", "okf_search", "okf_write", "okf_validate", "okf_unload"]),
  );
  expect(hooks["experimental.chat.system.transform"]).toBeDefined();
  expect(hooks["experimental.chat.messages.transform"]).toBeDefined();
});

test("system.transform injects a manifest mentioning the bundle", async () => {
  // Force a fresh discovery.
  state.markStale();
  const hooks = await OkfPlugin(makeInput(), OPTS);
  const out = { system: [] as string[] };
  // @ts-ignore - input shape is partial for the test
  await hooks["experimental.chat.system.transform"]!({ model: {} }, out);
  expect(out.system.length).toBe(1);
  expect(out.system[0]!).toContain("sample-bundle");
  expect(out.system[0]!).toContain("okf_list");
});

test("okf_list returns the root index with concept entries", async () => {
  state.markStale();
  const hooks = await OkfPlugin(makeInput(), OPTS);
  // Root lists sub-directories; drill into tables/ to see leaf concepts with file paths.
  const root = await hooks.tool!.okf_list.execute(
    { bundle: "sample-bundle" },
    { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
  );
  expect(root).toContain("tables/");
  const tables = await hooks.tool!.okf_list.execute(
    { bundle: "sample-bundle", path: "tables" },
    { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
  );
  expect(tables).toContain("customers");
  expect(tables).toContain("orders");
  // Each concept entry exposes its on-disk path so the agent can Read/Edit directly.
  expect(tables).toContain("fixtures/sample-bundle/tables/customers.md");
});

test("okf_read returns full concept with file path header and unload footer", async () => {
  state.markStale();
  const hooks = await OkfPlugin(makeInput(), OPTS);
  const out = await hooks.tool!.okf_read.execute(
    { id: "tables/customers", bundle: "sample-bundle" },
    { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
  );
  expect(out).toContain("fixtures/sample-bundle/tables/customers.md"); // file path header
  expect(out).toContain("type: BigQuery Table");
  expect(out).toContain("# customers");
  expect(out).toContain("okf_unload"); // footer present
});

test("okf_search returns matches with file paths and snippets, not full bodies", async () => {
  state.markStale();
  const hooks = await OkfPlugin(makeInput(), OPTS);
  const out = await hooks.tool!.okf_search.execute(
    { query: "active", bundle: "sample-bundle" },
    { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
  );
  expect(out).toContain("active_customers");
  expect(out).toContain("metrics/active_customers.md"); // file path on the hit
  expect(out).toContain("okf_read");
});

test("okf_read on unknown id throws a helpful error", async () => {
  state.markStale();
  const hooks = await OkfPlugin(makeInput(), OPTS);
  await expect(
    hooks.tool!.okf_read.execute(
      { id: "nope/missing", bundle: "sample-bundle" },
      { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
    ),
  ).rejects.toThrow(/not found/i);
});
