/**
 * Layered configuration loading for opencode-okf.
 *
 * Lookup order (later layers override earlier, deep-merged):
 *   1. ~/.config/opencode/okf.jsonc            (global)
 *   2. $OPENCODE_CONFIG_DIR/okf.jsonc          (if env set)
 *   3. <project>/.opencode/okf.jsonc           (project)
 *   4. plugin options from opencode.json        (["opencode-okf", {...}])
 *
 * The final object is normalized to a fully-populated OkfConfig with defaults filled in.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UnloadConfig {
  enabled: boolean;
  /** User turns after which a loaded concept is auto-unloaded (replaced by placeholder). */
  afterTurns: number;
  /** Always keep the N most recent okf_read outputs, never auto-unload them. */
  keepRecent: number;
  /** Placeholder verbosity: "description" (title+description) | "minimal" (just a ref). */
  placeholder: "description" | "minimal";
}

export interface NudgeConfig {
  enabled: boolean;
  /** Total chars of loaded-but-not-unloaded concepts above which a nudge is injected. */
  threshold: number;
  /** Inject the nudge at most once every N user messages (throttle). */
  frequency: number;
  /** "soft" suggests, "strong" would block (v1 only ships "soft"). */
  force: "soft" | "strong";
}

export interface WriteConfig {
  enabled: boolean;
  /** Add/update the entry in the parent directory's index.md when writing a concept. */
  updateIndex: boolean;
  /** Prepend an entry under today's ISO date heading to log.md. */
  appendLog: boolean;
}

export interface ScanConfig {
  enabled: boolean;
  maxDepth: number;
}

export interface DisclosureConfig {
  injectManifest: boolean;
  maxManifestChars: number;
}

export interface OkfConfig {
  enabled: boolean;
  scan: ScanConfig;
  bundles: Array<{ path: string; name?: string }>;
  disclosure: DisclosureConfig;
  unload: UnloadConfig;
  nudge: NudgeConfig;
  write: WriteConfig;
  protectedConcepts: string[];
  debug: boolean;
}

export const DEFAULT_CONFIG: OkfConfig = {
  enabled: true,
  scan: { enabled: true, maxDepth: 4 },
  bundles: [],
  disclosure: { injectManifest: true, maxManifestChars: 2000 },
  unload: {
    enabled: true,
    afterTurns: 2,
    keepRecent: 1,
    placeholder: "description",
  },
  nudge: { enabled: true, threshold: 6000, frequency: 3, force: "soft" },
  write: { enabled: true, updateIndex: true, appendLog: true },
  protectedConcepts: [],
  debug: false,
};

/** Test whether a path exists (resolves to boolean, never throws). */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Strip JSONC comments (single-line and block) before JSON.parse. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let strCh = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === strCh) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      strCh = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Deep-merge a partial config over defaults (arrays replaced, not concatenated). */
export function mergeConfig(base: OkfConfig, override: unknown): OkfConfig {
  if (!override || typeof override !== "object") return base;
  const o = override as Record<string, unknown>;
  const merged: OkfConfig = JSON.parse(JSON.stringify(base));

  function set(target: Record<string, unknown>, src: Record<string, unknown>) {
    for (const [k, v] of Object.entries(src)) {
      if (v === null || v === undefined) continue;
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof target[k] === "object" &&
        target[k] !== null &&
        !Array.isArray(target[k])
      ) {
        set(target[k] as Record<string, unknown>, v as Record<string, unknown>);
      } else {
        target[k] = v;
      }
    }
  }

  set(merged as unknown as Record<string, unknown>, o);
  return merged;
}

/** Candidate config file paths, in load order (low → high precedence). */
export function configPaths(projectDir: string): string[] {
  const paths: string[] = [];
  const home = homedir();
  paths.push(join(home, ".config", "opencode", "okf.jsonc"));
  paths.push(join(home, ".config", "opencode", "okf.json"));
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  if (envDir) {
    paths.push(join(envDir, "okf.jsonc"));
    paths.push(join(envDir, "okf.json"));
  }
  paths.push(join(projectDir, ".opencode", "okf.jsonc"));
  paths.push(join(projectDir, ".opencode", "okf.json"));
  return paths;
}

/** Load + merge all config layers. Missing files are ignored. */
export async function loadConfig(
  projectDir: string,
  options: Record<string, unknown> = {},
): Promise<OkfConfig> {
  let cfg = DEFAULT_CONFIG;
  for (const p of configPaths(projectDir)) {
    try {
      if (!(await exists(p))) continue;
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(stripJsonc(raw));
      cfg = mergeConfig(cfg, parsed);
    } catch {
      /* malformed layer: skip */
    }
  }
  // Plugin options from opencode.json take the highest precedence.
  cfg = mergeConfig(cfg, options);
  return cfg;
}
