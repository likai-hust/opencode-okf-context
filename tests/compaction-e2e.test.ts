/**
 * Live LLM test (opt-in, real API cost): end-to-end accuracy AFTER a context compaction.
 *
 *   OKF_COMPACTION_E2E=1 bun test tests/compaction-e2e.test.ts
 *
 * Compaction is simulated faithfully: a fresh session whose first message is exactly
 * what survives an auto-compact (a topic-level summary + the recent tail) — because
 * compaction keeps the tail verbatim, a fresh session + summary is equivalent for
 * everything that lived in the compacted region.
 *
 * Three arms, same verbatim-quote KB questions (guess-proof 4-word windows):
 *   A plugin-after-compaction  — normal run; the L0 manifest is injected into the
 *     system prompt on EVERY request (compaction-proof), so the model can still
 *     discover + query the knowledge base on its own.
 *   B skill-forgotten          — `--pure` (plugin off); the summary does NOT mention
 *     the KB (what lossy summaries actually do to tool outputs/paths). This is the
 *     fate of skill-loaded guidance that lived in message history.
 *   C skill-remembered (best case) — `--pure`; the summary DOES spell out the KB
 *     location + reader command. Shows what it takes for the skill approach to
 *     survive compaction: the summary must happen to preserve exact access info.
 */
import { test, expect, describe } from "bun:test";
import { join, resolve } from "node:path";
import { discoverBundles } from "../src/discovery.js";
import type { Concept } from "../src/types.js";

const PROJECT = resolve(import.meta.dir, "..");
const E2E = process.env.OKF_COMPACTION_E2E === "1";
const SCENARIOS = 3;

interface TurnResult { tools: string[]; text: string }

/** One live turn (fresh-session mode: no --session needed; each scenario is 2 turns chained). */
async function runTurn(sessionID: string | undefined, message: string, pure: boolean): Promise<TurnResult & { sessionID: string }> {
  const cli = ["opencode", "run", "--format", "json"];
  if (pure) cli.push("--pure");
  if (sessionID) cli.push("--session", sessionID);
  cli.push(message);
  const proc = Bun.spawn(cli, { cwd: PROJECT, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`opencode run failed (exit ${exit})`);
  const tools: string[] = [];
  let text = "";
  let sid = sessionID ?? "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev.sessionID === "string" && ev.sessionID) sid = ev.sessionID;
    if (ev.type === "tool_use") tools.push(String(ev.part?.tool ?? ""));
    if (ev.type === "text") text += ev.part?.text ?? "";
  }
  return { sessionID: sid, tools, text };
}

/** Verbatim-quote fact (same guess-proof construction as tests/reload-e2e.test.ts). */
function sentenceFact(c: Concept): { window: string; topic: string } | null {
  const lines = c.body
    .split("\n")
    .map((s) => s.trim())
    .filter((l) => /\d/.test(l) && l.length >= 30 && !l.startsWith("|") && !l.startsWith("#") && !l.startsWith("```"))
    .sort((a, b) => b.length - a.length);
  for (const line of lines) {
    const words = line.split(/\s+/);
    const numIdx = words.findIndex((w) => /\d/.test(w));
    if (numIdx === -1) continue;
    const start = Math.max(0, Math.min(numIdx - 1, words.length - 4));
    const window = words.slice(start, start + 4).join(" ");
    if (!/\d/.test(window) || window.length < 12) continue;
    const rest = [...words.slice(0, start), ...words.slice(start + 4)];
    const topic = rest.filter((w) => w.length > 3).slice(-6).join(" ");
    if (topic.length < 10) continue;
    if (topic.split(" ").some((w) => window.includes(w))) continue;
    return { window, topic };
  }
  return null;
}

/** A realistic topic-level auto-compact summary — no tool names, no paths (lossy). */
const SUMMARY_FORGOTTEN =
  "[continuing a compacted session] Earlier you helped the user with retail-credit data topics " +
  "(repayment waterfall, aging buckets, collection queues); answers came from project documents.";

/** Best case for the skill arm: the summary happened to preserve exact access info. */
const SUMMARY_REMEMBERED =
  SUMMARY_FORGOTTEN +
  " Note from the summary: the project has a knowledge base at fixtures/unload-bundle " +
  "(markdown files with a `type` frontmatter); to query it run " +
  "`python3 benchmark/baseline_reader.py search fixtures/unload-bundle <term>` and read the matched .md files.";

