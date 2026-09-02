/**
 * The outbound message transformer — the heart of the "unload after use" feature.
 *
 * On every LLM request opencode hands us the full message history. We walk it and:
 *   1. Dedup: for each concept id, if okf_read was called more than once, keep only the
 *      LATEST completed output; replace earlier ones with a "deduplicated" placeholder.
 *   2. Auto-unload: replace a completed okf_read output with a placeholder once enough
 *      user turns have passed (config.unload.afterTurns), except the N most recent
 *      (config.unload.keepRecent) and any protectedConcepts glob.
 *   3. Manual unload: replace outputs whose concept key is in the session's unloaded set.
 *   4. Nudge: if total retained okf_read chars exceed nudge.threshold, append a soft
 *      reminder to the last user message text part (throttled by nudge.frequency).
 *
 * Critical principle (borrowed from DCP): we never mutate the real session store. We only
 * rewrite the `parts` array handed to us in the transform output. History on disk is intact.
 */
import type { Part, ToolStateCompleted } from "@opencode-ai/sdk";
import type { Message } from "@opencode-ai/sdk";
import type { OkfConfig } from "./config.js";
import type { Bundle } from "./types.js";
import {
  conceptKey,
  dedupPlaceholder,
  globMatch,
  normalizeId,
  placeholderFor,
  resolveConcept,
} from "./registry.js";
import { state } from "./state.js";

const OKF_READ_TOOL = "okf_read";

export interface TransformInput {
  messages: Array<{ info: Message; parts: Part[] }>;
}

/** A located okf_read tool part within the message array. */
interface ReadSlot {
  msgIndex: number;
  partIndex: number;
  callID: string;
  bundle: string | undefined;
  id: string; // normalized concept id (first id for batch reads)
  key: string; // bundle::id (first id for batch reads)
  /** All concept ids for a batch read (ids:[...]); empty for single reads. */
  batchIds: string[];
  output: string;
  outputChars: number;
}

const NUDGE_TAG = "%%okf-nudge%%";

/**
 * Apply unload/dedup/nudge transformations to the outbound messages (in place).
 * Returns counts for logging/debugging.
 */
export function transformOutbound(
  input: TransformInput,
  cfg: OkfConfig,
  bundles: Bundle[],
  sessionID: string,
): { deduped: number; unloaded: number; nudged: boolean } {
  const slots = collectReadSlots(input);
  let deduped = 0;
  let unloaded = 0;

  // 1. Dedup: per concept key, keep only the last occurrence.
  const lastByKey = new Map<string, ReadSlot>();
  for (const s of slots) lastByKey.set(s.key, s);

  for (const s of slots) {
    const latest = lastByKey.get(s.key)!;
    if (s !== latest) {
      replaceOutput(input, s, dedupPlaceholder(s.bundle ?? bundles[0]?.name ?? "?", s.id));
      deduped++;
    }
  }

  // Recompute slots' output lengths after dedup (placeholders are tiny).
  const surviving = slots.filter((s) => s === lastByKey.get(s.key));

  // 2. Decide auto/manual unload for surviving slots.
  const turnOf = userTurnIndex(input); // msgIndex -> number of user turns before/including it
  if (cfg.unload.enabled) {
    // Order surviving by occurrence to compute keepRecent on the "most recent reads".
    const order = [...surviving];
    // most recent first (last in array = most recent)
    const recentSet = new Set<ReadSlot>();
    for (let i = order.length - 1; i >= 0 && recentSet.size < cfg.unload.keepRecent; i--) {
      recentSet.add(order[i]!);
    }

    for (const s of order) {
      // Manual unload always wins (even over keepRecent / protectedConcepts):
      // the model explicitly asked to release this concept.
      if (state.isUnloaded(sessionID, s.key)) {
        const freed = s.outputChars;
        replaceOutput(input, s, placeholderText(cfg, bundles, s, freed));
        unloaded++;
        continue;
      }
      if (recentSet.has(s)) continue; // protected: most recent reads
      if (isProtected(cfg, bundles, s.bundle, s.id)) continue; // protected: glob
      // Auto unload by turns.
      const turnsSince = turnsSinceLoad(input, s.msgIndex, turnOf);
      if (turnsSince >= cfg.unload.afterTurns) {
        const freed = s.outputChars;
        replaceOutput(input, s, placeholderText(cfg, bundles, s, freed));
        unloaded++;
      }
    }
  }

  // 3. Nudge: total retained chars of surviving, not-yet-unloaded reads.
  let nudged = false;
  if (cfg.nudge.enabled) {
    let retainedChars = 0;
    for (const s of surviving) {
      const part = input.messages[s.msgIndex]!.parts[s.partIndex]!;
      if (part.type === "tool" && part.state.status === "completed") {
        retainedChars += (part.state as ToolStateCompleted).output.length;
      }
    }
    const sess = state.session(sessionID);
    const userTurns = countUserMessages(input);
    if (
      retainedChars > cfg.nudge.threshold &&
      userTurns - sess.lastNudgeAt >= cfg.nudge.frequency
    ) {
      injectNudge(input, retainedChars, cfg.nudge.force);
      sess.lastNudgeAt = userTurns;
      nudged = true;
    }
  }

  return { deduped, unloaded, nudged };
}

