/**
 * Real stress benchmark for the intranet sharing deck:
 *   S0  "skill + Python script" reading  — grep-style search + whole-file cat; nothing
 *       ever leaves context (the common baseline inside the bank).
 *   S0i S0-ideal — the script magically cats exactly the right file, no search output
 *       (a lower bound for the baseline; makes the comparison honest).
 *   S1  plugin progressive disclosure WITHOUT unload (list/search metadata-first,
 *       read only the needed concept; content stays).
 *   S2  plugin full: progressive disclosure + auto-unload/dedup/nudge (shipped defaults).
 *
 * Everything measured is REAL: real generated bundle on disk, real python subprocess
 * output bytes, real searchOp/readOp output bytes, and the real transformOutbound for
 * S2 (applied to a fresh clone of the history on every turn, exactly like a live
 * request). The only simulated part is the agent's *policy* for what to read — stated
 * per strategy below.
 *
 * Run:  bun benchmark/stress.ts [--concepts 200] [--questions 10] [--seed 42]
 *                               [--use-fixture fixtures/unload-bundle]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discoverBundles } from "../src/discovery.js";
import { DEFAULT_CONFIG, type OkfConfig } from "../src/config.js";
import { searchOp, readOp, type OpCtx } from "../src/operations.js";
import { renderManifest } from "../src/indexing.js";
import { transformOutbound } from "../src/messages.js";
import type { Bundle, Concept } from "../src/types.js";
import type { Message, Part, ToolStateCompleted } from "@opencode-ai/sdk";

// ---------- args ----------

const args = process.argv.slice(2);
function argNum(name: string, dflt: number): number {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}
const N_CONCEPTS = argNum("concepts", 200);
const N_QUESTIONS = argNum("questions", 10);
const SEED = argNum("seed", 42);
const FIXTURE_IDX = args.indexOf("--use-fixture");

// ---------- deterministic RNG ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const randInt = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// ---------- synthetic bank-style bundle ----------

const DIR_PLANS = [
  { dir: "tables", share: 0.3, type: "BigQuery Table", size: [900, 2600] as const },
  { dir: "metrics", share: 0.25, type: "Metric", size: [700, 1800] as const },
  { dir: "glossary", share: 0.25, type: "Glossary Term", size: [500, 1400] as const },
  { dir: "runbooks", share: 0.12, type: "Runbook", size: [1500, 4000] as const },
  { dir: "reference", share: 0.08, type: "Reference", size: [5500, 9000] as const },
];

const PREFIXES = ["loan", "repayment", "collection", "customer", "risk", "recovery", "contact", "promise", "payment", "aging", "settlement", "writeoff"];
const SUFFIXES = ["rule", "policy", "bucket", "strategy", "queue", "threshold", "window", "matrix", "formula", "workflow", "score", "flag"];

function buildTerms(n: number): string[] {
  const combos: string[] = [];
  for (const p of PREFIXES) for (const s of SUFFIXES) combos.push(`${p}_${s}`);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const base = combos[i % combos.length]!;
    out.push(i < combos.length ? base : `${base}_v${Math.floor(i / combos.length) + 1}`);
  }
  return out;
}

function bodyFor(term: string, type: string, targetChars: number, related: string[]): string {
  const lines: string[] = [
    `# ${term}`,
    "",
    `## Overview`,
    "",
    `The **${term}** (${type.toLowerCase()}) governs how the retail-credit system treats this entity. ` +
      `It is maintained by the data governance team and consumed by the collections decision engine.`,
    "",
    `## Definition`,
    "",
    `- owner: retail-risk-data\n- refresh: daily 02:00\n- source: warehouse layer \`dws_${term}\``,
    "",
    `## Notes`,
    "",
  ];
  let size = lines.join("\n").length;
  let para = 0;
  while (size < targetChars) {
    const sentence =
      `Para ${para}: for ${term}, the engine evaluates delinquency state, contact history and promise-to-pay ` +
      `signals before choosing a treatment path. Related concepts: ${related.join(", ")}. ` +
      `Thresholds are reviewed quarterly against ${term} performance rollups.`;
    lines.push(sentence, "");
    size += sentence.length + 1;
    para++;
  }
  return lines.join("\n");
}

async function generateBundle(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.md"), '---\nokf_version: "0.2"\n---\n# Bank KB\n', "utf8");
  await writeFile(join(root, "log.md"), "", "utf8");
  const terms = buildTerms(N_CONCEPTS);
  const plan: Array<{ dir: string; type: string; size: readonly [number, number]; term: string; related: string[] }> = [];
  for (const p of DIR_PLANS) {
    const count = Math.max(1, Math.round(N_CONCEPTS * p.share));
    for (let i = 0; i < count && plan.length < N_CONCEPTS; i++) {
      plan.push({ dir: p.dir, type: p.type, size: p.size, term: terms[plan.length]!, related: [] });
    }
  }
  // Cross-references: each concept mentions 2 other terms (creates realistic grep
  // "wrong hits" — exactly what happens with a naive script search).
  for (const c of plan) {
    const a = plan[randInt(0, plan.length - 1)]!;
    const b = plan[randInt(0, plan.length - 1)]!;
    c.related = [a.term, b.term].filter((t) => t !== c.term).slice(0, 2);
  }
  const made = new Set<string>();
  for (const c of plan) {
    await mkdir(join(root, c.dir), { recursive: true });
    const target = randInt(c.size[0], c.size[1]);
    const fm = [
      "---",
      `type: "${c.type}"`,
      `title: "${c.term}"`,
      `description: "Definition and governance rules for ${c.term}."`,
      `tags: ["${c.dir}", "${c.term.split("_")[0]}"]`,
      "---",
      "",
    ].join("\n");
    await writeFile(join(root, c.dir, `${c.term}.md`), fm + bodyFor(c.term, c.type, target, c.related), "utf8");
    made.add(`${c.dir}/${c.term}`);
  }
}

// ---------- message scaffolding (SDK-shaped, mirrors tests) ----------

const SID_S0 = "bench-s0";
const SID_S1 = "bench-s1";
const SID_S2 = "bench-s2";
const REPLY = "Based on the knowledge base: this concept is governed by the retail-credit data governance rules; " +
  "the definition, owner and refresh cadence are as loaded above. I will apply them to the task as requested. " +
  "(Representative assistant answer body, ~330 chars, identical across strategies so it never biases the comparison.)";

function userMsg(sessionID: string, text: string): { info: Message; parts: Part[] } {
  return {
    info: { id: "u" + Math.random(), sessionID, role: "user", time: { created: 0 }, agent: "a", model: { providerID: "p", modelID: "m" } },
    parts: [{ id: "pt", sessionID, messageID: "u", type: "text", text }],
  };
}

function assistantMsg(sessionID: string, parts: Part[]): { info: Message; parts: Part[] } {
  return {
    info: { id: "a" + Math.random(), sessionID, role: "assistant", time: { created: 0, completed: 0 }, parentID: "u", modelID: "m", providerID: "p", mode: "default", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, path: { cwd: "/", root: "/" } },
    parts,
  };
}

function toolPart(sessionID: string, tool: string, input: Record<string, unknown>, output: string): Part {
  const st: ToolStateCompleted = { status: "completed", input, output, title: tool, metadata: {}, time: { start: 0, end: 0 } };
  return { id: "tp" + Math.random(), sessionID, messageID: "a", type: "tool", callID: "c" + Math.random(), tool, state: st };
}

function contextBytes(messages: Array<{ info: Message; parts: Part[] }>): number {
  let n = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && p.state?.status === "completed") n += (p.state as ToolStateCompleted).output.length;
      else if (p.type === "text") n += p.text.length;
    }
  }
  return n;
}

// ---------- python baseline (real subprocess) ----------

const PY = resolve(import.meta.dir, "baseline_reader.py");

async function pySearch(root: string, term: string): Promise<{ out: string; ms: number }> {
  const t0 = performance.now();
  const proc = Bun.spawn(["python3", PY, "search", root, term], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return { out, ms: performance.now() - t0 };
}

// ---------- simulation ----------

interface ToolCall { tool: string; input: Record<string, unknown>; output: string; }
interface TurnPlan { userText: string; calls: ToolCall[]; diskReadChars: number; }

interface StrategyResult {
  name: string;
  systemChars: number;
  trajectory: number[]; // per-turn context chars (incl. system)
  cumulative: number;
  peak: number;
  final: number;
  toolCalls: number;
  diskReadChars: number;
  retrievalMsAvg: number;
}

function replay(
  plan: TurnPlan[],
  opts: { system: string; cfg?: OkfConfig; bundles: Bundle[]; sessionID: string },
): StrategyResult {
  const history: Array<{ info: Message; parts: Part[] }> = [];
  const trajectory: number[] = [];
  let toolCalls = 0;
  let diskReadChars = 0;
  for (const turn of plan) {
    history.push(userMsg(opts.sessionID, turn.userText));
    if (turn.calls.length > 0) {
      history.push(assistantMsg(opts.sessionID, turn.calls.map((c) => toolPart(opts.sessionID, c.tool, c.input, c.output))));
      toolCalls += turn.calls.length;
      diskReadChars += turn.diskReadChars;
    }
    history.push(assistantMsg(opts.sessionID, [{ id: "pt2", sessionID: opts.sessionID, messageID: "a2", type: "text", text: REPLY }]));
    // Per-turn measurement. With the plugin (S2) the transform runs on a fresh copy of
    // the history on every request — exactly the live behavior.
    let snapshot = history;
    if (opts.cfg) {
      snapshot = structuredClone(history);
      transformOutbound({ messages: snapshot }, opts.cfg, opts.bundles, opts.sessionID);
    }
    trajectory.push(contextBytes(snapshot) + opts.system.length);
  }
  const final = trajectory[trajectory.length - 1] ?? 0;
  return {
    name: "",
    systemChars: opts.system.length,
    trajectory,
    cumulative: trajectory.reduce((a, b) => a + b, 0),
    peak: Math.max(...trajectory, 0),
    final,
    toolCalls,
    diskReadChars,
    retrievalMsAvg: 0,
  };
}

// ---------- main ----------

const TMP = await mkdtemp(join(tmpdir(), "okf-bench-"));
try {
  let root: string;
  let bundleName: string;
  let targets: Array<{ id: string; term: string; relPath: string; sizeChars: number }>;

  if (FIXTURE_IDX !== -1) {
    root = resolve(process.cwd(), args[FIXTURE_IDX + 1]!);
    bundleName = "unload-bundle";
  } else {
    root = join(TMP, "bank-kb");
    await generateBundle(root);
    bundleName = "bank-kb";
  }

  const bundles = await discoverBundles({
    projectRoot: TMP,
    scan: false,
    maxDepth: 4,
    configured: [{ path: root, name: bundleName }],
  });
  const bundle = bundles[0];
  if (!bundle) throw new Error(`bundle not discovered at ${root}`);

  // Bundle stats + question targets (deterministic).
  let totalChars = 0;
  const concepts: Concept[] = [...bundle.concepts.values()];
  for (const c of concepts) totalChars += c.body.length;
  if (FIXTURE_IDX !== -1) {
    const pool = concepts
      .filter((c) => c.id.startsWith("glossary/") || c.id.startsWith("metrics/"))
      .sort((a, b) => a.id.localeCompare(b.id));
    targets = pool.slice(0, N_QUESTIONS).map((c) => ({
      id: c.id,
      term: c.id.split("/")[1]!,
      relPath: c.relPath,
      sizeChars: c.body.length,
    }));
  } else {
    const shuffled = [...concepts].sort((a, b) => a.id.localeCompare(b.id));
    const step = Math.max(1, Math.floor(shuffled.length / N_QUESTIONS));
    targets = Array.from({ length: Math.min(N_QUESTIONS, shuffled.length) }, (_, i) => {
      const c = shuffled[i * step % shuffled.length]!;
      return { id: c.id, term: c.title ?? c.id.split("/")[1]!, relPath: c.relPath, sizeChars: c.body.length };
    });
  }
  if (targets.length === 0) throw new Error("no question targets found");

  const opCtx: OpCtx = { cfg: DEFAULT_CONFIG, bundles, projectDir: TMP, syntax: "tool" };
  const manifest = renderManifest(bundles, DEFAULT_CONFIG.disclosure.maxManifestChars);

  // Realistic skill doc that the baseline keeps in context (typical SKILL.md size).
  const SKILL_DOC = [
    "# Knowledge base skill",
    "",
    "When the user asks about a business concept, metric, table or policy:",
    "1. Run `python3 baseline_reader.py search <kb-root> <term>` to find matching docs.",
    "2. Read the relevant files with `python3 baseline_reader.py read <kb-root> <relpath>`.",
    "3. Answer from the file contents; quote the definition verbatim when possible.",
    "",
    "The knowledge base root is provided by the user or discovered from the repo layout.",
    "Do not guess definitions — always read the file first.",
  ].join("\n");

  // ---- Build the per-strategy turn plans with REAL outputs ----
  const questions = targets.map((t) => ({
    text: `What is ${t.term}? Check the knowledge base before answering.`,
    target: t,
  }));

  // S0: skill + python script (search output + cat target + first wrong hit)
  const s0Plan: TurnPlan[] = [];
  const s0IdealDisk: number[] = [];
  let s0SearchMs: number[] = [];
  let s0ScannedPerSearch = 0;
  for (const q of questions) {
    const { out, ms } = await pySearch(root, q.target.term);
    s0SearchMs.push(ms);
    const hits = out
      .split("\n")
      .filter((l) => l.includes(".md:"))
      .map((l) => l.slice(0, l.indexOf(":")));
    const wrong = hits.find((h) => h !== q.target.relPath);
    const calls: ToolCall[] = [
      { tool: "python", input: { cmd: `search ${q.target.term}` }, output: out },
    ];
    let disk = totalChars; // the script scans the whole tree per search
    const readFile = async (rel: string) => Bun.file(join(root, rel)).text();
    calls.push({ tool: "python", input: { cmd: `read ${q.target.relPath}` }, output: await readFile(q.target.relPath) });
    disk += q.target.sizeChars;
    if (wrong) {
      const wrongText = await readFile(wrong);
      calls.push({ tool: "python", input: { cmd: `read ${wrong}` }, output: wrongText });
      disk += wrongText.length;
    }
    s0Plan.push({ userText: q.text, calls, diskReadChars: disk });
    s0IdealDisk.push(q.target.sizeChars);
    s0ScannedPerSearch += totalChars;
  }

  // S0-ideal: no search output, exactly the right file cat'ed (lower bound).
  const s0iPlan: TurnPlan[] = [];
  for (const q of questions) {
    const text = await Bun.file(join(root, q.target.relPath)).text();
    s0iPlan.push({
      userText: q.text,
      calls: [{ tool: "python", input: { cmd: `read ${q.target.relPath}` }, output: text }],
      diskReadChars: q.target.sizeChars,
    });
  }

  // S1/S2: plugin progressive disclosure (search metadata-first + read the concept).
  const s12Plan: TurnPlan[] = [];
  let pluginSearchMs: number[] = [];
  for (const q of questions) {
    const t0 = performance.now();
    const searchOut = await searchOp(opCtx, { query: q.target.term, bundle: bundleName, maxResults: 10 });
    pluginSearchMs.push(performance.now() - t0);
    const readOut = await readOp(opCtx, { id: q.target.id, bundle: bundleName }, { footer: "plugin" });
    s12Plan.push({
      userText: q.text,
      calls: [
        { tool: "okf_search", input: { query: q.target.term, bundle: bundleName }, output: searchOut },
        { tool: "okf_read", input: { id: q.target.id, bundle: bundleName }, output: readOut },
      ],
      diskReadChars: 0, // bundle already in memory after one-time discovery
    });
  }

  // Interleave: question turns at odd positions, plain turns between.
  function interleave(qs: TurnPlan[]): TurnPlan[] {
    const out: TurnPlan[] = [];
    for (const q of qs) {
      out.push(q);
      out.push({ userText: "好的，继续下一个问题。", calls: [], diskReadChars: 0 });
    }
    return out;
  }

  const cfgNoUnload: OkfConfig = {
    ...DEFAULT_CONFIG,
    unload: { ...DEFAULT_CONFIG.unload, enabled: false },
    nudge: { ...DEFAULT_CONFIG.nudge, enabled: false },
  };

  const results: StrategyResult[] = [
    { ...replay(interleave(s0Plan), { system: SKILL_DOC, bundles, sessionID: SID_S0 }), name: "S0  skill+Python 脚本（现实）" },
    { ...replay(interleave(s0iPlan), { system: SKILL_DOC, bundles, sessionID: SID_S0 + "i" }), name: "S0i 脚本·理想下界（只读对文件）" },
    { ...replay(interleave(s12Plan), { system: manifest, bundles, sessionID: SID_S1 }), name: "S1  插件·渐进披露（不卸载）" },
    { ...replay(interleave(s12Plan), { system: manifest, cfg: DEFAULT_CONFIG, bundles, sessionID: SID_S2 }), name: "S2  插件·渐进披露+自动卸载（默认配置）" },
  ];
  results[0]!.retrievalMsAvg = avg(s0SearchMs);
  results[3]!.retrievalMsAvg = avg(pluginSearchMs);

  // ---- report ----
  const tok = (chars: number) => Math.round(chars / 4);
  const lines: string[] = [];
  lines.push(`# 压测结果 (${new Date().toISOString().slice(0, 10)})`);
  lines.push("");
  lines.push(`- 数据集: ${FIXTURE_IDX !== -1 ? `真实 fixture (${root})` : `合成行内风格 bundle (${N_CONCEPTS} concepts, seed=${SEED})`}`);
  lines.push(`- 概念数: ${bundle.concepts.size}，正文总字符: ${fmt(totalChars)}`);
  lines.push(`- 会话: ${questions.length} 个问题 + ${questions.length} 个普通轮 = ${questions.length * 2} 个用户轮`);
  lines.push(`- 卸载配置: afterTurns=${DEFAULT_CONFIG.unload.afterTurns}, keepRecent=${DEFAULT_CONFIG.unload.keepRecent}, nudge=${DEFAULT_CONFIG.nudge.threshold}`);
  lines.push("");
  lines.push("| 策略 | 期末上下文(chars) | 峰值 | 累计输入 | 工具调用 | 检索均延迟 |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(`| ${r.name} | ${fmt(r.final)} (~${fmt(tok(r.final))} tok) | ${fmt(r.peak)} | ${fmt(r.cumulative)} (~${fmt(tok(r.cumulative))} tok) | ${r.toolCalls} | ${r.retrievalMsAvg ? r.retrievalMsAvg.toFixed(0) + "ms" : "-"} |`);
  }
  lines.push("");
  lines.push("## 每轮上下文轨迹 (chars, 含 system)");
  lines.push("");
  lines.push("| turn | " + results.map((r) => r.name).join(" | ") + " |");
  lines.push("|---|" + results.map(() => "---").join("|") + "|");
  const n = results[0]!.trajectory.length;
  for (let i = 0; i < n; i++) {
    lines.push(`| ${i + 1} | ` + results.map((r) => fmt(r.trajectory[i]!)).join(" | ") + " |");
  }
  lines.push("");
  const s0 = results[0]!, s2 = results[3]!;
  lines.push(`## 结论数字`);
  lines.push(`- S2 期末上下文是 S0(现实) 的 **${(s0.final / s2.final).toFixed(1)}x** 缩减；累计输入（计费/延迟口径）是 **${(s0.cumulative / s2.cumulative).toFixed(1)}x** 缩减。`);
  lines.push(`- 磁盘扫描: 脚本方式每次检索全树扫描 ${fmt(totalChars)} chars（${questions.length} 次 ≈ ${fmt(s0ScannedPerSearch)}）；插件一次性加载后检索 0 额外读盘。`);
  const report = lines.join("\n") + "\n";
  await writeFile(resolve(import.meta.dir, "results.md"), report, "utf8");
  console.log(report);
  console.log("(written to benchmark/results.md)");
} finally {
  await rm(TMP, { recursive: true, force: true });
}

// ---------- utils ----------

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
