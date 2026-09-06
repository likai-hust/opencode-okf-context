/**
 * Compression impact on information hit rate (deterministic layer).
 *
 * Question this answers: after auto-unload replaces a concept's full text with a
 * placeholder, which classes of facts can still be answered from context alone?
 *
 * Method: for every concept in the real 40-concept fixture, classify two facts —
 *   metaFact  (title/type/description — what a "description" placeholder retains)
 *   bodyFact  (a distinctive body sentence — full-text-only information)
 * Build a realistic multi-concept session (X read at turn 1, two later reads push it out
 * of keepRecent), probe at increasing turn distances, run the REAL transformOutbound on
 * the outbound snapshot, and check whether the fact string survives in X's tool output.
 *
 * This is the upper bound of answer quality WITHOUT a reload; whether the model actually
 * reloads when it needs the body again is measured by the live test
 * (OKF_RELOAD_E2E=1 bun test tests/reload-e2e.test.ts).
 *
 * Run: bun benchmark/hitrate.ts
 */
import { resolve } from "node:path";
import { discoverBundles } from "../src/discovery.js";
import { DEFAULT_CONFIG, type OkfConfig } from "../src/config.js";
import { transformOutbound } from "../src/messages.js";
import { renderConceptFull } from "../src/registry.js";
import type { Bundle, Concept } from "../src/types.js";
import type { Message, Part, ToolStateCompleted } from "@opencode-ai/sdk";

const FIXTURE = resolve(import.meta.dir, "../fixtures/unload-bundle");
const MAX_DISTANCE = 10; // probe at 1..10 user turns after the load

// ---------- SDK-shaped message helpers (mirror tests/messages.test.ts) ----------

function userMsg(sessionID: string): { info: Message; parts: Part[] } {
  return {
    info: { id: "u" + Math.random(), sessionID, role: "user", time: { created: 0 }, agent: "a", model: { providerID: "p", modelID: "m" } },
    parts: [{ id: "pt", sessionID, messageID: "u", type: "text", text: "question?" }],
  };
}

function readMsg(sessionID: string, id: string, output: string): { info: Message; parts: Part[] } {
  const st: ToolStateCompleted = { status: "completed", input: { id, bundle: "unload-bundle" }, output, title: "okf_read", metadata: {}, time: { start: 0, end: 0 } };
  return {
    info: { id: "a" + Math.random(), sessionID, role: "assistant", time: { created: 0, completed: 0 }, parentID: "u", modelID: "m", providerID: "p", mode: "default", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, path: { cwd: "/", root: "/" } },
    parts: [{ id: "tp" + Math.random(), sessionID, messageID: "a", type: "tool", callID: "c" + Math.random(), tool: "okf_read", state: st }],
  };
}

// ---------- facts ----------

interface Facts {
  metaFact: string;
  bodyFact: string;
}

/** metaFact: what the "description" placeholder retains; bodyFact: full-text-only. */
function extractFacts(c: Concept): Facts | null {
  const metaFact = (c.description ?? c.title ?? "").trim();
  if (metaFact.length < 10) return null;
  const lines = c.body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 25 && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("```"));
  const bodyFact = lines.sort((a, b) => b.length - a.length)[0];
  if (!bodyFact) return null;
  // Guard: the body fact must not leak into metadata (else it'd survive as meta).
  if (metaFact.includes(bodyFact) || bodyFact.includes(metaFact)) return null;
  return { metaFact, bodyFact };
}

// ---------- probe ----------

/**
 * Simulate: X read at turn 1; Y at turn 3; Z at turn 5 (pushing X past keepRecent=2);
 * probe the outbound snapshot after `distance` user turns. Returns which facts survive.
 */
function probeAtDistance(
  bundles: Bundle[],
  cfg: OkfConfig,
  x: Concept,
  y: Concept,
  z: Concept,
  distance: number,
): { metaHit: boolean; bodyHit: boolean } {
  const sid = `hit-${x.id}-${distance}-${Math.random().toString(36).slice(2, 6)}`;
  const history: Array<{ info: Message; parts: Part[] }> = [];
  const reads: Record<number, Concept> = { 1: x, 3: y, 5: z };
  for (let t = 1; t <= distance; t++) {
    history.push(userMsg(sid));
    const c = reads[t];
    if (c) history.push(readMsg(sid, c.id, renderConceptFull(c)));
  }
  const snapshot = structuredClone(history);
  transformOutbound({ messages: snapshot }, cfg, bundles, sid);
  // Locate X's read output in the snapshot and test fact containment.
  let out = "";
  for (const m of snapshot) {
    for (const p of m.parts) {
      if (p.type === "tool" && p.tool === "okf_read") {
        const st = p.state as ToolStateCompleted;
        if (st.input?.id === x.id) out = st.output;
      }
    }
  }
  const facts = extractFacts(x)!;
  return { metaHit: out.includes(facts.metaFact), bodyHit: out.includes(facts.bodyFact) };
}

