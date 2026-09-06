/**
 * Live LLM test (opt-in, real API cost): does auto-unload break follow-up questions,
 * and does the placeholder's reload hint actually recover the information?
 *
 *   OKF_RELOAD_E2E=1 bun test tests/reload-e2e.test.ts
 *
 * Per scenario (concepts from fixtures/unload-bundle that contain a numeric body fact):
 *   turn 1: load X via okf_read ┐ later reads push X out of keepRecent=2 and
 *   turn 2: load Y              ┘ filler turns age it past afterTurns=4, so by the
 *   turn 3: load Z                probe X's full text is deterministically unloaded
 *   turn 4-6: "Reply with just OK"
 *   turn 7  (probe): neutral numeric question about X — no reload invitation
 *
 * Two arms:
 *   treatment — default config (auto-unload ON, the shipped product behavior)
 *   control   — unload disabled via a temporary .opencode/okf.jsonc (full text retained)
 *
 * The deterministic layer (benchmark/hitrate.ts) proved body facts are 0% answerable
 * from the placeholder alone, so a correct treatment answer requires the model to
 * follow the placeholder's reload hint — this test measures whether it does.
 */
import { test, expect, describe } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discoverBundles } from "../src/discovery.js";
import type { Concept } from "../src/types.js";

const PROJECT = resolve(import.meta.dir, "..");
const FIXTURE = join(PROJECT, "fixtures", "unload-bundle");
const E2E = process.env.OKF_RELOAD_E2E === "1";
const SCENARIOS = 3;

/** One live turn. `sessionID` undefined = first turn (creates the session; its id is returned). */
async function runTurn(
  sessionID: string | undefined,
  message: string,
): Promise<{ sessionID: string; okfReads: string[]; okfCalls: string[]; text: string }> {
  const cli = ["opencode", "run", "--format", "json"];
  if (sessionID) cli.push("--session", sessionID);
  cli.push(message);
  const proc = Bun.spawn(cli, { cwd: PROJECT, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`opencode run failed (exit ${exit})`);
  const okfReads: string[] = [];
  const okfCalls: string[] = [];
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
    if (ev.type === "tool_use") {
      const name = ev.part?.tool ?? "";
      if (name.startsWith("okf_")) {
        okfCalls.push(name);
        if (name === "okf_read") okfReads.push(String(ev.part?.state?.input?.id ?? "?"));
      }
    }
    if (ev.type === "text") text += ev.part?.text ?? "";
  }
  if (!sid) throw new Error("could not determine session id from events");
  return { sessionID: sid, okfReads, okfCalls, text };
}

/**
 * A verbatim-quote fact: a 4-word window containing a number (guess-proof — the model
 * must actually possess the text to quote it), plus topic words from the same line that
 * identify the sentence WITHOUT revealing the window.
 */
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
    if (topic.split(" ").some((w) => window.includes(w))) continue; // no window words in the topic
    return { window, topic };
  }
  return null;
}

interface ScenarioResult {
  id: string;
  arm: string;
  valid: boolean;
  reloaded: boolean;
  answered: boolean;
  note: string;
}

async function runScenario(arm: string, x: Concept, y: Concept, z: Concept): Promise<ScenarioResult> {
  const fact = sentenceFact(x)!;

  const load = async (sid: string | undefined, c: Concept) =>
    runTurn(sid, `Use the okf_read tool to load the concept "${c.id}" from the bundle "unload-bundle", then reply with exactly: LOADED`);

  const t1 = await load(undefined, x);
  const sid = t1.sessionID;
  if (t1.okfReads.length === 0) {
    return { id: x.id, arm, valid: false, reloaded: false, answered: false, note: "turn-1 load did not trigger okf_read" };
  }
  await load(sid, y);
  await load(sid, z);
  for (let i = 0; i < 3; i++) {
    await runTurn(sid, "Reply with exactly: OK");
  }

  const probe = await runTurn(
    sid,
    `Find the sentence in the document "${x.title ?? x.id}" that mentions: ${fact.topic}. Quote that sentence exactly, verbatim, in double quotes.`,
  );
  const reloaded = probe.okfReads.length > 0;
  const answered = probe.text.toLowerCase().includes(fact.window.toLowerCase());
  return {
    id: x.id,
    arm,
    valid: true,
    reloaded,
    answered,
    note: `window="${fact.window.slice(0, 40)}…" reload-tools=[${probe.okfCalls.join(",") || "none"}]`,
  };
}