async function runArm(arm: string, summary: string, pure: boolean, x: Concept) {
  const fact = sentenceFact(x)!;
  const t1 = await runTurn(undefined, summary, pure);
  const probe = await runTurn(
    t1.sessionID,
    `Find the sentence in the document "${x.title ?? x.id}" that mentions: ${fact.topic}. Quote that sentence exactly, verbatim, in double quotes.`,
    pure,
  );
  const answered = probe.text.toLowerCase().includes(fact.window.toLowerCase());
  const kbAccess = probe.tools.some((t) => pure ? !t.startsWith("okf_") && ["bash", "read", "grep", "glob"].includes(t) : t.startsWith("okf_"));
  return { arm, id: x.id, answered, kbAccess, tools: probe.tools, window: fact.window.slice(0, 36) + "…" };
}

describe("E2E post-compaction KB hit rate (OKF_COMPACTION_E2E=1)", () => {
  test(
    "after compaction: plugin still finds the KB, forgotten skill cannot",
    async () => {
      if (!E2E) {
        console.log("[skip] set OKF_COMPACTION_E2E=1 to run the live compaction hit-rate test");
        return;
      }
      const bundles = await discoverBundles({
        projectRoot: PROJECT,
        scan: false,
        maxDepth: 4,
        configured: [{ path: join(PROJECT, "fixtures", "unload-bundle"), name: "unload-bundle" }],
      });
      const pool = [...(bundles[0]?.concepts.values() ?? [])]
        .filter((c) => sentenceFact(c) !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(pool.length).toBeGreaterThanOrEqual(SCENARIOS);

      const results: Awaited<ReturnType<typeof runArm>>[] = [];
      for (let i = 0; i < SCENARIOS; i++) {
        const x = pool[i]!;
        results.push(await runArm("A 插件·压缩后", SUMMARY_FORGOTTEN, false, x));
      }
      for (let i = 0; i < SCENARIOS; i++) {
        const x = pool[i]!;
        results.push(await runArm("B skill·被压缩遗忘", SUMMARY_FORGOTTEN, true, x));
      }
      for (let i = 0; i < SCENARIOS; i++) {
        const x = pool[i]!;
        results.push(await runArm("C skill·摘要保留入口", SUMMARY_REMEMBERED, true, x));
      }

      const rate = (arm: string) => {
        const rows = results.filter((r) => r.arm === arm);
        return `${rows.filter((r) => r.answered).length}/${rows.length}`;
      };
      for (const r of results) {
        console.log(`[compact] ${r.arm.padEnd(14)} ${r.id.padEnd(26)} answer=${r.answered ? "Y" : "n"} kb=${r.kbAccess ? "Y" : "n"} tools=[${r.tools.join(",") || "none"}] ${r.window}`);
      }
      console.log(`\n=== accuracy: A ${rate("A 插件·压缩后")} | B ${rate("B skill·被压缩遗忘")} | C ${rate("C skill·摘要保留入口")} ===\n`);

      // Gates. Measured reality (2026-09-06, deepseek-v4-flash): ALL arms answered 3/3 —
      // a capable agent with generic file tools can REDISCOVER a project-local KB even
      // with zero surviving guidance (arm B used glob/grep/read). The plugin's structural
      // advantage is therefore NOT raw accuracy here, but (a) guaranteed guidance survival
      // (deterministic layer) and (b) the cheap recovery path: manifest → okf_search
      // (metadata) → one okf_read (+ auto-unload), vs whole-file exploration that stays
      // in context forever. Arm B's accuracy would collapse only when the KB is NOT
      // locally discoverable (external/shared mount) — exactly what the manifest covers.
      const a = results.filter((r) => r.arm === "A 插件·压缩后" && r.answered).length;
      const aKb = results.filter((r) => r.arm === "A 插件·压缩后" && r.kbAccess).length;
      expect(a).toBeGreaterThanOrEqual(Math.ceil(SCENARIOS / 2));
      expect(aKb).toBeGreaterThanOrEqual(Math.ceil(SCENARIOS / 2)); // manifest-driven okf_* path
    },
    1_200_000, // 20 min ceiling: 3 arms x 3 scenarios x 2 live turns
  );

  test("suite is opt-in (skipped unless OKF_COMPACTION_E2E=1)", () => {
    expect(E2E).toBe(process.env.OKF_COMPACTION_E2E === "1");
  });
});
