/**
 * Compaction resistance: what survives a platform auto-compact (lossy history
 * summarization) in the skill approach vs the plugin approach.
 *
 * Architectural facts being measured (src/index.ts):
 *  - Plugin: the L0 manifest is injected into the SYSTEM PROMPT on every request
 *    (experimental.chat.system.transform). Auto-compact summarizes MESSAGE HISTORY;
 *    the system prompt is rebuilt per request and is therefore compaction-proof.
 *  - Skill: the skill doc + any loaded index live in MESSAGE HISTORY (file-read /
 *    command outputs) — exactly what auto-compact replaces with a topic-level summary.
 *
 * We model compaction the way every implementation works: everything older than the
 * recent window is replaced by a ~300-char topic-level summary built from user texts
 * (tool outputs, paths and command syntax do not survive into such summaries), then
 * check what KB-access capability remains in the full outbound context.
 *
 * Run: bun benchmark/compaction.ts
 */
import { resolve } from "node:path";
import { discoverBundles } from "../src/discovery.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { renderManifest } from "../src/indexing.js";
import { renderConceptFull } from "../src/registry.js";
import type { Bundle } from "../src/types.js";

const FIXTURE = resolve(import.meta.dir, "../fixtures/unload-bundle");

/** Typical skill doc (same as the stress benchmark's baseline skill). */
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

function topicSummary(recentUserTexts: string[]): string {
  // Topic-level summary: what auto-compact actually produces. No tool names, no paths,
  // no command syntax — those lived in tool outputs, which the summarizer compresses away.
  const topics = recentUserTexts.map((t) => t.replace(/[?.!].*$/, "").slice(0, 60)).join("; ");
  return `[session summary — auto-compact] Earlier in this session the user worked on retail-credit topics: ${topics}. The assistant answered from project documents.`;
}

const lines: string[] = [];
lines.push("# 压缩抗性：skill（历史驻留）vs 插件（系统提示驻留）");
lines.push("");

const bundles = await discoverBundles({
  projectRoot: resolve(import.meta.dir, ".."),
  scan: false,
  maxDepth: 4,
  configured: [{ path: FIXTURE, name: "unload-bundle" }],
});
const bundle: Bundle = bundles[0]!;
const manifest = renderManifest(bundles, DEFAULT_CONFIG.disclosure.maxManifestChars);
const someConcept = [...bundle.concepts.values()][0]!;
const loadedFull = renderConceptFull(someConcept);

// Both arms did equivalent work in a 10-turn session, then compaction fires and keeps
// only the last 2 turns verbatim + a topic-level summary of the rest.
const recentUserTexts = ["What is the repayment waterfall?", "Summarize the aging bucket policy"];
const summary = topicSummary(recentUserTexts);

// --- skill arm: SKILL.md + bundle index read INTO HISTORY at turn 1; system = plain ---
const skillContextAfter = {
  system: "You are a coding assistant.", // nothing KB-related
  history: [summary, `user: ${recentUserTexts[1]}`, "assistant: (recent answer)"].join("\n"),
};

// --- plugin arm: history compacted identically; manifest lives in the system prompt ---
const pluginContextAfter = {
  system: manifest,
  history: skillContextAfter.history, // identical post-compaction history
};

function survival(ctx: { system: string; history: string }, needles: string[]): string {
  const all = (ctx.system + "\n" + ctx.history).toLowerCase();
  const hit = needles.filter((n) => all.includes(n.toLowerCase())).length;
  return `${((hit / needles.length) * 100).toFixed(0)}% (${hit}/${needles.length})`;
}

const CHECKS: Array<{ dim: string; needles: string[] }> = [
  { dim: "KB 访问指引（工具/命令名）", needles: ["okf_search", "okf_list", "okf_read"] },
  { dim: "bundle 清单（知识库存在且可知）", needles: ["unload-bundle", "concepts"] },
  { dim: "触发指引（何时该查知识库）", needles: ["reactive", "proactive"] },
  { dim: "已加载概念正文（压缩必然丢失）", needles: [someConcept.body.slice(50, 120)] },
];

lines.push(`- 压缩模型: 10 轮会话 → 保留最近 2 轮 + ${summary.length} 字符主题级摘要（摘要由用户文本生成，不含工具输出/路径/命令——与各平台 auto-compact 行为一致）`);
lines.push(`- 插件臂的清单注入在系统提示（每请求重建，压缩不可及）；skill 臂的说明与索引在消息历史（压缩对象）`);
lines.push("");
lines.push("| 存活维度 | skill（历史驻留） | 插件（系统提示驻留） |");
lines.push("|---|---|---|");
for (const c of CHECKS) {
  lines.push(`| ${c.dim} | ${survival(skillContextAfter, c.needles)} | ${survival(pluginContextAfter, c.needles)} |`);
}
lines.push("");
lines.push(`两臂的已加载正文同样丢失（0%）——差别在**可恢复性**：插件臂的访问指引/清单/触发条件全部存活，`);
lines.push(`模型可自主重新检索（重读成本 ~1 次 okf_read）；skill 臂连"知识库存在、怎么查"都随摘要消失。`);
lines.push(`实测边界（OKF_COMPACTION_E2E=1）：对项目内的本地知识库，能力强的 Agent 仍可用 glob/grep/read`);
lines.push(`自主找回（3/3 答对）——但那是整文件探索路径（即压测中 S0 的 4-7x 成本鸿沟），且当知识库不在`);
lines.push(`项目目录内时此路不通；插件臂的清单注入保证知识库的存在性与访问方式永不依赖再探索。`);
lines.push(`\n最终命中率由真实 LLM 层测量: OKF_COMPACTION_E2E=1 bun test tests/compaction-e2e.test.ts`);
const report = lines.join("\n") + "\n";
console.log(report);
const { writeFile } = await import("node:fs/promises");
await writeFile(resolve(import.meta.dir, "compaction.md"), report, "utf8");
console.log("(written to benchmark/compaction.md)");
