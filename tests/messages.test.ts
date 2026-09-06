/**
 * Unit tests for the outbound message transformer (unload / dedup / nudge).
 *
 * These build synthetic message histories directly so the logic is exercised without an
 * opencode server. The transform operates only on the `parts` we hand it.
 */
import { test, expect } from "bun:test";
import { transformOutbound } from "../src/messages.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { state } from "../src/state.js";
import type { Bundle, Concept } from "../src/types.js";
import type { Message, Part, ToolStateCompleted } from "@opencode-ai/sdk";

// --- helpers to build minimal SDK-shaped objects ----------------------

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

function readToolPart(
  id: string,
  bundle: string | undefined,
  output: string,
  sessionID = "s1",
): Part {
  const state: ToolStateCompleted = {
    status: "completed",
    input: { id, ...(bundle ? { bundle } : {}) },
    output,
    title: "okf_read",
    metadata: {},
    time: { start: 0, end: 0 },
  };
  return { id: "tp" + Math.random(), sessionID, messageID: "a", type: "tool", callID: "c" + Math.random(), tool: "okf_read", state };
}

function searchToolPart(query: string, output: string, sessionID = "s1"): Part {
  const state: ToolStateCompleted = {
    status: "completed",
    input: { query },
    output,
    title: "okf_search",
    metadata: {},
    time: { start: 0, end: 0 },
  };
  return { id: "tp" + Math.random(), sessionID, messageID: "a", type: "tool", callID: "c" + Math.random(), tool: "okf_search", state };
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

// --- tests ------------------------------------------------------------

test("auto-unloads after configured user turns, keeps most recent", () => {
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, afterTurns: 2, keepRecent: 1 } };
  const bundles = [makeBundle("b", [{ id: "tables/customers", description: "C" }, { id: "tables/orders", description: "O" }])];
  const long = "X".repeat(500);

  // Old read (customers) in turn 1; recent read (orders) in turn 3. By turn 4:
  // customers is 3 turns old (> afterTurns=2) -> unload; orders is recent -> kept.
  const input = {
    messages: [
      userMsg(),                                  // turn 1
      assistantMsg(undefined, [readToolPart("tables/customers", "b", long)]),
      userMsg(),                                  // turn 2
      assistantMsg(),
      userMsg(),                                  // turn 3
      assistantMsg(undefined, [readToolPart("tables/orders", "b", long)]),
      userMsg(),                                  // turn 4 (customers: 3 turns since load)
    ],
  };
  const res = transformOutbound(input, cfg, bundles, "s1");
  expect(res.unloaded).toBe(1);
  const oldTp = input.messages[1]!.parts[0] as Extract<Part, { type: "tool" }>;
  const newTp = input.messages[5]!.parts[0] as Extract<Part, { type: "tool" }>;
  expect((oldTp.state as ToolStateCompleted).output).toContain("unloaded");      // old unloaded
  expect((newTp.state as ToolStateCompleted).output).toBe(long);                 // recent kept
  expect((oldTp.state as ToolStateCompleted).output.length).toBeLessThan(long.length);
});

test("keepRecent protects the most recent read from auto-unload", () => {
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, afterTurns: 1, keepRecent: 1 } };
  const bundles = [makeBundle("b", [{ id: "a" }, { id: "b" }])];

  const input = {
    messages: [
      userMsg(),
      assistantMsg(undefined, [readToolPart("a", "b", "AAAA")]),   // older read
      userMsg(),
      assistantMsg(undefined, [readToolPart("b", "b", "BBBB")]),   // most recent read
      userMsg(),                                                    // 1 turn since both... but keepRecent=1 protects b
    ],
  };
  const res = transformOutbound(input, cfg, bundles, "s1");
  expect(res.unloaded).toBe(1); // only "a" unloaded, "b" kept
});

test("keepRecent=0 unloads a single read purely by turn count", () => {
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, afterTurns: 2, keepRecent: 0 } };
  const bundles = [makeBundle("b", [{ id: "tables/customers", description: "C" }])];
  const long = "X".repeat(500);
  const input = {
    messages: [
      userMsg(),
      assistantMsg(undefined, [readToolPart("tables/customers", "b", long)]),
      userMsg(),
      assistantMsg(),
      userMsg(), // 2 turns since load
    ],
  };
  const res = transformOutbound(input, cfg, bundles, "s1");
  expect(res.unloaded).toBe(1);
});

