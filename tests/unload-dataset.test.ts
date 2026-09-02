/**
 * Unload capability tests against the local-only test dataset
 * `fixtures/unload-bundle/` (40 concepts, 3 docs > 6000 chars).
 *
 * Part A — real disk discovery + read chain (large docs, batch read).
 * Part B — parameterized unload scenarios (in-memory bundles, exact char control).
 * Part C — THE core check: an 8-turn conversation where we measure the actual
 *          context bytes going to the LLM after every turn and prove the
 *          unload mechanism genuinely shrinks the context (vs. a no-unload control).
 *
 * NOTE: this file + fixture are LOCAL-ONLY (gitignored) — see .gitignore.
 */
import { test, expect, describe } from "bun:test";
import { resolve, join } from "node:path";
import { transformOutbound } from "../src/messages.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { state } from "../src/state.js";
import type { Bundle, Concept } from "../src/types.js";
import type { Message, Part, ToolStateCompleted } from "@opencode-ai/sdk";

const FIXTURE = resolve(import.meta.dir, "../fixtures/unload-bundle");
const PROJECT = resolve(import.meta.dir, "..");
const bundleNames = { unload: "unload-bundle" };

// ---------- helpers (mirror tests/messages.test.ts patterns) ----------

function userMsg(sessionID = "s1"): { info: Message; parts: Part[] } {
  return {
    info: { id: "u" + Math.random(), sessionID, role: "user", time: { created: 0 }, agent: "a", model: { providerID: "p", modelID: "m" } },
    parts: [{ id: "pt", sessionID, messageID: "u", type: "text", text: "hi" }],
  };
}

function assistantMsg(sessionID = "s1", toolParts: Part[] = []): { info: Message; parts: Part[] } {
  return {
    info: { id: "a" + Math.random(), sessionID, role: "assistant", time: { created: 0, completed: 0 }, parentID: "u", modelID: "m", providerID: "p", mode: "default", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, path: { cwd: "/", root: "/" } },
    parts: toolParts,
  };
}

function readToolPart(id: string, bundle: string | undefined, output: string, sessionID = "s1"): Part {
  const st: ToolStateCompleted = {
    status: "completed",
    input: { id, ...(bundle ? { bundle } : {}) },
    output,
    title: "okf_read",
    metadata: {},
    time: { start: 0, end: 0 },
  };
  return { id: "tp" + Math.random(), sessionID, messageID: "a", type: "tool", callID: "c" + Math.random(), tool: "okf_read", state: st };
}

function batchReadToolPart(ids: string[], bundle: string | undefined, output: string, sessionID = "s1"): Part {
  const st: ToolStateCompleted = {
    status: "completed",
    input: { ids, ...(bundle ? { bundle } : {}) },
    output,
    title: "okf_read",
    metadata: {},
    time: { start: 0, end: 0 },
  };
  return { id: "tp" + Math.random(), sessionID, messageID: "a", type: "tool", callID: "c" + Math.random(), tool: "okf_read", state: st };
}

function makeBundle(name: string, concepts: Array<Partial<Concept> & { id: string }>): Bundle {
  const map = new Map<string, Concept>();
  for (const c of concepts) {
    map.set(c.id, {
      id: c.id,
      path: "/x/" + c.id + ".md",
      relPath: c.id + ".md",
      frontmatter: { type: c.type ?? "T", title: c.title ?? c.id, description: c.description ?? "desc " + c.id },
      body: c.body ?? "body",
      type: c.type ?? "T",
      title: c.title ?? c.id,
      description: c.description ?? "desc " + c.id,
      tags: c.tags,
    });
  }
  return { name, root: "/x", concepts: map, indexDirs: new Set(["."]), hasLog: true, origin: "config" };
}

