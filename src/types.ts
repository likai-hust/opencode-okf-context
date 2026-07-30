/**
 * Shared types for the opencode-okf plugin.
 *
 * OKF v0.2 reference (Google knowledge-catalog):
 * - Bundle = a directory tree of markdown files.
 * - Concept = a .md file with YAML frontmatter; `type` is the only always-required key.
 * - Reserved filenames: index.md (directory listing for progressive disclosure) and
 *   log.md (changelog). They MUST NOT be used as concept documents.
 * - Concept ID = the file's relative path inside the bundle, without the .md suffix.
 * - Cross-links use standard markdown links, bundle-relative absolute paths (leading "/")
 *   are recommended.
 */

/** A parsed OKF concept document. */
export interface Concept {
  /** Concept ID: relative path within the bundle without the ".md" suffix (POSIX separators). */
  id: string;
  /** Absolute filesystem path to the source file. */
  path: string;
  /** Relative path within the bundle (POSIX separators, includes the ".md"). */
  relPath: string;
  /** Parsed YAML frontmatter (always present; may be empty object). */
  frontmatter: Record<string, unknown>;
  /** The markdown body (everything after the frontmatter). */
  body: string;
  /** Frontmatter convenience fields. `type` is required by the spec but we tolerate absence. */
  type: string | undefined;
  title: string | undefined;
  description: string | undefined;
  tags: string[] | undefined;
}

/** A discovered OKF bundle. */
export interface Bundle {
  /** Display name. Defaults to the directory basename if not configured. */
  name: string;
  /** Absolute path to the bundle root directory. */
  root: string;
  /** All concepts in the bundle, keyed by concept id. */
  concepts: Map<string, Concept>;
  /** Set of directory paths (relative to root, POSIX) that have an index.md. */
  indexDirs: Set<string>;
  /** Whether a log.md exists at the bundle root. */
  hasLog: boolean;
  /** Origin: scanned automatically vs. explicitly configured. */
  origin: "scan" | "config";
}

/** Result of a (bundle, id) lookup, normalized for tool output. */
export interface ConceptRef {
  bundle: string;
  id: string;
}
