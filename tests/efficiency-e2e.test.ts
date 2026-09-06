/**
 * Live LLM efficiency test (opt-in, real API cost): end-to-end cost for an agent to
 * ANSWER one knowledge question through the plugin's tools vs generic file tools.
 *
 *   OKF_EFF_E2E=1 bun test tests/efficiency-e2e.test.ts
 *
 * Per question (verbatim-quote probe, guess-proof — same construction as
 * tests/reload-e2e.test.ts), fresh single-turn session per arm×question:
 *   plugin arm — normal run: okf_search (metadata) → okf_read
 *   skill arm  — `--pure` (plugin off): the agent must find the KB and the sentence
 *                with generic glob/grep/read (the "skill + file tools" reality)
 *
 * Measured per arm: wall seconds, tool calls, tool-output chars entering context
 * (deduped by part id), and answer accuracy.
 */
import { test, expect, describe } from "bun:test";
import { join, resolve } from "node:path";
import { discoverBundles } from "../src/discovery.js";
import type { Concept } from "../src/types.js";

const PROJECT = resolve(import.meta.dir, "..");
const E2E = process.env.OKF_EFF_E2E === "1";
const QUESTIONS = 4;

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

interface RunResult {
  arm: string;
  id: string;
  seconds: number;
  calls: number;
  outputChars: number;
  answered: boolean;
  toolNames: string[];
}

async function runOnce(arm: string, pure: boolean, x: Concept): Promise<RunResult> {
  const fact = sentenceFact(x)!;
  const msg = `Find the sentence in the document "${x.title ?? x.id}" that mentions: ${fact.topic}. Quote that sentence exactly, verbatim, in double quotes.`;
  const cli = ["opencode", "run", "--format", "json"];
  if (pure) cli.push("--pure");
  cli.push(msg);
  const t0 = performance.now();
  const proc = Bun.spawn(cli, { cwd: PROJECT, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  const seconds = (performance.now() - t0) / 1000;
  if (exit !== 0) throw new Error(`opencode run failed (exit ${exit})`);
  let calls = 0;
  let outputChars = 0;
  let text = "";
  const names: string[] = [];
  const seen = new Map<string, number>(); // part id -> max output length (tool_use events repeat per status)
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "tool_use") {
      const id = String(ev.part?.id ?? "");
      const len = String(ev.part?.state?.output ?? "").length;
      if (id && !seen.has(id)) {
        seen.set(id, len);
        calls++;
        names.push(String(ev.part?.tool ?? "?"));
      } else if (id && len > (seen.get(id) ?? 0)) {
        seen.set(id, len);
      }
    }
    if (ev.type === "text") text += ev.part?.text ?? "";
  }
  outputChars = [...seen.values()].reduce((a, b) => a + b, 0);
  return {
    arm,
    id: x.id,
    seconds,
    calls,
    outputChars,
    answered: text.toLowerCase().includes(fact.window.toLowerCase()),
    toolNames: names,
  };
}

describe("E2E read efficiency (OKF_EFF_E2E=1)", () => {
  test(
    "plugin reads answer knowledge questions cheaper than generic file tools",
    async () => {
      if (!E2E) {
        console.log("[skip] set OKF_EFF_E2E=1 to run the live read-efficiency test");
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
      expect(pool.length).toBeGreaterThanOrEqual(QUESTIONS);
      const targets = pool.slice(0, QUESTIONS);

      const results: RunResult[] = [];
      for (const x of targets) results.push(await runOnce("plugin", false, x));
      for (const x of targets) results.push(await runOnce("skill", true, x));

      for (const r of results) {
        console.log(`[eff] ${r.arm.padEnd(6)} ${r.id.padEnd(24)} ${r.seconds.toFixed(1)}s calls=${r.calls} outChars=${r.outputChars} answer=${r.answered ? "Y" : "n"} [${r.toolNames.join(",") || "none"}]`);
      }
      const avg = (arm: string, key: "seconds" | "calls" | "outputChars") => {
        const rows = results.filter((r) => r.arm === arm);
        return rows.reduce((a, r) => a + r[key], 0) / rows.length;
      };
      const acc = (arm: string) => `${results.filter((r) => r.arm === arm && r.answered).length}/${results.filter((r) => r.arm === arm).length}`;
      console.log(`\n=== plugin: ${avg("plugin", "seconds").toFixed(1)}s/题, ${avg("plugin", "calls").toFixed(1)} 调用, ${avg("plugin", "outputChars").toFixed(0)} chars/题, 答对 ${acc("plugin")} ===`);
      console.log(`=== skill : ${avg("skill", "seconds").toFixed(1)}s/题, ${avg("skill", "calls").toFixed(1)} 调用, ${avg("skill", "outputChars").toFixed(0)} chars/题, 答对 ${acc("skill")} ===\n`);

      // Gates: both arms should mostly answer (capability), plugin should not be slower.
      const plugOk = results.filter((r) => r.arm === "plugin" && r.answered).length;
      const skillOk = results.filter((r) => r.arm === "skill" && r.answered).length;
      expect(plugOk).toBeGreaterThanOrEqual(Math.ceil(QUESTIONS / 2));
      expect(skillOk).toBeGreaterThanOrEqual(Math.ceil(QUESTIONS / 2));
      expect(avg("plugin", "outputChars")).toBeLessThanOrEqual(avg("skill", "outputChars"));
    },
    1_200_000, // 20 min ceiling: 2 arms x 4 questions, single turn each
  );

  test("suite is opt-in (skipped unless OKF_EFF_E2E=1)", () => {
    expect(E2E).toBe(process.env.OKF_EFF_E2E === "1");
  });
});
