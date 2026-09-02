/**
 * Version stamping tests.
 *
 * The plugin self-reports its version in the manifest, the okf_list bundle overview,
 * and the okf_validate report — so a user can always tell WHICH build is actually
 * loaded (opencode's `@latest` package cache can go stale, and a hand-edited dist
 * is otherwise invisible). These tests pin that behavior and keep src/version.ts
 * in sync with package.json.
 */
import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderManifest } from "../src/indexing.js";
import { PLUGIN_VERSION } from "../src/version.js";

const PROJECT = join(import.meta.dir, "..");

test("PLUGIN_VERSION matches package.json (drift gate)", async () => {
  const pkg = JSON.parse(await readFile(join(PROJECT, "package.json"), "utf8"));
  expect(PLUGIN_VERSION).toBe(pkg.version);
});

test("manifest self-reports the plugin version", () => {
  const bundles = [
    {
      name: "kb",
      root: "/x",
      concepts: new Map(),
      indexDirs: new Set(["."]),
      hasLog: false,
      origin: "config" as const,
    },
  ];
  const manifest = renderManifest(bundles as any, 2000);
  expect(manifest).toContain(`opencode-okf-context v${PLUGIN_VERSION}`);
});
