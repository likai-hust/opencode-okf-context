# opencode-okf

An [OpenCode](https://opencode.ai) plugin that brings **progressive disclosure** and **use-and-unload** semantics to [OKF (Open Knowledge Format)](https://github.com/GoogleCloudPlatform/knowledge-catalog) knowledge bundles — so your agent can read a whole knowledge base without permanently bloating its context window.

It is directly inspired by [opencode-dynamic-context-pruning (DCP)](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning): like DCP, it never mutates the real session history and only rewrites the message history *on the way to the LLM*. But where DCP prunes generic stale content via LLM-generated summaries, opencode-okf exploits OKF's native structure (YAML frontmatter `description`, `index.md`) to do **deterministic**, zero-extra-token disclosure and unloading.

## How it works

```
L0 manifest (always in system prompt, ~hundreds of chars)
   bundle list + root index (titles + descriptions) + usage instructions
        │ okf_list
L1 index (on demand, small) ─────────────────────────────┐
   a bundle / sub-directory index (titles + descriptions, no full bodies)
        │ okf_read  /  okf_search
L2 full text (on demand, large, has a lifetime)
   the concept's full markdown enters context
        │ after N user turns (default 2)  ·  or  okf_unload
unload: full text → placeholder
   "[OKF] concept tables/customers unloaded — ~3.2k chars freed.
    Summary retained: customers [BigQuery Table] — Customer master table…
    Reload with okf_read(id: \"tables/customers\")."
```

Three mechanisms, borrowed from / complementary to DCP:

| mechanism | what happens |
|---|---|
| **deterministic unload** | a loaded concept's `okf_read` output is replaced by a compact placeholder (title + type + description) once enough turns pass, or on explicit `okf_unload`. No LLM summarization call. |
| **deduplication** | if the same concept is read twice, only the latest full text survives; earlier reads collapse to a "deduplicated" placeholder. |
| **soft nudge** | when retained OKF content exceeds a threshold, a one-line reminder is anchored onto the last user message (never a new message), throttled by message count. |

Protection: the `keepRecent` most recent reads are never auto-unloaded; `protectedConcepts` globs are never unloaded; explicit `okf_unload` always wins.

## Tools

| tool | args | returns |
|---|---|---|
| `okf_list` | `bundle?`, `path?` | a bundle / sub-directory index (titles + descriptions only) |
| `okf_read` | `id`, `bundle?` | the full concept markdown + a footer reminding the model to unload when done |
| `okf_search` | `query`, `bundle?`, `maxResults?` | matched concept refs + a snippet line, never full bodies |
| `okf_write` | `id`, `type`, `title?`, `description?`, `tags?`, `body`, `bundle?`, `mode?` | creates/updates a concept; updates the parent `index.md`; prepends to `log.md` |
| `okf_unload` | `id?` or `all: true`, `bundle?` | marks concept(s) for immediate unload; reports the action |

## Install (local development)

opencode auto-loads `.opencode/plugin/*.ts` in a project, so this repo dogfoods itself:

```bash
cd okf-plugin
bun install
# The sample bundle at fixtures/sample-bundle is auto-discovered.
opencode
```

`.opencode/plugin/okf.ts` re-exports `src/index.ts`. Verify registration with:

```bash
opencode debug agent build | grep okf   # -> okf_list/read/search/write/unload: true
```

## Install

opencode auto-loads any `*.js`/`*.ts` file placed in its plugin directories. Three ways to install:

### Option 1: offline / air-gapped (single self-contained file)

A fully bundled, zero-dependency `okf.js` is the simplest form for restricted networks. Grab the offline bundle (`opencode-okf-context-0.1.0-offline.tar.gz`) or build it, then drop the file into opencode's plugin directory:

```bash
mkdir -p ~/.config/opencode/plugin          # global (all projects)
tar -xzf opencode-okf-context-0.1.0-offline.tar.gz -C ~/.config/opencode/plugin okf.js
# or, per-project: .opencode/plugin/okf.js
opencode debug agent build | grep okf       # verify the 5 tools registered
```

To build the offline file yourself from this repo:

```bash
cd okf-plugin
bun install
bun run build        # produces dist/index.js (everything bundled: yaml, @opencode-ai/* )
cp dist/index.js ~/.config/opencode/plugin/okf.js
```

Upgrade = overwrite `okf.js` and restart opencode. Uninstall = delete the file.

### Option 2: from npm

```bash
opencode plugin opencode-okf-context@latest --global
```

or add to `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["opencode-okf-context@latest"] }
```

### Option 3: from a local directory (dev/debug)

Point the `plugin` array at this repo — opencode runs `.ts` via Bun, so edits take effect on restart:

```jsonc
// ~/.config/opencode/opencode.json
{ "plugin": ["/Users/likai/workspace/okf-plugin"] }
```

> The repo ships with `.opencode/plugin/okf.ts` re-exporting `src/index.ts` — point `plugin` at the repo root and opencode auto-discovers it, no extra config needed.

### A note on the package name

There is a separate, community-published `opencode-okf` package focused on **authoring & validating** OKF bundles (`/okf-create`, `/okf-validate`, …). This plugin (`opencode-okf-context`) is complementary — it handles **reading & context management**. The two can be installed together without conflict.

## Configuration

Layered, DCP-style. Later layers override earlier (deep-merged):

1. `~/.config/opencode/okf.jsonc` (global)
2. `$OPENCODE_CONFIG_DIR/okf.jsonc` (if set)
3. `<project>/.opencode/okf.jsonc` (project)
4. plugin options from `opencode.json` (`["opencode-okf", {...}]`) — highest precedence

```jsonc
// .opencode/okf.jsonc
{
  "enabled": true,
  "scan":   { "enabled": true, "maxDepth": 4, "ignore": [] },
  "bundles": [{ "path": "docs/knowledge", "name": "project-kb" }],
  "disclosure": { "injectManifest": true, "maxManifestChars": 2000 },
  "unload": {
    "afterTurns": 2,          // unload after 2 user turns
    "keepRecent": 1,          // never auto-unload the most recent read
    "placeholder": "description"
  },
  "nudge":   { "threshold": 6000, "frequency": 3, "force": "soft" },
  "write":   { "enabled": true, "updateIndex": true, "appendLog": true },
  "protectedConcepts": ["tables/*"],
  "debug": false
}
```

Full schema: [`okf.schema.json`](./okf.schema.json).

## Coexisting with DCP

opencode-okf and DCP compose cleanly — they touch different things:

- DCP prunes generic stale tool outputs / message ranges (with LLM summaries).
- opencode-okf only rewrites its own `okf_read` outputs, into tiny deterministic placeholders.
- An unloaded placeholder is already small, so DCP has nothing further to compress there.

No special configuration is required to run both.

## Development

```bash
bun install
bun test            # 31 tests across core / messages / write / integration
bunx tsc --noEmit   # type-check
```

Test fixtures live in [`fixtures/sample-bundle`](./fixtures/sample-bundle). The integration test
loads the real plugin entry and exercises the hooks + tools end-to-end without an opencode server.

## Project layout

```
src/
  index.ts        plugin entry: wires discovery + tools + transform hooks
  discovery.ts    bundle scanning & OKF concept parsing
  frontmatter.ts  YAML frontmatter split / serialize
  config.ts       layered okf.jsonc loading (JSONC strip + deep merge)
  state.ts        in-memory bundle cache + per-session unload/nudge state
  registry.ts     bundle/concept resolution, placeholders, glob matching
  indexing.ts     L0 manifest + L1 index rendering (auto-synthesizes missing index.md)
  tools.ts        the 5 okf_* tools
  messages.ts     outbound transform: dedup + auto/manual unload + soft nudge
tests/            core, messages (unload/dedup/nudge), write, integration
fixtures/sample-bundle/   a 3-concept OKF bundle for dogfooding & tests
.opencode/plugin/okf.ts   local-dev re-export so the plugin loads in this repo
```

## Scope / non-goals (v1)

- No LLM-generated summaries (OKF's `description` is the deterministic summary).
- No "strong"/blocking nudge tier (only soft).
- No Attested Computation execution.
- Not yet published to npm (the layout is publish-ready; run `bun run build` / add a build step before publishing).

## License

MIT