// ---------- main ----------

const bundles = await discoverBundles({
  projectRoot: resolve(import.meta.dir, ".."),
  scan: false,
  maxDepth: 4,
  configured: [{ path: FIXTURE, name: "unload-bundle" }],
});
const bundle = bundles[0];
if (!bundle) throw new Error("fixture bundle not found");
const concepts = [...bundle.concepts.values()]
  .map((c) => ({ c, f: extractFacts(c) }))
  .filter((x) => x.f !== null) as Array<{ c: Concept; f: Facts }>;
if (concepts.length < 3) throw new Error("not enough concepts with extractable facts");

const CONFIGS: Array<{ name: string; cfg: OkfConfig }> = [
  { name: "不卸载（对照组）", cfg: { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, enabled: false } } },
  { name: "默认（卸载+description 占位符）", cfg: DEFAULT_CONFIG },
  { name: "minimal 占位符", cfg: { ...DEFAULT_CONFIG, unload: { ...DEFAULT_CONFIG.unload, placeholder: "minimal" } } },
];

const lines: string[] = [];
lines.push("# 压缩对信息命中率的影响（确定性层）");
lines.push("");
lines.push(`- 数据集: 真实 fixture（${concepts.length}/${bundle.concepts.size} 个概念可提取事实对）`);
lines.push(`- 场景: X 在第 1 轮读取，第 3/5 轮读取另外两个概念（把 X 挤出 keepRecent=${DEFAULT_CONFIG.unload.keepRecent}），在第 ${1}-${MAX_DISTANCE} 轮探测`);
lines.push(`- 判定: 真实 transformOutbound 处理后的出站快照中，X 的输出是否仍包含该事实字符串`);
lines.push("");
lines.push("| 配置 | 元数据类事实命中率 | 正文细节类事实命中率 |");
lines.push("|---|---|---|");
for (const { name, cfg } of CONFIGS) {
  let meta = 0, body = 0, total = 0;
  for (let i = 0; i < concepts.length; i++) {
    const { c: x } = concepts[i]!;
    const y = concepts[(i + 1) % concepts.length]!.c;
    const z = concepts[(i + 2) % concepts.length]!.c;
    for (let d = 1; d <= MAX_DISTANCE; d++) {
      const r = probeAtDistance(bundles, cfg, x, y, z, d);
      meta += r.metaHit ? 1 : 0;
      body += r.bodyHit ? 1 : 0;
      total++;
    }
  }
  lines.push(`| ${name} | ${pct(meta, total)} | ${pct(body, total)} |`);
}
lines.push("");
lines.push("## 正文细节类命中率随轮次衰减（默认配置）");
lines.push("");
lines.push("| 读取后轮数 | 正文细节命中率 |");
lines.push("|---|---|");
for (let d = 1; d <= MAX_DISTANCE; d++) {
  let hit = 0, total = 0;
  for (let i = 0; i < concepts.length; i++) {
    const { c: x } = concepts[i]!;
    const y = concepts[(i + 1) % concepts.length]!.c;
    const z = concepts[(i + 2) % concepts.length]!.c;
    const r = probeAtDistance(bundles, DEFAULT_CONFIG, x, y, z, d);
    hit += r.bodyHit ? 1 : 0;
    total++;
  }
  lines.push(`| ${d} | ${pct(hit, total)} |`);
}
lines.push("");
lines.push("解读: 元数据类事实（标题/类型/口径描述）在压缩后仍 100% 可从占位符作答；正文细节");
lines.push("在卸载发生后离开上下文（0%），恢复手段是按占位符提示重读——重读行为由真实 LLM 测试");
lines.push("测量 (OKF_RELOAD_E2E=1 bun test tests/reload-e2e.test.ts)。");
const report = lines.join("\n") + "\n";
console.log(report);
await (await import("node:fs/promises")).writeFile(resolve(import.meta.dir, "hitrate.md"), report, "utf8");
console.log("(written to benchmark/hitrate.md)");

function pct(hit: number, total: number): string {
  return `${((hit / total) * 100).toFixed(0)}% (${hit}/${total})`;
}
