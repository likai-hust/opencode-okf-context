# opencode-okf-context

English | [简体中文](./README.zh-CN.md)

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
| `okf_search` | `query`, `bundle?`, `maxResults?` | searches metadata first (title/description/tags); falls back to body only when metadata matches nothing. Returns concise refs + a snippet, never full bodies |
| `okf_write` | `id`, `type?`, `title?`, `description?`, `tags?`, `body?`, `bundle?`, `mode?` | creates/updates a concept. In `update` mode (default) only passed fields change — others are preserved from disk, so you can fix one field without restating the whole doc. Updates the parent `index.md`; prepends to `log.md` |
| `okf_validate` | `id?` or `all: true`, `bundle?` | read-only validation report (concept-level rules); each issue comes with a ready-to-run `okf_write(...)` fix command |
| `okf_unload` | `id?` or `all: true`, `bundle?` | marks concept(s) for immediate unload; reports the action |

### Validation & repair

`okf_validate` checks each concept against the OKF concept rules and reports issues with severity + a fix command:

```
✓ Validated 3 concept(s) in bundle "demo": 1 valid, 2 with issues (1 error, 3 warnings).

▶ tables/bad_tags  (bundle: demo, 2 issues)
  ⚠ [warning] title: `title` is missing; defaulting to the concept id "bad_tags".
    → fix: okf_write(id: "tables/bad_tags", bundle: "demo", mode: "update", title: "bad_tags")
  ⚠ [warning] tags: `tags` is "core" (string); it should be an array of strings.
    → fix: okf_write(id: "tables/bad_tags", bundle: "demo", mode: "update", tags: ["core"])

▶ tables/bad_type  (bundle: demo, 2 issues)
  ✗ [error] type: `type` is missing or empty. The OKF spec requires `type` …
    → fix: okf_write(id: "tables/bad_type", bundle: "demo", mode: "update", type: "<your type, …>")
```

Rules (concept-level only):