describe("E2E reload hit-rate (OKF_RELOAD_E2E=1)", () => {
  test(
    "auto-unloaded body facts are recovered via the placeholder's reload hint",
    async () => {
      if (!E2E) {
        console.log("[skip] set OKF_RELOAD_E2E=1 to run the live reload hit-rate test");
        return;
      }

      // Pick scenarios deterministically from the real fixture.
      const bundles = await discoverBundles({
        projectRoot: PROJECT,
        scan: false,
        maxDepth: 4,
        configured: [{ path: FIXTURE, name: "unload-bundle" }],
      });
      const pool = [...(bundles[0]?.concepts.values() ?? [])]
        .filter((c) => sentenceFact(c) !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(pool.length).toBeGreaterThanOrEqual(SCENARIOS + 2);
      const results: ScenarioResult[] = [];

      // Treatment arm first (default config = auto-unload ON).
      for (let i = 0; i < SCENARIOS; i++) {
        const x = pool[i]!;
        const y = pool[(i + 1) % pool.length]!;
        const z = pool[(i + 2) % pool.length]!;
        results.push(await runScenario("treatment", x, y, z));
      }

      // Control arm: unload disabled via a temporary project config (restored in finally).
      const cfgPath = join(PROJECT, ".opencode", "okf.jsonc");
      const hadBefore = await readFile(cfgPath, "utf8").catch(() => null);
      try {
        await writeFile(cfgPath, JSON.stringify({ unload: { enabled: false } }, null, 2), "utf8");
        for (let i = 0; i < SCENARIOS; i++) {
          const x = pool[i]!;
          const y = pool[(i + 1) % pool.length]!;
          const z = pool[(i + 2) % pool.length]!;
          results.push(await runScenario("control", x, y, z));
        }
      } finally {
        if (hadBefore === null) await rm(cfgPath, { force: true });
        else await writeFile(cfgPath, hadBefore, "utf8");
      }

      // Report.
      const rate = (arm: string, key: "reloaded" | "answered") => {
        const rows = results.filter((r) => r.arm === arm && r.valid);
        return `${rows.filter((r) => r[key]).length}/${rows.length}`;
      };
      for (const r of results) {
        console.log(`[reload] ${r.arm.padEnd(9)} ${r.id.padEnd(28)} reload=${r.reloaded ? "Y" : "n"} answer=${r.answered ? "Y" : "n"} ${r.note}`);
      }
      console.log(`\n=== reload rate: treatment ${rate("treatment", "reloaded")} / control ${rate("control", "reloaded")} ===`);
      console.log(`=== accuracy   : treatment ${rate("treatment", "answered")} / control ${rate("control", "answered")} ===\n`);

      // Gates. Control sanity: with the full text retained the model should mostly answer.
      const controlOk = results.filter((r) => r.arm === "control" && r.valid && r.answered).length;
      expect(controlOk).toBeGreaterThanOrEqual(Math.ceil(SCENARIOS / 2));
      // Treatment: body facts are provably absent from the placeholder (benchmark/hitrate.ts),
      // so a correct answer means the model followed the reload hint.
      const treatOk = results.filter((r) => r.arm === "treatment" && r.valid && r.answered).length;
      expect(treatOk).toBeGreaterThanOrEqual(Math.ceil(SCENARIOS / 2));
      const valid = results.filter((r) => r.valid).length;
      expect(valid).toBeGreaterThanOrEqual(SCENARIOS);
    },
    1_500_000, // 25 min ceiling: 2 arms x 3 scenarios x 7 live turns
  );

  test("suite is opt-in (skipped unless OKF_RELOAD_E2E=1)", () => {
    expect(E2E).toBe(process.env.OKF_RELOAD_E2E === "1");
  });
});