/** Collect every completed okf_read tool part with its resolved concept metadata. */
function collectReadSlots(input: TransformInput): ReadSlot[] {
  const slots: ReadSlot[] = [];
  for (let mi = 0; mi < input.messages.length; mi++) {
    const parts = input.messages[mi]!.parts;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]!;
      if (part.type !== "tool" || part.tool !== OKF_READ_TOOL) continue;
      if (part.state.status !== "completed") continue;
      const st = part.state as ToolStateCompleted;
      const bundleRaw = st.input?.bundle;
      const idRaw = st.input?.id;
      const idsRaw = st.input?.ids;
      const bundle = typeof bundleRaw === "string" ? bundleRaw : undefined;

      // Batch read (ids:[...]): track as one slot keyed by its first id; unload replaces
      // the whole batch output. Concept-level dedup is intentionally not applied to batches.
      if (Array.isArray(idsRaw)) {
        const ids = idsRaw.filter((v): v is string => typeof v === "string").map(normalizeId);
        if (ids.length === 0) continue;
        const id = ids[0]!;
        slots.push({
          msgIndex: mi,
          partIndex: pi,
          callID: part.callID,
          bundle,
          id,
          key: bundle ? `${bundle}::${id}` : `::${id}`,
          batchIds: ids,
          output: st.output,
          outputChars: st.output.length,
        });
        continue;
      }

      if (typeof idRaw !== "string") continue;
      const id = normalizeId(idRaw);
      slots.push({
        msgIndex: mi,
        partIndex: pi,
        callID: part.callID,
        bundle,
        id,
        key: bundle ? `${bundle}::${id}` : `::${id}`,
        batchIds: [],
        output: st.output,
        outputChars: st.output.length,
      });
    }
  }
  return slots;
}

/** Replace a tool part's completed output (in place) with `text`. */
function replaceOutput(input: TransformInput, s: ReadSlot, text: string): void {
  const part = input.messages[s.msgIndex]!.parts[s.partIndex]!;
  if (part.type !== "tool" || part.state.status !== "completed") return;
  // Mutate the state object opencode handed us; it is a fresh copy per request.
  (part.state as ToolStateCompleted).output = text;
}

