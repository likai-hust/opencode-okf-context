/**
 * Bundle discovery: scan a project root for OKF bundles and parse concepts.
 *
 * A directory is treated as a bundle root if it matches any of:
 *  1. It contains a root `index.md` with an `okf_version` frontmatter key (spec §12), OR
 *  2. It contains an `index.md` or `log.md` AND at least one `.md` with a `type`
 *     frontmatter key (the spec's `okf_version` is a MAY — bundles that don't declare it
 *     but still look like knowledge bundles are accepted heuristically), OR
 *  3. It is explicitly declared in the user's `bundles` config.
 *
 * All filesystem traversal is kept in `discoverBundles`; pure concept parsing lives in
 * `parseConcept` / `indexConcepts` so the message-transform logic can be unit tested.
 */
import { stat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep, basename } from "node:path";
import { splitFrontmatter, asString, asStringArray } from "./frontmatter.js";
import type { Bundle, Concept } from "./types.js";

/** Reserved filenames that must NOT be treated as concept documents. */
export const RESERVED = new Set(["index.md", "log.md"]);

/** Test whether a path exists (resolves to boolean, never throws). */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Directories that are never scanned. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".opencode",
]);

/** Convert an OS path to a POSIX-style relative id (no leading drive, forward slashes). */
export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Make a concept id from a file's path relative to the bundle root. */
export function conceptIdFromRelPath(relPath: string): string {
  const posix = toPosix(relPath);
  return posix.replace(/\.md$/i, "");
}

/** Read & parse a single concept file into a Concept object. */
export async function parseConcept(absPath: string, root: string): Promise<Concept> {
  const raw = await readFile(absPath, "utf8");
  const { frontmatter, body, yamlError } = splitFrontmatter(raw);
  const relPath = toPosix(relative(root, absPath));
  const id = conceptIdFromRelPath(relPath);
  return {
    id,
    path: absPath,
    relPath,
    frontmatter,
    body,
    yamlError,
    type: asString(frontmatter.type),
    title: asString(frontmatter.title),
    description: asString(frontmatter.description),
    tags: asStringArray(frontmatter.tags),
  };
}

/** Whether a markdown file (by name) is a concept (not a reserved file). */
export function isConceptFile(name: string): boolean {
  return name.toLowerCase().endsWith(".md") && !RESERVED.has(name.toLowerCase());
}

/** Whether a parsed index.md signals an OKF bundle root (via okf_version). */
export function indexDeclaresBundle(frontmatter: Record<string, unknown>): boolean {
  return frontmatter.okf_version !== undefined;
}

interface ScanHit {
  root: string;
  files: string[]; // absolute paths of all .md files under root
  indexDirs: Set<string>; // relative dir paths that contain an index.md
  hasLog: boolean;
  conceptCount: number;
  /** Number of concepts whose frontmatter declares a `type` (bundle heuristic). */
  typedConceptCount: number;
}

/** Scan a candidate directory recursively, collecting markdown files & reserved markers. */
async function scanDir(dir: string, maxDepth: number): Promise<ScanHit> {
  const files: string[] = [];
  const indexDirs = new Set<string>();
  let hasLog = false;
  let conceptCount = 0;
  let typedConceptCount = 0;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const lower = entry.name.toLowerCase();
        const relDir = toPosix(relative(dir, current)) || ".";
        if (lower === "index.md") {
          indexDirs.add(relDir);
        } else if (lower === "log.md") {
          hasLog = true;
        }
        if (isConceptFile(entry.name)) {
          files.push(full);
          conceptCount++;
          // Peek at the frontmatter `type` key for the bundle-root heuristic.
          try {
            const { frontmatter } = splitFrontmatter(await readFile(full, "utf8"));
            if (asString(frontmatter.type) !== undefined) typedConceptCount++;
          } catch {
            /* unreadable file: skip */
          }
        }
      }
    }
  }

  await walk(dir, 0);
  return { root: dir, files, indexDirs, hasLog, conceptCount, typedConceptCount };
}