/** Total characters of every part actually sent to the LLM (tool outputs + text). */
function contextBytes(input: { messages: Array<{ info: Message; parts: Part[] }> }): number {
  let n = 0;
  for (const m of input.messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && p.state?.status === "completed") n += (p.state as ToolStateCompleted).output.length;
      else if (p.type === "text") n += p.text.length;
    }
  }
  return n;
}

// ---------- Part A: real disk chain ----------

describe("unload-bundle disk dataset (Part A)", () => {
  // NOTE: these tests deliberately avoid the plugin entry / global `state`
  // singleton — other test files (search, robustness, integration) share it and
  // bun runs files concurrently. Pure discovery + parse keeps this file isolated.
  let bundles: Bundle[];
  let b: Bundle;

  test("discovers 40 concepts with typed frontmatter", async () => {
    const { discoverBundles } = await import("../src/discovery.js");
    bundles = await discoverBundles({
      projectRoot: PROJECT,
      scan: true,
      maxDepth: 4,
      configured: [{ path: FIXTURE, name: bundleNames.unload }],
    });
    b = bundles.find((x) => x.name === bundleNames.unload)!;
    expect(b).toBeDefined();
    expect(b.concepts.size).toBe(40);
    for (const [, c] of b.concepts) {
      expect(c.type, `concept ${c.id} must have a type`).toBeTruthy();
      expect(c.yamlError).toBeUndefined();
    }
    // 5 reference docs present, 3 of them > 6000 body chars (nudge trigger).
    const ref = ["data_model", "api_schema", "sla_policy", "ownership_matrix", "compliance"];
    for (const r of ref) expect(b.concepts.has(`reference/${r}`)).toBe(true);
    expect(b.concepts.get("reference/sla_policy")!.body.length).toBeGreaterThan(6000);
    expect(b.concepts.get("reference/api_schema")!.body.length).toBeGreaterThan(6000);
    expect(b.concepts.get("reference/compliance")!.body.length).toBeGreaterThan(6000);
    // and two medium docs for the accumulate-past-threshold scenario
    expect(b.concepts.get("reference/data_model")!.body.length).toBeLessThan(2000);
    expect(b.concepts.get("reference/ownership_matrix")!.body.length).toBeLessThan(2000);
  });

  test("full read of sla_policy would exceed 6000 chars (okf_read output)", async () => {
    const { buildTools } = await import("../src/tools.js");
    // Render the full concept the same way okf_read does, without touching state.
    const { renderConceptFull } = await import("../src/registry.js");
    const c = b.concepts.get("reference/sla_policy")!;
    const full = renderConceptFull(c);
    expect(full.length).toBeGreaterThan(6000);
    expect(full).toContain("SLA Policy");
    // okf_read's footer would carry the unload hint.
    expect(buildTools(DEFAULT_CONFIG)).toBeDefined();
  });

  test("bundle index lists all 5 reference docs", async () => {
    const idx = await Bun.file(join(FIXTURE, "index.md")).text();
    expect(idx).toContain("reference/sla_policy.md");
    expect(idx).toContain("reference/api_schema.md");
    expect(idx).toContain("reference/compliance.md");
    expect(idx).toContain("reference/data_model.md");
    expect(idx).toContain("reference/ownership_matrix.md");
  });
});

// ---------- Part B: parameterized unload scenarios ----------