/** Build the placeholder for a read slot (single concept, or a whole batch). */
function placeholderText(
  cfg: OkfConfig,
  bundles: Bundle[],
  s: ReadSlot,
  freedChars: number,
): string {
  // Batch read: unload the whole batch as one unit, listing every concept.
  if (s.batchIds.length > 0) {
    const bName = s.bundle ?? bundles[0]?.name ?? "?";
    const reloads = s.batchIds.map((id) => `okf_read(ids: ["${id}"], bundle: "${bName}")`).join("; ");
    return `[OKF] batch of ${s.batchIds.length} concepts auto-unloaded — ~${Math.round(freedChars)} chars freed. Routine context management; no action needed. Reload with ${reloads} only if genuinely needed.`;
  }
  const found = resolveConcept(bundles, s.id, s.bundle);
  const bName = found?.bundle.name ?? s.bundle ?? "?";
  if (found) {
    return placeholderFor(bName, found.concept, cfg.unload.placeholder, freedChars);
  }
  // Concept no longer resolvable (deleted?) — minimal placeholder.
  return `[OKF] concept "${s.id}"${s.bundle ? ` (${s.bundle})` : ""} auto-unloaded — ~${Math.round(freedChars)} chars freed. Routine context management; no action needed. Reload with okf_read(id: "${s.id}") only if genuinely needed.`;
}

/** Is this concept protected by the protectedConcepts globs? */
function isProtected(
  cfg: OkfConfig,
  bundles: Bundle[],
  bundleName: string | undefined,
  id: string,
): boolean {
  for (const pattern of cfg.protectedConcepts) {
    if (globMatch(pattern, id)) return true;
    if (bundleName && globMatch(pattern, `${bundleName}::${id}`)) return true;
  }
  return false;
}

/** Map: message index -> how many user turns came at or before it. */
function userTurnIndex(input: TransformInput): Map<number, number> {
  const m = new Map<number, number>();
  let count = 0;
  for (let i = 0; i < input.messages.length; i++) {
    if (input.messages[i]!.info.role === "user") count++;
    m.set(i, count);
  }
  return m;
}

/** Number of user messages that arrived strictly AFTER the load message. */
function turnsSinceLoad(
  input: TransformInput,
  loadMsgIndex: number,
  turnOf: Map<number, number>,
): number {
  const turnsAtLoad = turnOf.get(loadMsgIndex) ?? 0;
  const totalTurns = totalUserTurns(turnOf);
  return totalTurns - turnsAtLoad;
}

function totalUserTurns(turnOf: Map<number, number>): number {
  let max = 0;
  for (const v of turnOf.values()) if (v > max) max = v;
  return max;
}

function countUserMessages(input: TransformInput): number {
  let n = 0;
  for (const m of input.messages) if (m.info.role === "user") n++;
  return n;
}

/** Append a soft nudge to the last user message's text part (create synthetic if none). */
function injectNudge(input: TransformInput, retainedChars: number, force: string): void {
  // Find the last user message.
  let lastUser = -1;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i]!.info.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return;
  const parts = input.messages[lastUser]!.parts;

  // Avoid double-injecting (replace previous nudge if present).
  let textPart: Extract<Part, { type: "text" }> | undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p.type === "text") {
      textPart = p;
      break;
    }
  }

  // "soft" = a suggestion; "strong" = a directive (free context now).
  const directive = force === "strong";
  const lead = directive ? "unload" : "consider unloading";
  const urgency = directive
    ? " To keep the context lean and avoid quality degradation, unload concepts you are done with"
    : " If you are done using some of it";
  const line =
    `\n\n${NUDGE_TAG}\n(okf) You currently have ~${Math.round(retainedChars)} chars of OKF knowledge ` +
    `loaded in context.${urgency}, ${lead} those concepts with ` +
    `okf_unload. Use okf_list/okf_read again to reload.`;

  if (textPart) {
    // Strip a previously injected nudge first.
    const idx = textPart.text.indexOf(NUDGE_TAG);
    if (idx !== -1) {
      textPart.text = textPart.text.slice(0, idx).trimEnd();
    }
    textPart.text += line;
  } else {
    // Synthesize a text part on the user message (kept out of the stored transcript visually).
    const synthetic: Extract<Part, { type: "text" }> = {
      type: "text",
      text: line.replace(/^\n\n/, ""),
      synthetic: true,
      // Required id/session/message fields are normally set by opencode; for an outbound-only
      // transform the server tolerates placeholder ids.
    } as Extract<Part, { type: "text" }>;
    parts.push(synthetic);
  }
}