| code | severity | fires when | auto-fixable? |
|---|---|---|---|
| `type-missing` | error | `type` is empty (spec's only hard requirement) | ❌ needs your input |
| `type-not-string` | warning | `type` isn't a string | ✅ coerced to `String(type)` |
| `frontmatter-missing` | error | no `---` block at all | ✅ scaffolded |
| `title-missing` | warning | `title` is empty | ✅ defaults to the id basename |
| `description-missing` | warning | `description` is empty (drives progressive disclosure) | ❌ needs your input |
| `tags-not-array` | warning | `tags` isn't a string array | ✅ normalized to `string[]` |
| `body-empty` | warning | markdown body is empty | ❌ needs your input |

`okf_validate` never writes files. To repair, run the `okf_write` commands it emits — each uses `mode: "update"`, so only the listed field changes and everything else is preserved. Issues marked ❌ require content the validator can't fabricate, so they appear as templates with a `<placeholder>` for you to fill in.

## Install (local development)

opencode auto-loads `.opencode/plugin/*.ts` in a project, so this repo dogfoods itself:

```bash
cd opencode-okf-context
bun install
# The sample bundle at fixtures/sample-bundle is auto-discovered.
opencode
```

`.opencode/plugin/okf.ts` re-exports `src/index.ts`. Verify registration with:

```bash
opencode debug agent build | grep okf   # -> okf_list/read/search/write/validate/unload: true
```

## Install

opencode auto-loads any `*.js`/`*.ts` file placed in its plugin directories. Three ways to install:

### Option 1: offline / air-gapped (single self-contained file)

A fully bundled, zero-dependency `okf.js` is the simplest form for restricted networks. Grab the offline bundle from the [latest release](https://github.com/likai-hust/opencode-okf-context/releases) (e.g. `opencode-okf-context-0.1.1-offline.tar.gz`) or build it, then drop the file into opencode's plugin directory:

```bash
mkdir -p ~/.config/opencode/plugin          # global (all projects)
tar -xzf opencode-okf-context-0.1.1-offline.tar.gz -C ~/.config/opencode/plugin okf.js
# or, per-project: .opencode/plugin/okf.js
opencode debug agent build | grep okf       # verify the 6 tools registered
```

To build the offline file yourself from this repo:

```bash
cd opencode-okf-context
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
{ "plugin": ["/absolute/path/to/opencode-okf-context"] }
```

> The repo ships with `.opencode/plugin/okf.ts` re-exporting `src/index.ts` — point `plugin` at the repo root and opencode auto-discovers it, no extra config needed.

### A note on the package name

There is a separate, community-published `opencode-okf` package focused on **authoring & validating** OKF bundles (`/okf-create`, `/okf-validate`, …). This plugin (`opencode-okf-context`) is complementary — it handles **reading & context management**. The two can be installed together without conflict.

## Configuration

Layered, DCP-style. Later layers override earlier (deep-merged):

1. `~/.config/opencode/okf.jsonc` (global)
2. `$OPENCODE_CONFIG_DIR/okf.jsonc` (if set)
3. `<project>/.opencode/okf.jsonc` (project)
4. plugin options from `opencode.json` (`["opencode-okf-context", {...}]`) — highest precedence

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

### Config reference

| field | default | description |
|---|---|---|
| `enabled` | `true` | master switch for the plugin |
| `scan.enabled` | `true` | auto-scan the project root to discover bundles |
| `scan.maxDepth` | `4` | max directory depth for auto-scan |
| `bundles` | `[]` | explicitly declared bundles, merged with scan results (config wins on conflict) |
| `disclosure.injectManifest` | `true` | inject the L0 manifest into the system prompt |
| `disclosure.maxManifestChars` | `2000` | char cap for the injected manifest |
| `unload.afterTurns` | `2` | auto-unload after this many user turns since load |
| `unload.keepRecent` | `1` | never auto-unload the N most recent reads |
| `unload.placeholder` | `"description"` | placeholder verbosity: `description` (title + description) or `minimal` (reload hint only) |
| `nudge.threshold` | `6000` | soft-nudge when retained OKF content exceeds this many chars |
| `nudge.frequency` | `3` | inject the nudge at most once every N user messages |
| `write.enabled` | `true` | enable `okf_write` |
| `write.updateIndex` | `true` | update the parent `index.md` when writing a concept |
| `write.appendLog` | `true` | prepend to `log.md` under today's ISO date heading when writing a concept |
| `protectedConcepts` | `[]` | concept id globs never auto-unloaded (e.g. `tables/*`) |
| `debug` | `false` | log unload/dedup/nudge actions to stderr |

## Coexisting with DCP

opencode-okf and DCP compose cleanly — they touch different things:

- DCP prunes generic stale tool outputs / message ranges (with LLM summaries).
- opencode-okf only rewrites its own `okf_read` outputs, into tiny deterministic placeholders.
- An unloaded placeholder is already small, so DCP has nothing further to compress there.

No special configuration is required to run both.

## Development

```bash
bun install
bun test            # 54 tests across core / messages / write / validate / search / integration
bunx tsc --noEmit   # type-check
```

Test fixtures live in [`fixtures/sample-bundle`](./fixtures/sample-bundle). The integration test
loads the real plugin entry and exercises the hooks + tools end-to-end without an opencode server.

## Build & publish

```bash
bun run build       # tsup bundles JS (yaml already bundled) + tsc emits d.ts
npm pack            # produces opencode-okf-context-0.1.1.tgz
npm publish         # publish to npm (npm login first)
```

Build output lives in `dist/`. `@opencode-ai/plugin` is a peerDependency provided by the opencode runtime, so the package itself has zero external runtime dependencies.

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
  tools.ts        the 6 okf_* tools (incl. okf_validate)
  validate.ts     concept-level validation rules (pure; used by okf_validate)
  messages.ts     outbound transform: dedup + auto/manual unload + soft nudge
tests/            core, messages (unload/dedup/nudge), write, validate, search, integration
fixtures/sample-bundle/   a 3-concept OKF bundle for dogfooding & tests
.opencode/plugin/okf.ts   local-dev re-export so the plugin loads in this repo
```

## Scope / non-goals (v1)

- No LLM-generated summaries (OKF's `description` is the deterministic summary).
- No "strong"/blocking nudge tier (only soft).
- No Attested Computation execution.
- Validation is **concept-level only** (frontmatter `type`/`title`/`description`/`tags` + body). Bundle-structure checks (root `index.md` `okf_version`, `log.md` presence, cross-link integrity) are out of scope — those belong with the authoring-focused `opencode-okf` package.
- Not yet published to npm (the layout is publish-ready; run `bun run build` / add a build step before publishing).

## License

MIT
