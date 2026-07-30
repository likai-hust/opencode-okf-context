import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  dts: false, // declarations are generated separately by `tsc --emitDeclarationOnly`
  splitting: false,
  sourcemap: true,
  clean: true,
  // Bundle everything (yaml, @opencode-ai/plugin, @opencode-ai/sdk) into a single
  // self-contained file. We do NOT mark @opencode-ai/plugin as external because the
  // plugin may run in environments where that package isn't resolvable (e.g. a bare
  // ~/.cache/opencode/node_modules install). A self-contained bundle always works.
  noExternal: [/^yaml$/, /^@opencode-ai\/(plugin|sdk)$/],
  external: [],
});
