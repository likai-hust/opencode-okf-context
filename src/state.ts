/**
 * In-memory plugin state.
 *
 * Two responsibilities:
 *  1. Bundle cache: discovered bundles are kept in memory and refreshed lazily
 *     (on plugin load and when okf_write creates a file).
 *  2. Per-session unload bookkeeping: the set of concept ids explicitly unloaded via
 *     okf_unload, plus nudge throttle counters.
 *
 * The auto-unload logic itself is *stateless* — it is recomputed from the outbound
 * message history on every request (see messages.ts). Only the small "manual unload"
 * set and nudge throttle need persistence across requests, and only in memory.
 */
import type { Bundle } from "./types.js";

export interface SessionState {
  /** "bundle:id" keys explicitly unloaded by the model (survive until session ends). */
  unloaded: Set<string>;
  /** Number of user messages seen so far in this session (for nudge throttle). */
  userMessageCount: number;
  /** Last user-message index at which a nudge was injected. */
  lastNudgeAt: number;
}

export class PluginState {
  private bundles: Bundle[] = [];
  private bundlesLoaded = false;
  private sessions = new Map<string, SessionState>();
  private loader: (() => Promise<Bundle[]>) | null = null;
  private loading: Promise<Bundle[]> | null = null;

  /** Register the discovery loader (called once by the plugin entry). */
  setLoader(loader: () => Promise<Bundle[]>): void {
    this.loader = loader;
  }

  setBundles(bundles: Bundle[]): void {
    this.bundles = bundles;
    this.bundlesLoaded = true;
    this.loading = null;
  }

  getBundles(): Bundle[] {
    return this.bundles;
  }

  get isLoaded(): boolean {
    return this.bundlesLoaded;
  }

  markStale(): void {
    this.bundlesLoaded = false;
  }

  /**
   * Ensure bundles are loaded. Safe to call from any hook/tool; coalesces concurrent calls.
   * Returns the current bundles (possibly empty if no loader is configured).
   */
  async ensureLoaded(): Promise<Bundle[]> {
    if (this.bundlesLoaded) return this.bundles;
    if (this.loading) return this.loading;
    if (!this.loader) return this.bundles;
    this.loading = this.loader().then((b) => {
      this.setBundles(b);
      return b;
    });
    return this.loading;
  }

  session(sessionID: string): SessionState {
    let s = this.sessions.get(sessionID);
    if (!s) {
      s = { unloaded: new Set(), userMessageCount: 0, lastNudgeAt: -1 };
      this.sessions.set(sessionID, s);
    }
    return s;
  }

  /** Record an explicit unload; returns whether it was new. */
  unload(sessionID: string, key: string): boolean {
    const s = this.session(sessionID);
    if (s.unloaded.has(key)) return false;
    s.unloaded.add(key);
    return true;
  }

  unloadAll(sessionID: string, keys: string[]): number {
    const s = this.session(sessionID);
    let added = 0;
    for (const k of keys) {
      if (!s.unloaded.has(k)) {
        s.unloaded.add(k);
        added++;
      }
    }
    return added;
  }

  isUnloaded(sessionID: string, key: string): boolean {
    return this.session(sessionID).unloaded.has(key);
  }
}

/** Singleton plugin state. */
export const state = new PluginState();