/**
 * Heuristic: is `dir` an OKF bundle root?
 *
 * Accepted when either:
 *  1. The root `index.md` declares `okf_version` (the spec's standard marker, §12), OR
 *  2. The dir has an `index.md` or `log.md` AND at least one concept with a `type` key.
 *
 * Condition 2 keeps auto-scan from mis-classifying an ordinary project root (markdown that
 * merely happens to exist) while still accepting bundles that follow the spec's MAY-level
 * `okf_version` convention. Bundles that match neither should be declared explicitly via `bundles`.
 */
async function isBundleRoot(hit: ScanHit): Promise<boolean> {
  if (hit.conceptCount === 0) return false;
  // Condition 1: root index.md declares okf_version.
  if (hit.indexDirs.has(".")) {
    try {
      const { frontmatter } = splitFrontmatter(await readFile(join(hit.root, "index.md"), "utf8"));
      if (indexDeclaresBundle(frontmatter)) return true;
    } catch {
      /* unreadable index.md: fall through to condition 2 */
    }
  }
  // Condition 2: index.md or log.md present AND at least one typed concept.
  return (hit.indexDirs.size > 0 || hit.hasLog) && hit.typedConceptCount >= 1;
}

/** Build a Bundle object from a scanned root (parses all concepts). */
export async function buildBundle(
  root: string,
  name: string | undefined,
  origin: "scan" | "config",
  hit?: ScanHit,
): Promise<Bundle> {
  const scan = hit ?? (await scanDir(root, 8));
  const concepts = new Map<string, Concept>();
  for (const f of scan.files) {
    const c = await parseConcept(f, root);
    concepts.set(c.id, c);
  }
  return {
    name: name ?? basename(root),
    root,
    concepts,
    indexDirs: scan.indexDirs,
    hasLog: scan.hasLog,
    origin,
  };
}

export interface DiscoverOptions {
  /** Project root to auto-scan. */
  projectRoot: string;
  /** Auto-scan enabled? */
  scan: boolean;
  /** Max scan depth. */
  maxDepth: number;
  /** Explicit bundles: { path, name? }. Absolute paths. */
  configured: Array<{ path: string; name?: string }>;
}

/**
 * Discover bundles: merge auto-scanned + explicitly configured bundles.
 * Configured bundles always win (same root → config name/origin replaces scan).
 */
export async function discoverBundles(opts: DiscoverOptions): Promise<Bundle[]> {
  const byRoot = new Map<string, Bundle>();

  // 1. Configured bundles first.
  for (const cfg of opts.configured) {
    if (!(await exists(cfg.path))) continue;
    const hit = await scanDir(cfg.path, 8);
    const bundle = await buildBundle(cfg.path, cfg.name, "config", hit);
    byRoot.set(bundle.root, bundle);
  }

  // 2. Auto-scan.
  if (opts.scan) {
    await scanForBundleRoots(opts.projectRoot, opts.maxDepth, async (root) => {
      if (byRoot.has(root)) return; // configured wins
      // Don't nest-scan inside an already-accepted bundle root; accept the topmost.
      for (const existing of byRoot.keys()) {
        if (root !== existing && (root.startsWith(existing + sep) || root.startsWith(existing + "/"))) {
          return;
        }
      }
      const hit = await scanDir(root, 8);
      const bundle = await buildBundle(root, undefined, "scan", hit);
      byRoot.set(bundle.root, bundle);
    });
  }

  return Array.from(byRoot.values());
}

/** Walk the project looking for directories that look like bundle roots. Accepts topmost only. */
async function scanForBundleRoots(
  projectRoot: string,
  maxDepth: number,
  accept: (root: string) => Promise<void>,
): Promise<void> {
  const accepted: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    const hasMd = entries.some(
      (e) => e.isFile() && e.name.toLowerCase().endsWith(".md"),
    );
    if (hasMd) {
      const hit = await scanDir(current, Math.min(maxDepth - depth, 8));
      if (await isBundleRoot(hit)) {
        accepted.push(current);
        await accept(current);
        return; // don't descend into an accepted bundle root
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      await walk(join(current, entry.name), depth + 1);
    }
  }

  await walk(projectRoot, 0);
  void accepted;
}
