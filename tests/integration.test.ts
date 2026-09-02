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

test("plugin loads, registers 7 tools + system transform hook", async () => {
  const hooks = await OkfPlugin(makeInput(), OPTS);
  expect(hooks.tool).toBeDefined();
  expect(Object.keys(hooks.tool!)).toEqual(
    expect.arrayContaining(["okf_list", "okf_read", "okf_search", "okf_write", "okf_validate", "okf_unload", "okf_refs"]),
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

test("okf_list without bundle arg lists all available bundles instead of erroring", async () => {
  state.markStale();
  // Multiple bundles: sample-bundle + unload-bundle (both are fixtures).
  const multiOpts = {
    scan: { enabled: false },
    bundles: [
      { path: "fixtures/sample-bundle", name: "sample-bundle" },
      { path: "fixtures/unload-bundle", name: "unload-bundle" },
    ],
  };
  const hooks = await OkfPlugin(makeInput(), multiOpts);
  const out = await hooks.tool!.okf_list.execute(
    {},
    { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
  );
  // Overview of all bundles, not an error.
  expect(out).toContain("Available OKF bundles");
  expect(out).toContain("sample-bundle");
  expect(out).toContain("unload-bundle");
  // Each bundle has a browse hint.
  expect(out).toContain('okf_list(bundle: "sample-bundle")');
  expect(out).toContain('okf_list(bundle: "unload-bundle")');
  // Must NOT throw — it returns a string, not an error.
  expect(typeof out).toBe("string");
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

test("okf_read appends outgoing + incoming reference annotations for cross-links", async () => {
  state.markStale();
  const hooks = await OkfPlugin(makeInput(), OPTS);
  // tables/customers body links to [orders](/tables/orders.md); orders has type: BigQuery Table.
  const out = await hooks.tool!.okf_read.execute(
    { id: "tables/customers", bundle: "sample-bundle" },
    { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
  );
  // Outgoing section: customers links to orders.
  expect(out).toContain("Outgoing references");
  expect(out).toContain("orders [BigQuery Table]");
  expect(out).toContain('okf_read(id: "tables/orders"');
  // The annotation lets the model decide without browsing the index.
  expect(out).not.toContain("okf_list");
});

test("okf_read shows incoming references for a hub concept", async () => {
  state.markStale();
  const hooks = await OkfPlugin(makeInput(), OPTS);
  // orders is referenced by both tables/customers and metrics/active_customers.
  const out = await hooks.tool!.okf_read.execute(
    { id: "tables/orders", bundle: "sample-bundle" },
    { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
  );
  expect(out).toContain("Incoming references (referenced by 2");
  // Both referencing concepts appear with their metadata.
  expect(out).toContain("customers [BigQuery Table]");
  expect(out).toContain("active_customers [Metric]");
});

test("okf_refs returns the reference graph without loading any body", async () => {
  state.markStale();
  const hooks = await OkfPlugin(makeInput(), OPTS);
  const out = await hooks.tool!.okf_refs.execute(
    { id: "tables/orders", bundle: "sample-bundle" },
    { sessionID: "s1", messageID: "m", agent: "build", directory: FIXTURE_PROJECT, worktree: FIXTURE_PROJECT, abort: new AbortController().signal, metadata() {}, async ask() {} } as any,
  );
  // Header identifies the queried concept.
  expect(out).toContain("Reference graph for tables/orders");
  // Incoming: referenced by customers + active_customers.
  expect(out).toContain("Incoming (referenced by 2");
  expect(out).toContain("customers [BigQuery Table]");
  expect(out).toContain("active_customers [Metric]");
  // Outgoing: orders links to customers.
  expect(out).toContain("Outgoing (links to 1");
  // Crucially, a refs query must NOT dump concept bodies — only metadata + reload hints.
  expect(out).not.toContain("# orders");
  expect(out).toContain('okf_read(id: "tables/customers"');
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
