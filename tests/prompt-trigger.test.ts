/**
 * Prompt trigger tests.
 *
 * Two layers:
 *  1. STATIC (always runs, zero cost): pins the trigger-critical wording in the
 *     L0 manifest and okf_search description. If someone rewrites the prompts and
 *     drops a trigger element, these fail — protecting the plugin's hit rate.
 *  2. E2E hit-rate (opt-in, real LLM cost): run `OKF_TRIGGER_E2E=1 bun test
 *     tests/prompt-trigger.test.ts` to fire a set of natural-language queries at a
 *     real `opencode run` in this project and measure how many trigger okf_* tools.
 *
 * The E2E layer shells out to the opencode CLI (`opencode run --format json`),
 * which loads this project's dogfood plugin (.opencode/plugin/okf.ts) plus the
 * auto-scanned bundles — the same conditions a real user hits.
 */
import { test, expect, describe } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderManifest } from "../src/indexing.js";

const PROJECT = resolve(import.meta.dir, "..");
const E2E = process.env.OKF_TRIGGER_E2E === "1";

// ---------- Part 1: static prompt guards ----------

describe("prompt wording guards (static, zero cost)", () => {
  // Render the manifest with the sample bundle so we test the real bytes.
  const sampleBundles = [
    {
      name: "kb",
      root: "/x",
      concepts: new Map([["tables/customers", { id: "tables/customers", type: "BigQuery Table", title: "customers", description: "Customer master table.", body: "x", path: "/x/tables/customers.md", relPath: "tables/customers.md", frontmatter: {}, tags: [] } as any]]),
      indexDirs: new Set(["."]),
      hasLog: true,
      origin: "config" as const,
    },
  ];
  const manifest = renderManifest(sampleBundles, 2000);

  test("manifest triggers on BOTH reactive and proactive situations", () => {
    expect(manifest).toContain("reactive");
    expect(manifest).toContain("proactive");
    expect(manifest).toContain("write correct code");
  });

  test("manifest tells the model to okf_search before guessing", () => {
    expect(manifest).toContain("okf_search the term before guessing");
  });

  test("manifest carries bilingual trigger phrases", () => {
    expect(manifest).toContain("什么是X");
    expect(manifest).toContain("给我讲讲X");
    expect(manifest).toContain("what is X");
  });

  test("manifest carries the quick decision guide", () => {
    expect(manifest).toContain("Quick decision guide");
    expect(manifest).toContain("okf_search(term) first");
    expect(manifest).toContain("Browse what a bundle contains");
    expect(manifest).toContain("Already know the concept id");
  });

  test("manifest tells the model to prefer okf_* over generic file tools", () => {
    expect(manifest).toContain("Prefer okf_* tools over generic read/glob/grep");
  });

  test("manifest stays within the default 2000-char budget for 1 bundle", () => {
    expect(manifest.length).toBeLessThanOrEqual(2000);
    expect(manifest).toContain("kb");
  });

  test("okf_search description leads with the trigger scenario", async () => {
    const { buildTools } = await import("../src/tools.js");
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    const tools = buildTools(DEFAULT_CONFIG);
    const desc = tools.okf_search.description;
    // The FIRST words must be the use case, not implementation detail.
    expect(desc.startsWith("THE entry point when you hear a term")).toBe(true);
    expect(desc).toContain("我想了解");
    expect(desc).toContain("call okf_read on a matched id to load it");
  });

  test("okf_read description tells the model to unload when done", async () => {
    const { buildTools } = await import("../src/tools.js");
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    const tools = buildTools(DEFAULT_CONFIG);
    expect(tools.okf_read.description).toContain("okf_unload");
    expect(tools.okf_read.description).toContain("Only load what you actually need");
  });
});

// ---------- Part 2: E2E hit-rate (opt-in, real LLM) ----------

/**
 * Run one natural-language query through `opencode run --format json` in this
 * project and return the okf_* tool calls the model made.
 * Each invocation gets a fresh session (no --session/--continue) so history
 * never leaks between cases.
 */
