import { defineConfig } from "tsup";

// Two entries, one dist. The plugin entry (index.ts) runs inside the opencode runtime
// (Bun), the CLI entry (cli.ts) must also run on plain Node — where the bundled `yaml`
// CJS code (require("process")) needs a real `require` under ESM. Hence the separate
// banner on the CLI config only.
export default defineConfig([
  {
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
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node18",
    platform: "node",
    outDir: "dist",
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false, // the plugin entry (built first) owns cleaning the dist dir
    banner: {
      js: "import { createRequire as __okfCreateRequire } from 'node:module'; const require = __okfCreateRequire(import.meta.url);",
    },
    noExternal: [/^yaml$/],
    external: [],
  },
]);
