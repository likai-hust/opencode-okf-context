/**
 * Unit tests for discovery, frontmatter, config merge, and glob matching.
 * Exercises the fixture bundle in fixtures/sample-bundle.
 */
import { test, expect } from "bun:test";
import { join } from "node:path";
import { discoverBundles, parseConcept, conceptIdFromRelPath, isConceptFile, indexDeclaresBundle } from "../src/discovery.js";
import { splitFrontmatter, serializeDoc } from "../src/frontmatter.js";
import { mergeConfig, DEFAULT_CONFIG, stripJsonc } from "../src/config.js";
import { globMatch, normalizeId, describeConcept, conceptKey } from "../src/registry.js";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "sample-bundle");

// --- discovery --------------------------------------------------------

test("discovers the fixture bundle and parses concepts", async () => {
  const bundles = await discoverBundles({
    projectRoot: FIXTURE,
    scan: false,
    maxDepth: 4,
    configured: [{ path: FIXTURE, name: "demo" }],
  });
  expect(bundles.length).toBe(1);
  const b = bundles[0]!;
  expect(b.name).toBe("demo");
  expect(b.origin).toBe("config");
  expect(b.concepts.size).toBe(3);
  expect(b.concepts.has("tables/customers")).toBe(true);
  expect(b.concepts.has("tables/orders")).toBe(true);
  expect(b.concepts.has("metrics/active_customers")).toBe(true);
  // reserved files are NOT concepts
  expect(b.concepts.has("index")).toBe(false);
  expect(b.concepts.has("log")).toBe(false);
});

test("parseConcept extracts frontmatter convenience fields", async () => {
  const c = await parseConcept(join(FIXTURE, "tables/customers.md"), FIXTURE);
  expect(c.id).toBe("tables/customers");
  expect(c.type).toBe("BigQuery Table");
  expect(c.title).toBe("customers");
  expect(c.description).toContain("Customer master table");
  expect(c.tags).toEqual(["core", "identity"]);
  expect(c.body).toContain("# customers");
});

test("conceptIdFromRelPath strips .md and normalizes separators", () => {
  expect(conceptIdFromRelPath("tables/customers.md")).toBe("tables/customers");
  expect(conceptIdFromRelPath("a.md")).toBe("a");
});

test("isConceptFile rejects reserved names", () => {
  expect(isConceptFile("customers.md")).toBe(true);
  expect(isConceptFile("index.md")).toBe(false);
  expect(isConceptFile("log.md")).toBe(false);
  expect(isConceptFile("readme.txt")).toBe(false);
});

test("indexDeclaresBundle checks okf_version", () => {
  expect(indexDeclaresBundle({ okf_version: "0.2" })).toBe(true);
  expect(indexDeclaresBundle({})).toBe(false);
});

// --- frontmatter ------------------------------------------------------

test("splitFrontmatter parses YAML block", () => {
  const raw = "---\ntype: T\ntitle: x\ntags: [a, b]\n---\n\n# body\n";
  const { frontmatter, body, hasFrontmatter } = splitFrontmatter(raw);
  expect(hasFrontmatter).toBe(true);
  expect(frontmatter.type).toBe("T");
  expect(frontmatter.tags).toEqual(["a", "b"]);
  expect(body.trim()).toBe("# body");
});

test("splitFrontmatter handles no-frontmatter docs", () => {
  const { frontmatter, body, hasFrontmatter } = splitFrontmatter("# just a heading");
  expect(hasFrontmatter).toBe(false);
  expect(frontmatter).toEqual({});
  expect(body).toBe("# just a heading");
});

test("serializeDoc round-trips frontmatter + body", () => {
  const doc = serializeDoc({ type: "T", title: "x" }, "# body");
  expect(doc.startsWith("---")).toBe(true);
  expect(doc).toContain("type: T");
  expect(doc).toContain("# body");
});

// --- config -----------------------------------------------------------

test("mergeConfig deep-merges nested objects", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { unload: { afterTurns: 5 } });
  expect(merged.unload.afterTurns).toBe(5);
  expect(merged.unload.keepRecent).toBe(DEFAULT_CONFIG.unload.keepRecent); // preserved
});

test("mergeConfig replaces arrays", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { protectedConcepts: ["a/*"] });
  expect(merged.protectedConcepts).toEqual(["a/*"]);
});

test("stripJsonc removes line and block comments", () => {
  const jsonc = `{
    // a comment
    "a": 1, /* block */
    "b": "x // not a comment"
  }`;
  const obj = JSON.parse(stripJsonc(jsonc));
  expect(obj.a).toBe(1);
  expect(obj.b).toBe("x // not a comment");
});

// --- registry ---------------------------------------------------------

test("globMatch supports * and **", () => {
  expect(globMatch("tables/*", "tables/customers")).toBe(true);
  expect(globMatch("tables/*", "metrics/x")).toBe(false);
  expect(globMatch("tables/*", "tables/sub/deep")).toBe(false); // single * doesn't cross /
  expect(globMatch("tables/**", "tables/sub/deep")).toBe(true);
  expect(globMatch("**", "anything/here")).toBe(true);
});

test("normalizeId strips leading slash and .md", () => {
  expect(normalizeId("/tables/customers")).toBe("tables/customers");
  expect(normalizeId("tables/customers.md")).toBe("tables/customers");
  expect(normalizeId("tables\\customers")).toBe("tables/customers");
});

test("describeConcept formats title + type + description", () => {
  const c = { id: "x", path: "", relPath: "x.md", frontmatter: {}, body: "", type: "Metric", title: "active", description: "count", tags: undefined };
  expect(describeConcept(c)).toBe("active [Metric] — count");
});

test("conceptKey builds bundle::id", () => {
  expect(conceptKey("b", "a/b")).toBe("b::a/b");
});