async function runQuery(
  query: string,
  _sessionID: string,
): Promise<{ okfTools: string[]; anyTools: string[]; text: string }> {
  const proc = Bun.spawn(
    ["opencode", "run", "--format", "json", query],
    { cwd: PROJECT, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`opencode run failed (exit ${exit}): ${stderr.slice(0, 300)}`);
  }
  const okfTools: string[] = [];
  const anyTools: string[] = [];
  let text = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "tool_use") {
      const name = ev.part?.tool ?? "";
      anyTools.push(name);
      if (name.startsWith("okf_")) okfTools.push(name);
    }
    if (ev.type === "text") text += ev.part?.text ?? "";
  }
  return { okfTools, anyTools, text };
}

/** A single hit-rate case: the natural-language prompt + what should trigger. */
interface TriggerCase {
  id: string;
  prompt: string;
  /** Set to null to assert the model does NOT reach for okf tools. */
  expectOkf: boolean;
}

// Queries mirror the documented trigger scenarios (reactive / proactive / negative).
const CASES: TriggerCase[] = [
  { id: "reactive-zh-metric", prompt: "我想了解 active_customers 这个指标是怎么定义的", expectOkf: true },
  { id: "reactive-zh-term", prompt: "什么是 customer churn？给我讲讲", expectOkf: true },
  { id: "reactive-en-def", prompt: "How is gross margin defined?", expectOkf: true },
  { id: "proactive-code", prompt: "Write a SQL query to compute MRR. Look up the definition first if it exists in the knowledge base.", expectOkf: true },
  { id: "reactive-en-table", prompt: "What columns does the orders table have?", expectOkf: true },
  { id: "negative-unrelated", prompt: "What is the capital of France?", expectOkf: false },
];

describe("E2E okf hit-rate (OKF_TRIGGER_E2E=1)", () => {
  // Each case is a real LLM round-trip (10-30s); 6 cases need minutes.
  test(
    "runs the query set and reports per-case okf trigger + aggregate rate",
    async () => {
    if (!E2E) {
      console.log("[skip] set OKF_TRIGGER_E2E=1 to run the live opencode hit-rate test");
      return;
    }
    expect(E2E, "E2E requires OKF_TRIGGER_E2E=1").toBe(true);
    const results: Array<{ id: string; okf: string[]; expected: boolean; hit: boolean }> = [];
    for (const c of CASES) {
      // Fresh session per case so history never leaks between queries.
      const sid = `hit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { okfTools } = await runQuery(c.prompt, sid);
      const hit = c.expectOkf ? okfTools.length > 0 : okfTools.length === 0;
      results.push({ id: c.id, okf: okfTools, expected: c.expectOkf, hit });
      console.log(
        `[hit] ${c.id.padEnd(18)} expected=${c.expectOkf ? "okf" : "none"} got=${okfTools.length ? okfTools.join(",") : "(none)"} ${hit ? "✓" : "✗"}`,
      );
    }
    const expectedTrue = results.filter((r) => r.expected).length;
    const hitTrue = results.filter((r) => r.expected && r.hit).length;
    const hitFalse = results.filter((r) => !r.expected && r.hit).length;
    const rate = expectedTrue > 0 ? hitTrue / expectedTrue : 1;
    console.log(`\n=== hit-rate: ${hitTrue}/${expectedTrue} positive + ${hitFalse}/${results.length - expectedTrue} negative ===`);
    console.log(`=== aggregate positive trigger rate: ${(rate * 100).toFixed(0)}% ===\n`);

    // Hard gates: all expected-positive cases must trigger, all negatives must not.
    for (const r of results) {
      expect(r.hit, `case ${r.id}: expected ${r.expected ? "okf trigger" : "no okf trigger"} but got ${r.okf.join(",") || "(none)"}`).toBe(true);
    }
    // And a global floor: at least 4/5 positive cases must trigger.
    expect(rate).toBeGreaterThanOrEqual(0.8);
  },
  600_000, // 10 min ceiling for 6 live LLM round-trips
  );
});

describe("prompt trigger metadata", () => {
  test("E2E suite is opt-in (skipped unless OKF_TRIGGER_E2E=1)", () => {
    // Keeps the default `bun test` run fast and free.
    expect(E2E).toBe(process.env.OKF_TRIGGER_E2E === "1");
  });
});
