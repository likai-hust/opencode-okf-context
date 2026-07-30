/**
 * opencode-okf plugin entry point.
 *
 * Wires together:
 *   - discovery (scan + config bundles) -> cached in PluginState
 *   - 5 tools (okf_list/read/search/write/unload)
 *   - experimental.chat.system.transform  -> L0 manifest injection
 *   - experimental.chat.messages.transform -> unload + dedup + nudge (outbound only)
 *   - tool.execute.after -> debug logging
 *
 * Exported both as default and named, so it loads whether opencode uses default or named export.
 */
import { resolve } from "node:path";
import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { discoverBundles } from "./discovery.js";
import { renderManifest } from "./indexing.js";
import { buildTools } from "./tools.js";
import { transformOutbound } from "./messages.js";
import { state } from "./state.js";

export const OkfPlugin: Plugin = async (input: PluginInput, options = {}) => {
  const directory = input.directory;
  const cfg = await loadConfig(directory, options);

  const hooks: Hooks = {};

  // Tools ---------------------------------------------------------------
  if (cfg.enabled) {
    hooks.tool = buildTools(cfg);
  }

  // Discovery loader: discovers bundles (scan + configured) and caches them.
  async function discover(): Promise<import("./types.js").Bundle[]> {
    if (!cfg.enabled) {
      state.setBundles([]);
      return [];
    }
    const configured = cfg.bundles.map((b) => ({
      path: resolve(directory, b.path),
      name: b.name,
    }));
    const bundles = await discoverBundles({
      projectRoot: directory,
      scan: cfg.scan.enabled,
      maxDepth: cfg.scan.maxDepth,
      configured,
    });
    state.setBundles(bundles);
    return bundles;
  }
  // Register the loader so any hook/tool can trigger lazy discovery via state.
  state.setLoader(discover);

  // L0 manifest ---------------------------------------------------------
  if (cfg.enabled && cfg.disclosure.injectManifest) {
    hooks["experimental.chat.system.transform"] = async (_input, output) => {
      const bundles = await state.ensureLoaded();
      if (bundles.length === 0) return;
      const manifest = renderManifest(bundles, cfg.disclosure.maxManifestChars);
      output.system.push(manifest);
    };
  }

  // Outbound unload/dedup/nudge ----------------------------------------
  if (cfg.enabled) {
    hooks["experimental.chat.messages.transform"] = async (_input, output) => {
      const bundles = await state.ensureLoaded();
      if (bundles.length === 0) return;
      // messages.transform has no sessionID in its input signature; derive from parts.
      const sessionID = deriveSessionID(output.messages);
      if (!sessionID) return;
      // Invalidate cache if a write happened (markStale set by okf_write).
      // ensureLoaded was awaited above; if a write marked the cache stale
      // mid-conversation, re-discover so new concepts are visible.
      if (!state.isLoaded) await state.ensureLoaded();
      const result = transformOutbound(
        { messages: output.messages },
        cfg,
        state.getBundles(),
        sessionID,
      );
      if (cfg.debug && (result.deduped || result.unloaded || result.nudged)) {
        // eslint-disable-next-line no-console
        console.error(
          `[opencode-okf] deduped=${result.deduped} unloaded=${result.unloaded} nudged=${result.nudged}`,
        );
      }
    };
  }

  // Debug / token accounting on tool completion ------------------------
  if (cfg.enabled && cfg.debug) {
    hooks["tool.execute.after"] = async (toolInput, output) => {
      if (toolInput.tool && toolInput.tool.startsWith("okf_")) {
        // eslint-disable-next-line no-console
        console.error(`[opencode-okf] ${toolInput.tool} -> ${output.output.length} chars`);
      }
    };
  }

  return hooks;
};

/** Best-effort session id extraction from the transformed messages (parts carry sessionID). */
function deriveSessionID(
  messages: Array<{ parts: Array<{ sessionID?: string }> }>,
): string | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.sessionID) return p.sessionID;
    }
  }
  return undefined;
}

export default OkfPlugin;