test("dedup keeps only the latest read of the same concept", () => {
  // Spread-clone: DEFAULT_CONFIG is a shared mutable object — mutating it directly
  // pollutes other test files (caught by tests/defaults.test.ts).
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99 } }; // disable auto-unload
  const bundles = [makeBundle("b", [{ id: "dup" }])];

  const input = {
    messages: [
      userMsg(),
      assistantMsg(undefined, [readToolPart("dup", "b", "OLD")]),
      userMsg(),
      assistantMsg(undefined, [readToolPart("dup", "b", "NEW")]),
    ],
  };
  const res = transformOutbound(input, cfg, bundles, "s1");
  expect(res.deduped).toBe(1);
  const first = input.messages[1]!.parts[0] as Extract<Part, { type: "tool" }>;
  const second = input.messages[3]!.parts[0] as Extract<Part, { type: "tool" }>;
  expect((first.state as ToolStateCompleted).output).toContain("deduplicated");
  expect((second.state as ToolStateCompleted).output).toBe("NEW");
});

test("manual unload via state immediately replaces output", () => {
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99 } };
  const bundles = [makeBundle("b", [{ id: "m" }])];
  state.unload("s1", "b::m");

  const input = {
    messages: [userMsg(), assistantMsg(undefined, [readToolPart("m", "b", "FULL")])],
  };
  const res = transformOutbound(input, cfg, bundles, "s1");
  expect(res.unloaded).toBe(1);
  const tp = input.messages[1]!.parts[0] as Extract<Part, { type: "tool" }>;
  expect((tp.state as ToolStateCompleted).output).toContain("unloaded");
});

test("protectedConcepts glob prevents auto-unload", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    unload: { ...DEFAULT_CONFIG.unload, afterTurns: 1, keepRecent: 0 },
    protectedConcepts: ["tables/*"],
  };
  const bundles = [makeBundle("b", [{ id: "tables/keep" }])];
  const input = {
    messages: [userMsg(), assistantMsg(undefined, [readToolPart("tables/keep", "b", "FULL")]), userMsg()],
  };
  const res = transformOutbound(input, cfg, bundles, "s1");
  expect(res.unloaded).toBe(0);
});

test("nudge injects soft reminder above threshold, throttled", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99 },
    nudge: { ...DEFAULT_CONFIG.nudge, threshold: 10, frequency: 3 },
  };
  const bundles = [makeBundle("b", [{ id: "big" }])];
  const big = "Y".repeat(200);

  const input = {
    messages: [
      userMsg(),
      assistantMsg(undefined, [readToolPart("big", "b", big)]),
      userMsg(), // 1 turn since; retained 200 > 10 → nudge
    ],
  };
  const res = transformOutbound(input, cfg, bundles, "s1");
  expect(res.nudged).toBe(true);
  // nudge appended to last user message text part
  const lastUser = input.messages[2]!;
  const text = lastUser.parts.find((p) => p.type === "text") as Extract<Part, { type: "text" }>;
  expect(text.text).toContain("okf_unload");
});

/** force: "strong" must produce a directive tone, distinct from the "soft" suggestion. */
function runNudge(force: "soft" | "strong", sessionID = "s1"): string {
  const cfg = {
    ...DEFAULT_CONFIG,
    unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99 },
    nudge: { ...DEFAULT_CONFIG.nudge, threshold: 10, frequency: 3, force },
  };
  const bundles = [makeBundle("b", [{ id: "big" }])];
  const big = "Y".repeat(200);
  const input = {
    messages: [userMsg(sessionID), assistantMsg(sessionID, [readToolPart("big", "b", big, sessionID)]), userMsg(sessionID)],
  };
  transformOutbound(input, cfg, bundles, sessionID);
  const lastUser = input.messages[2]!;
  const text = lastUser.parts.find((p) => p.type === "text") as Extract<Part, { type: "text" }>;
  return text.text;
}

test('force: "soft" vs "strong" produce distinct nudge tones', () => {
  // Separate sessions so each nudge's throttle counter is independent.
  const soft = runNudge("soft", "s-soft");
  const strong = runNudge("strong", "s-strong");
  // Both still carry the unload guidance marker.
  expect(soft).toContain("okf_unload");
  expect(strong).toContain("okf_unload");
  // The two tones must differ (regression guard for the dead-ternary bug).
  expect(soft).not.toEqual(strong);
  // soft = suggestion ("consider"); strong = directive (no "consider").
  expect(soft).toContain("consider unloading");
  expect(strong).not.toContain("consider unloading");
});