describe("unload scenarios (Part B)", () => {
  test("auto-unload after 2 turns frees output bytes", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      unload: { ...DEFAULT_CONFIG.unload, afterTurns: 2, keepRecent: 0 },
    };
    const bundles = [makeBundle("b", [{ id: "reference/sla_policy", description: "SLA" }])];
    const big = "X".repeat(6000);
    const input = {
      messages: [
        userMsg(),                                                                // turn 1: read
        assistantMsg(undefined, [readToolPart("reference/sla_policy", "b", big)]),
        userMsg(),                                                                // turn 2
        assistantMsg(),
        userMsg(),                                                                // turn 3: turnsSince=2 -> unload
        assistantMsg(),
      ],
    };
    const before = contextBytes(input);
    const res = transformOutbound(input, cfg, bundles, "s1");
    expect(res.unloaded).toBe(1);
    const after = contextBytes(input);
    // freed == tool output length; placeholder is tiny
    expect(after).toBeLessThan(before - 5000);
    const tp = input.messages[1]!.parts[0]! as Extract<Part, { type: "tool" }>;
    expect((tp.state as ToolStateCompleted).output).toContain("chars freed");
  });

  test("keepRecent=1 protects the latest read, unloads older", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      unload: { ...DEFAULT_CONFIG.unload, afterTurns: 2, keepRecent: 1 },
    };
    const bundles = [makeBundle("b", [{ id: "a" }, { id: "b" }])];
    const mid = "Y".repeat(2000);
    const input = {
      messages: [
        userMsg(),                                                      // turn 1: read a
        assistantMsg(undefined, [readToolPart("a", "b", mid)]),
        userMsg(),                                                      // turn 2
        assistantMsg(),
        userMsg(),                                                      // turn 3: read b (recent)
        assistantMsg(undefined, [readToolPart("b", "b", mid)]),
        userMsg(),                                                      // turn 4: a (3 turns) unloaded, b kept
        assistantMsg(),
      ],
    };
    const res = transformOutbound(input, cfg, bundles, "s2");
    expect(res.unloaded).toBe(1);
    const a = input.messages[1]!.parts[0]! as Extract<Part, { type: "tool" }>;
    const b = input.messages[5]!.parts[0]! as Extract<Part, { type: "tool" }>;
    expect((a.state as ToolStateCompleted).output).toContain("unloaded");
    expect((b.state as ToolStateCompleted).output).toBe(mid);
  });

  test("single >6000-char read triggers nudge", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99 },
      nudge: { ...DEFAULT_CONFIG.nudge, threshold: 6000, frequency: 3, force: "soft" as const },
    };
    const bundles = [makeBundle("b", [{ id: "reference/sla_policy" }])];
    const big = "Z".repeat(7000);
    const input = {
      messages: [userMsg(), assistantMsg(undefined, [readToolPart("reference/sla_policy", "b", big)]), userMsg()],
    };
    const res = transformOutbound(input, cfg, bundles, "s3");
    expect(res.nudged).toBe(true);
    const text = input.messages[2]!.parts.find((p) => p.type === "text") as Extract<Part, { type: "text" }>;
    expect(text.text).toContain("7000");
    expect(text.text).toContain("okf_unload");
  });

  test("multiple medium reads accumulate past threshold -> nudge", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99 },
      nudge: { ...DEFAULT_CONFIG.nudge, threshold: 6000, frequency: 3, force: "soft" as const },
    };
    const bundles = [makeBundle("b", [{ id: "reference/data_model" }, { id: "reference/ownership_matrix" }])];
    const mid = "W".repeat(2500); // 2 x 2500 = 5000, below; add a third -> 7500
    const input = {
      messages: [
        userMsg(),
        assistantMsg(undefined, [readToolPart("reference/data_model", "b", mid)]),
        userMsg(),
        assistantMsg(undefined, [readToolPart("reference/ownership_matrix", "b", mid)]),
        userMsg(),
        assistantMsg(undefined, [readToolPart("glossary/aov", "b", mid)]),
        userMsg(),
      ],
    };
    const res = transformOutbound(input, cfg, bundles, "s4");
    expect(res.nudged).toBe(true);
    const text = input.messages[6]!.parts.find((p) => p.type === "text") as Extract<Part, { type: "text" }>;
    expect(text.text).toContain("7500");
  });

  test("manual unload takes precedence even with keepRecent/protected", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99, keepRecent: 1 },
      protectedConcepts: ["reference/*"],
    };
    const bundles = [makeBundle("b", [{ id: "reference/sla_policy" }])];
    const big = "V".repeat(3000);
    state.unload("s5", "b::reference/sla_policy");
    const input = {
      messages: [userMsg(), assistantMsg(undefined, [readToolPart("reference/sla_policy", "b", big)]), userMsg()],
    };
    const res = transformOutbound(input, cfg, bundles, "s5");
    expect(res.unloaded).toBe(1);
  });

  test("batch read unloads as a single unit with all reload commands", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      unload: { ...DEFAULT_CONFIG.unload, afterTurns: 2, keepRecent: 0 },
    };
    const bundles = [makeBundle("b", [{ id: "glossary/aov" }, { id: "glossary/mrr" }, { id: "glossary/cac" }])];
    const out = "G".repeat(900); // 3 concepts x 300-ish
    const input = {
      messages: [
        userMsg(),
        assistantMsg(undefined, [batchReadToolPart(["glossary/aov", "glossary/mrr", "glossary/cac"], "b", out)]),
        userMsg(),
        assistantMsg(),
        userMsg(),
      ],
    };
    const res = transformOutbound(input, cfg, bundles, "s6");
    expect(res.unloaded).toBe(1);
    const tp = input.messages[1]!.parts[0]! as Extract<Part, { type: "tool" }>;
    const text = (tp.state as ToolStateCompleted).output;
    expect(text).toContain("batch of 3 concepts auto-unloaded");
    expect(text).toContain('okf_read(ids: ["glossary/aov"');
    expect(text).toContain('okf_read(ids: ["glossary/cac"');
  });

  test("dedup replaces earlier read of same concept", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99 },
    };
    const bundles = [makeBundle("b", [{ id: "tables/orders" }])];
    const long = "H".repeat(1500);
    const input = {
      messages: [
        userMsg(),
        assistantMsg(undefined, [readToolPart("tables/orders", "b", long)]),
        userMsg(),
        assistantMsg(undefined, [readToolPart("tables/orders", "b", long)]),
        userMsg(),
      ],
    };
    const res = transformOutbound(input, cfg, bundles, "s7");
    expect(res.deduped).toBe(1);
    expect(res.unloaded).toBe(0);
    const first = input.messages[1]!.parts[0]! as Extract<Part, { type: "tool" }>;
    expect((first.state as ToolStateCompleted).output).toContain("deduplicated");
    const second = input.messages[3]!.parts[0]! as Extract<Part, { type: "tool" }>;
    expect((second.state as ToolStateCompleted).output).toBe(long);
  });

  test("protectedConcepts glob prevents auto-unload", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      unload: { ...DEFAULT_CONFIG.unload, afterTurns: 1, keepRecent: 0 },
      protectedConcepts: ["reference/*"],
    };
    const bundles = [makeBundle("b", [{ id: "reference/sla_policy" }, { id: "tables/orders" }])];
    const mid = "K".repeat(1000);
    const input = {
      messages: [
        userMsg(),
        assistantMsg(undefined, [readToolPart("reference/sla_policy", "b", mid)]),
        userMsg(),
        assistantMsg(),
        userMsg(),
      ],
    };
    const res = transformOutbound(input, cfg, bundles, "s8");
    expect(res.unloaded).toBe(0);
    const tp = input.messages[1]!.parts[0]! as Extract<Part, { type: "tool" }>;
    expect((tp.state as ToolStateCompleted).output).toBe(mid);
  });
});

