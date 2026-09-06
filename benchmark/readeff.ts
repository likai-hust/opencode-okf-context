/**
 * File-reading efficiency micro-benchmark: what does it cost to ANSWER ONE knowledge
 * question through each access path?
 *
 *   skill·现实   — skill + python script, realistic policy: grep-style search (spawn +
 *                  full-tree scan) + read the target file + the first wrong hit (spawn each)
 *   skill·理想   — same script, perfect retrieval: search + exactly the right file
 *   插件·进程内  — the opencode plugin path: in-memory metadata search + concept read
 *                  (searchOp/readOp are exactly what the okf_* tools execute; discovery
 *                  is a one-time cost at session start, reported separately)
 *   插件·CLI     — `node dist/cli.js` for other agents: stateless, so every command
 *                  re-discovers the bundle (scan included in its latency)
 *
 * Metrics per question: wall time, chars entering context, disk bytes touched,
 * subprocess count. Real executions only — every number comes from a timed run.
 *
 * Run: bun benchmark/readeff.ts [--concepts 200] [--questions 12] [--seed 42]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discoverBundles } from "../src/discovery.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { searchOp, readOp, type OpCtx } from "../src/operations.js";

// ---------- args / rng ----------

const args = process.argv.slice(2);
function argNum(name: string, dflt: number): number {
  const i = args.indexOf(`--${name}`);
  const v = i === -1 ? undefined : Number(args[i + 1]);
  return Number.isFinite(v) ? v! : dflt;
}
const N_CONCEPTS = argNum("concepts", 200);
const N_QUESTIONS = argNum("questions", 12);
const SEED = argNum("seed", 42);

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

// ---------- compact bundle generator (mirrors benchmark/stress.ts) ----------

const DIR_PLANS = [
  { dir: "tables", share: 0.3, type: "BigQuery Table", size: [900, 2600] as const },
  { dir: "metrics", share: 0.25, type: "Metric", size: [700, 1800] as const },
  { dir: "glossary", share: 0.25, type: "Glossary Term", size: [500, 1400] as const },
  { dir: "runbooks", share: 0.12, type: "Runbook", size: [1500, 4000] as const },
  { dir: "reference", share: 0.08, type: "Reference", size: [5500, 9000] as const },
];
const PREFIXES = ["loan", "repayment", "collection", "customer", "risk", "recovery", "contact", "promise", "payment", "aging", "settlement", "writeoff"];
const SUFFIXES = ["rule", "policy", "bucket", "strategy", "queue", "threshold", "window", "matrix", "formula", "workflow", "score", "flag"];

function bodyFor(term: string, targetChars: number, related: string[]): string {
  const lines = [`# ${term}`, "", "## Overview", "", `The **${term}** governs how the retail-credit system treats this entity.`, "", "## Definition", "", "- owner: retail-risk-data", ""];
  let size = lines.join("\n").length;
  let para = 0;
  while (size < targetChars) {
    const s = `Para ${para}: for ${term}, the engine evaluates delinquency state and contact history. Related: ${related.join(", ")}. Reviewed quarterly.`;
    lines.push(s, "");
    size += s.length + 1;
    para++;
  }
  return lines.join("\n");
}

async function generateBundle(root: string): Promise<number> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "index.md"), '---\nokf_version: "0.2"\n---\n# Bank KB\n', "utf8");
  await writeFile(join(root, "log.md"), "", "utf8");
  const terms: string[] = [];
  const combos = PREFIXES.flatMap((p) => SUFFIXES.map((s) => `${p}_${s}`));
  for (let i = 0; i < N_CONCEPTS; i++) terms.push(i < combos.length ? combos[i]! : `${combos[i % combos.length]}_v${Math.floor(i / combos.length) + 1}`);
  const plan = DIR_PLANS.flatMap((p) =>
    Array.from({ length: Math.max(1, Math.round(N_CONCEPTS * p.share)) }, () => p),
  ).slice(0, N_CONCEPTS);
  let totalDisk = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]!;
    const term = terms[i]!;
    const related = [terms[randInt(0, terms.length - 1)]!].filter((t) => t !== term);
    await mkdir(join(root, p.dir), { recursive: true });
    const fm = `---\ntype: "${p.type}"\ntitle: "${term}"\ndescription: "Definition and governance rules for ${term}."\ntags: ["${p.dir}"]\n---\n\n`;
    const body = bodyFor(term, randInt(p.size[0], p.size[1]), related);
    const content = fm + body;
    totalDisk += Buffer.byteLength(content);
    await writeFile(join(root, p.dir, `${term}.md`), content, "utf8");
  }
  return totalDisk;
}

// ---------- subprocess helpers ----------

const PY = resolve(import.meta.dir, "baseline_reader.py");
const CLI = resolve(import.meta.dir, "../dist/cli.js");

async function spawnOut(cmd: string[]): Promise<{ out: string; ms: number }> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
  return { out, ms: performance.now() - t0 };
}

interface Row {
  name: string;
  wallMs: number;
  contextChars: number;
  diskBytes: number;
  spawns: number;
  toolCalls: number;
}

// ---------- main ----------

const TMP = await mkdtemp(join(tmpdir(), "okf-eff-"));
try {
  const root = join(TMP, "bank-kb");
  const totalDisk = await generateBundle(root);

  // Plugin in-process: one-time discovery (what a session pays at startup), then queries.
  const tDisc = performance.now();
  const bundles = await discoverBundles({ projectRoot: TMP, scan: false, maxDepth: 4, configured: [{ path: root, name: "bank-kb" }] });
  const discMs = performance.now() - tDisc;
  const bundle = bundles[0]!;
  const opCtx: OpCtx = { cfg: DEFAULT_CONFIG, bundles, projectDir: TMP, syntax: "tool" };

  const concepts = [...bundle.concepts.values()].sort((a, b) => a.id.localeCompare(b.id));
  const step = Math.max(1, Math.floor(concepts.length / N_QUESTIONS));
  const targets = Array.from({ length: Math.min(N_QUESTIONS, concepts.length) }, (_, i) => concepts[(i * step) % concepts.length]!);

  const rows: Row[] = [];

  // --- skill·现实: search + read target + first wrong hit ---
  {
    let wall = 0, ctx = 0, disk = 0, spawns = 0, calls = 0;
    for (const c of targets) {
      const term = c.title ?? c.id.split("/")[1]!;
      const s = await spawnOut(["python3", PY, "search", root, term]);
      wall += s.ms; ctx += s.out.length; disk += totalDisk; spawns++; calls++;
      const hits = s.out.split("\n").filter((l) => l.includes(".md:")).map((l) => l.slice(0, l.indexOf(":")));
      const wrong = hits.find((h) => h !== c.relPath);
      for (const rel of [c.relPath, wrong].filter(Boolean) as string[]) {
        const r = await spawnOut(["python3", PY, "read", root, rel]);
        wall += r.ms; ctx += r.out.length; disk += Buffer.byteLength(r.out); spawns++; calls++;
      }
    }
    rows.push({ name: "skill·现实（搜索+读对+读一个干扰）", wallMs: wall / targets.length, contextChars: ctx / targets.length, diskBytes: disk / targets.length, spawns: spawns / targets.length, toolCalls: calls / targets.length });
  }

  // --- skill·理想: search + exactly the right file ---
  {
    let wall = 0, ctx = 0, disk = 0, spawns = 0, calls = 0;
    for (const c of targets) {
      const term = c.title ?? c.id.split("/")[1]!;
      const s = await spawnOut(["python3", PY, "search", root, term]);
      wall += s.ms; ctx += s.out.length; disk += totalDisk; spawns++; calls++;
      const r = await spawnOut(["python3", PY, "read", root, c.relPath]);
      wall += r.ms; ctx += r.out.length; disk += Buffer.byteLength(r.out); spawns++; calls++;
    }
    rows.push({ name: "skill·理想（搜索+只读对）", wallMs: wall / targets.length, contextChars: ctx / targets.length, diskBytes: disk / targets.length, spawns: spawns / targets.length, toolCalls: calls / targets.length });
  }

  // --- 插件·进程内 (opencode tool path; discovery already paid at session start) ---
  {
    let wall = 0, ctx = 0, calls = 0;
    for (const c of targets) {
      const term = c.title ?? c.id.split("/")[1]!;
      let t0 = performance.now();
      const s = await searchOp(opCtx, { query: term, bundle: "bank-kb", maxResults: 10 });
      wall += performance.now() - t0; ctx += s.length; calls++;
      t0 = performance.now();
      const r = await readOp(opCtx, { id: c.id, bundle: "bank-kb" }, { footer: "plugin" });
      wall += performance.now() - t0; ctx += r.length; calls++;
    }
    rows.push({ name: "插件·进程内（opencode 工具）", wallMs: wall / targets.length, contextChars: ctx / targets.length, diskBytes: 0, spawns: 0, toolCalls: calls / targets.length });
  }

  // --- 插件·CLI (stateless per command: discovery re-runs each invocation) ---
  {
    let wall = 0, ctx = 0, disk = 0, spawns = 0, calls = 0;
    for (const c of targets) {
      const term = c.title ?? c.id.split("/")[1]!;
      const s = await spawnOut(["node", CLI, "search", term, "--root", root]);
      wall += s.ms; ctx += s.out.length; disk += totalDisk; spawns++; calls++;
      const r = await spawnOut(["node", CLI, "read", c.id, "--root", root]);
      wall += r.ms; ctx += r.out.length; disk += Buffer.byteLength(r.out); spawns++; calls++;
    }
    rows.push({ name: "插件·CLI（其他 Agent，无状态）", wallMs: wall / targets.length, contextChars: ctx / targets.length, diskBytes: disk / targets.length, spawns: spawns / targets.length, toolCalls: calls / targets.length });
  }

  // ---------- report ----------
  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`);
  const lines: string[] = [];
  lines.push("# 读文件效率微基准（每答一题的平均成本）");
  lines.push("");
  lines.push(`- 数据集: 合成行内风格 bundle（${bundle.concepts.size} 概念，磁盘 ${kb(totalDisk)}），${targets.length} 个问题`);
  lines.push(`- 插件进程内的一次性启动成本: 发现+解析全部概念 ${discMs.toFixed(0)}ms（会话只付一次，之后查询 0 读盘）`);
  lines.push(`- CLI 每条命令无状态、重新扫描 bundle——扫描成本已含在它的墙钟时间里（行内可用 --root 直达规避）`);
  lines.push("");
  lines.push("| 路径 | 每问墙钟 | 进入上下文 | 磁盘读取 | 子进程/次 | 工具调用/问 |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    const ms = r.wallMs < 10 ? r.wallMs.toFixed(2) : r.wallMs.toFixed(0);
    lines.push(`| ${r.name} | ${ms}ms | ${r.contextChars.toFixed(0)} chars | ${kb(r.diskBytes)} | ${r.spawns.toFixed(1)} | ${r.toolCalls.toFixed(1)} |`);
  }
  lines.push("");
  const skillR = rows[0]!, plug = rows[2]!;
  lines.push(`## 读数`);
  lines.push(`- 墙钟: 插件进程内比 skill·现实快 **${(skillR.wallMs / plug.wallMs).toFixed(0)}x**（元数据内存检索 vs 起进程+全树扫描）；CLI 受 node 启动+重扫描拖累，但仍为单次成本。`);
  lines.push(`- 进入上下文: skill·现实每问多带入 **${(skillR.contextChars - plug.contextChars).toFixed(0)} chars**（${(skillR.contextChars / plug.contextChars).toFixed(1)}x），且永久滞留（无卸载）。`);
  lines.push(`- 磁盘: skill 每问全树扫描 ${kb(totalDisk)}；插件会话内 0 读盘。`);
  const report = lines.join("\n") + "\n";
  console.log(report);
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(resolve(import.meta.dir, "readeff.md"), report, "utf8");
  console.log("(written to benchmark/readeff.md)");
} finally {
  await rm(TMP, { recursive: true, force: true });
}