// --- okf_search output dedup / aging ------------------------------------

test("repeated okf_search keeps only the latest results for the same query", () => {
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, afterTurns: 99 } };
  const bundles = [makeBundle("b", [{ id: "x" }])];
  const input = {
    messages: [
      userMsg("s-srch"),
      assistantMsg("s-srch", [searchToolPart("customer churn", "OLD-RESULTS", "s-srch")]),
      userMsg("s-srch"),
      assistantMsg("s-srch", [searchToolPart("Customer  Churn", "NEW-RESULTS", "s-srch")]), // same query normalized
    ],
  };
  const res = transformOutbound(input, cfg, bundles, "s-srch");
  expect(res.deduped).toBe(1);
  const first = input.messages[1]!.parts[0] as Extract<Part, { type: "tool" }>;
  const second = input.messages[3]!.parts[0] as Extract<Part, { type: "tool" }>;
  expect((first.state as ToolStateCompleted).output).toContain("deduplicated");
  expect((first.state as ToolStateCompleted).output).toContain("customer churn");
  expect((second.state as ToolStateCompleted).output).toBe("NEW-RESULTS");
});

test("stale search results age out after afterTurns; the most recent search is kept", () => {
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, afterTurns: 2, keepRecent: 0 } };
  const bundles = [makeBundle("b", [{ id: "x" }])];
  const input = {
    messages: [
      userMsg("s-srch2"),
      assistantMsg("s-srch2", [searchToolPart("churn", "RESULTS-OLD", "s-srch2")]),
      userMsg("s-srch2"),
      assistantMsg(),
      userMsg("s-srch2"),
      assistantMsg("s-srch2", [searchToolPart("aov", "RESULTS-NEW", "s-srch2")]), // most recent search: kept
      userMsg("s-srch2"), // churn search is now 3 turns old (> afterTurns=2)
    ],
  };
  const res = transformOutbound(input, cfg, bundles, "s-srch2");
  expect(res.unloaded).toBe(1);
  const old = input.messages[1]!.parts[0] as Extract<Part, { type: "tool" }>;
  const recent = input.messages[5]!.parts[0] as Extract<Part, { type: "tool" }>;
  const oldOut = (old.state as ToolStateCompleted).output;
  expect(oldOut).toContain("released");
  expect(oldOut).toContain(`~${"RESULTS-OLD".length} chars freed`);
  expect((recent.state as ToolStateCompleted).output).toBe("RESULTS-NEW");
});

test("search placeholder wording never directs a reload (anti-loop contract)", () => {
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, afterTurns: 1, keepRecent: 0 } };
  const bundles = [makeBundle("b", [{ id: "x" }])];
  const input = {
    messages: [
      userMsg("s-srch3"),
      assistantMsg("s-srch3", [searchToolPart("churn", "R".repeat(500), "s-srch3")]),
      userMsg("s-srch3"),
      assistantMsg("s-srch3", [searchToolPart("aov", "R2", "s-srch3")]),
      userMsg("s-srch3"),
    ],
  };
  transformOutbound(input, cfg, bundles, "s-srch3");
  const old = input.messages[1]!.parts[0] as Extract<Part, { type: "tool" }>;
  const out = (old.state as ToolStateCompleted).output;
  expect(out).toContain("routine context management");
  expect(out).toContain("no action is needed");
  expect(out).toContain("ONLY if you genuinely need");
  // It must not read as an instruction to re-run right away.
  expect(out).not.toMatch(/^Re-run/);
});

test("search outputs are untouched when unload is disabled", () => {
  const cfg = { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, enabled: false } };
  const bundles = [makeBundle("b", [{ id: "x" }])];
  const input = {
    messages: [
      userMsg("s-srch4"),
      assistantMsg("s-srch4", [searchToolPart("churn", "RESULTS", "s-srch4")]),
      userMsg("s-srch4"),
    ],
  };
  const res = transformOutbound(input, cfg, bundles, "s-srch4");
  expect(res.deduped).toBe(0);
  expect(res.unloaded).toBe(0);
  const tp = input.messages[1]!.parts[0] as Extract<Part, { type: "tool" }>;
  expect((tp.state as ToolStateCompleted).output).toBe("RESULTS");
});
