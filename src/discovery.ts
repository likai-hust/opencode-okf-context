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
  /**
   * Root-level-only markers (depth=0 files, no recursion). isBundleRoot uses these so
   * a sub-directory's index.md or a deeply nested typed concept can't trick the heuristic
   * into accepting a plain project root as a bundle.
   */
  rootHasIndex: boolean; // root dir directly contains index.md
  rootHasLog: boolean; // root dir directly contains log.md
  rootTypedCount: number; // root dir's direct .md files that have a `type`
}

/** Scan a candidate directory recursively, collecting markdown files & reserved markers. */
async function scanDir(dir: string, maxDepth: number): Promise<ScanHit> {
  const files: string[] = [];
  const indexDirs = new Set<string>();
  let hasLog = false;
  let conceptCount = 0;
  let typedConceptCount = 0;
  // Root-level-only markers (depth=0): isBundleRoot reads these, NOT the recursive totals.
  let rootHasIndex = false;
  let rootHasLog = false;
  let rootTypedCount = 0;

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
        const isRootLevel = depth === 0; // direct child of the scan root
        if (lower === "index.md") {
          indexDirs.add(relDir);
          if (isRootLevel) rootHasIndex = true;
        } else if (lower === "log.md") {
          hasLog = true;
          if (isRootLevel) rootHasLog = true;
        }
        if (isConceptFile(entry.name)) {
          files.push(full);
          conceptCount++;
          // Peek at the frontmatter `type` key for the bundle-root heuristic.
          let hasType = false;
          try {
            const { frontmatter } = splitFrontmatter(await readFile(full, "utf8"));
            if (asString(frontmatter.type) !== undefined) {
              typedConceptCount++;
              hasType = true;
            }
          } catch {
            /* unreadable file: skip */
          }
          if (isRootLevel && hasType) rootTypedCount++;
        }
      }
    }
  }

  await walk(dir, 0);
  return { root: dir, files, indexDirs, hasLog, conceptCount, typedConceptCount, rootHasIndex, rootHasLog, rootTypedCount };
}

/**
 * Heuristic: is `dir` an OKF bundle root?
 *
 * Accepted when either:
 *  1. The root `index.md` declares `okf_version` (the spec's standard marker, §12), OR
 *  2. The ROOT dir has an `index.md` or `log.md` AND at least one typed concept AT THE ROOT.
 *
 * Condition 2 keeps auto-scan from mis-classifying an ordinary project root (markdown that
 * merely happens to exist) while still accepting bundles that follow the spec's MAY-level
 * `okf_version` convention. Bundles that match neither should be declared explicitly via `bundles`.
 *
 * IMPORTANT: only root-level (depth=0) markers count — a sub-directory's index.md or a deeply
 * nested typed concept must NOT trick this into accepting a plain project as a bundle. That
 * was a real bug before the rootHasIndex/rootHasLog/rootTypedCount fields were added.
 */
async function isBundleRoot(hit: ScanHit): Promise<boolean> {
  if (hit.conceptCount === 0) return false;
  // Condition 1: root index.md declares okf_version.
  if (hit.rootHasIndex) {
    try {
      const { frontmatter } = splitFrontmatter(await readFile(join(hit.root, "index.md"), "utf8"));
      if (indexDeclaresBundle(frontmatter)) return true;
    } catch {
      /* unreadable index.md: fall through to condition 2 */
    }
  }
  // Condition 2: root-level index.md or log.md AND at least one typed concept AT THE ROOT.
  return (hit.rootHasIndex || hit.rootHasLog) && hit.rootTypedCount >= 1;
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

/** Whether `dir`'s own root index.md explicitly declares okf_version (spec §12 marker). */
async function declaresOkfVersion(dir: string): Promise<boolean> {
  try {
    const { frontmatter } = splitFrontmatter(await readFile(join(dir, "index.md"), "utf8"));
    return indexDeclaresBundle(frontmatter);
  } catch {
    return false;
  }
}

/**
 * Discover bundles: merge auto-scanned + explicitly configured bundles.
 * Configured bundles always win (same root → config name/origin replaces scan).
 *
 * Nested bundles: a directory whose own index.md declares okf_version is accepted as a
 * bundle even when it sits inside another accepted bundle root, and its subtree is then
 * EXCLUDED from the outer bundle's concepts. This keeps a real knowledge bundle (e.g.
 * `doca/wiki/`) discoverable even if a project root got detected as a bundle too —
 * the outer must not swallow the inner.
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

  // 2. Auto-scan: collect accepted roots first, then build innermost-first so outer
  // bundles can exclude the subtrees that belong to nested bundles.
  if (opts.scan) {
    const acceptedRoots: string[] = [];
    await scanForBundleRoots(opts.projectRoot, opts.maxDepth, async (root) => {
      if (byRoot.has(root)) return; // configured wins
      acceptedRoots.push(root);
    });
    acceptedRoots.sort((a, b) => b.length - a.length); // deepest first
    for (const root of acceptedRoots) {
      const hit = await scanDir(root, 8);
      // Exclude concept files that belong to a NESTED bundle — i.e. another accepted or
      // configured root strictly INSIDE this root (outer roots must not drain this one).
      const innerRoots = Array.from(byRoot.keys())
        .concat(acceptedRoots)
        .filter((r) => r !== root && (r.startsWith(root + sep) || r.startsWith(root + "/")));
      const inInner = (f: string) => innerRoots.some((ir) => f.startsWith(ir + sep) || f.startsWith(ir + "/"));
      const files = hit.files.filter((f) => !inInner(f));
      const bundle = await buildBundle(root, undefined, "scan", { ...hit, files });
      byRoot.set(bundle.root, bundle);
    }
  }

  return Array.from(byRoot.values());
}

/**
 * Walk the project looking for directories that look like bundle roots.
 *
 * Topmost heuristic roots win (an outer bundle suppresses *heuristic* detection inside
 * it), BUT a nested directory whose own index.md explicitly declares `okf_version`
 * (the spec §12 bundle marker) is still accepted as its own bundle — an outer detection
 * (e.g. an accidentally-detected project root) must not swallow a real nested knowledge
 * bundle. discoverBundles then excludes the nested subtree from the outer bundle.
 */
async function scanForBundleRoots(
  projectRoot: string,
  maxDepth: number,
  accept: (root: string) => Promise<void>,
): Promise<void> {
  async function walk(current: string, depth: number, insideBundle: boolean): Promise<void> {
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
        const explicitMarker = hit.rootHasIndex && (await declaresOkfVersion(current));
        // Inside an already-accepted bundle, only the explicit spec marker qualifies;
        // heuristic roots nested in a bundle stay suppressed (fall through to descend,
        // so deeper explicit markers can still be found).
        if (!insideBundle || explicitMarker) {
          await accept(current);
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (SKIP_DIRS.has(entry.name)) continue;
            if (entry.name.startsWith(".")) continue;
            await walk(join(current, entry.name), depth + 1, true);
          }
          return;
        }
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      await walk(join(current, entry.name), depth + 1, insideBundle);
    }
  }

  await walk(projectRoot, 0, false);
}