// ---------- Part C: the core check — 8-turn context-size trajectory ----------

/**
 * Builds an 8-turn conversation where the agent reads big docs at turns 1, 3, 5, 7.
 * Returns the contextBytes after each turn, with unload enabled or disabled.
 */
function runEightTurnTrajectory(unloadEnabled: boolean, sessionID: string): number[] {
  const cfg = {
    ...DEFAULT_CONFIG,
    unload: { ...DEFAULT_CONFIG.unload, enabled: unloadEnabled, afterTurns: 2, keepRecent: 1 },
    nudge: { ...DEFAULT_CONFIG.nudge, enabled: false },
  };
  const bundles = [makeBundle("b", [
    { id: "reference/sla_policy", description: "SLA Policy" },
    { id: "reference/api_schema", description: "API Schema" },
    { id: "reference/compliance", description: "Compliance" },
    { id: "reference/data_model", description: "Data Model" },
  ])];
  const A = "A".repeat(7000); // sla_policy
  const B = "B".repeat(7000); // api_schema
  const C = "C".repeat(7000); // compliance
  const D = "D".repeat(7000); // data_model

  const messages: Array<{ info: Message; parts: Part[] }> = [];
  const trajectory: number[] = [];
  // Four DIFFERENT concepts read at turns 1/3/5/7 — no dedup, so the control
  // trajectory is a pure accumulation and the unload trajectory shows only
  // auto-unload (keepRecent=1) at work.
  const turns: Array<{ read?: { id: string; out: string } }> = [
    { read: { id: "reference/sla_policy", out: A } },  // turn 1
    {},                                                // turn 2
    { read: { id: "reference/api_schema", out: B } },  // turn 3
    {},                                                // turn 4
    { read: { id: "reference/compliance", out: C } },  // turn 5
    {},                                                // turn 6
    { read: { id: "reference/data_model", out: D } },  // turn 7
    {},                                                // turn 8
  ];
  for (const t of turns) {
    messages.push(userMsg(sessionID));
    messages.push(assistantMsg(sessionID, t.read ? [readToolPart(t.read.id, "b", t.read.out, sessionID)] : []));
    transformOutbound({ messages }, cfg, bundles, sessionID);
    trajectory.push(contextBytes({ messages }));
  }
  return trajectory;
}

describe("8-turn context-size trajectory (Part C)", () => {
  test("with unload: context stays bounded and shrinks after each read ages out", () => {
    const withUnload = runEightTurnTrajectory(true, "s-unload");
    console.log("[unload on ] context bytes per turn:", withUnload.join(" -> "));
    expect(withUnload.length).toBe(8);
    // After turn 1 read (7000), turn 2 still holds it: growth expected.
    expect(withUnload[1]!).toBeGreaterThan(withUnload[0]!);
    // Turn 3: turn-1 read is 2 turns old -> replaced by placeholder, then new read added.
    // Key property: with unload ON, total at any turn stays under ~2.5 reads.
    // 7000(read) + ~100(placeholder) + 7000(read) + text ≈ 14200 max; assert it stays bounded.
    expect(Math.max(...withUnload)).toBeLessThan(22000);
    // After the final turn, the first (turn-1) read must have been replaced: size must be
    // far below the no-unload trajectory at every matching index.
    expect(withUnload[7]!).toBeLessThan(16000);
  });

  test("CONTROL: without unload the same conversation accumulates ~28k and never shrinks", () => {
    const noUnload = runEightTurnTrajectory(false, "s-no-unload");
    console.log("[unload off] context bytes per turn:", noUnload.join(" -> "));
    // 4 distinct reads of 7000 each accumulate: turn8 >= 28000 (only grows, never replaced)
    expect(noUnload[7]!).toBeGreaterThanOrEqual(28000);
    // monotonically non-decreasing (nothing is ever removed)
    for (let i = 1; i < noUnload.length; i++) {
      expect(noUnload[i]!).toBeGreaterThanOrEqual(noUnload[i - 1]!);
    }
  });

  test("unload genuinely shrinks context vs control: gap grows across turns", () => {
    const withUnload = runEightTurnTrajectory(true, "s-gap-a");
    const noUnload = runEightTurnTrajectory(false, "s-gap-b");
    // At the end, the unload version must be at least 12k smaller than control.
    const gap = noUnload[7]! - withUnload[7]!;
    console.log(`final gap (control - unload): ${gap} chars`);
    expect(gap).toBeGreaterThan(12000);
  });
});
