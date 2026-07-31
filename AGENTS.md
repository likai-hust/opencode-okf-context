# AGENTS.md

Guidance for AI coding agents working in this repository.
Read this before making changes.

## What this project is

`opencode-okf-context` is an [OpenCode](https://opencode.ai) plugin (v0.1.2, MIT) that brings
**progressive disclosure** and **use-and-unload** semantics to [OKF (Open Knowledge Format)](https://github.com/GoogleCloudPlatform/knowledge-catalog)
knowledge bundles. It lets an agent read a whole knowledge base without permanently bloating its
context window.

Core idea: unlike [DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (which
prunes via LLM summaries), this plugin exploits OKF's native structure (`description` frontmatter,
`index.md`) to do **deterministic, zero-extra-token** disclosure/unloading. It rewrites message
history *on the way to the LLM* only — it never mutates the real session history.

> **Companion, not competitor:** there is a separate community `opencode-okf` package focused on
> *authoring & validating* OKF bundles. This plugin handles *reading & context management* only.

## Tech stack & commands

- **Language:** TypeScript (strict, ESM, ESNext, Node 18+).
- **Runtime/dev:** [Bun](https://bun.sh) — `bun install`, `bun test`.
- **Build:** [tsup](https://tsup.egoist.dev) (bundles to a single self-contained JS) + `tsc` (`.d.ts`).
- **Plugin SDK:** `@opencode-ai/plugin` / `@opencode-ai/sdk` — **peerDependencies provided by the
  opencode runtime**; the published package has **zero external runtime deps** (even `yaml` is bundled).

```bash
bun install
bun test            # 67 tests across core / messages / write / validate / search / robustness / integration
bunx tsc --noEmit   # type-check (must pass before any commit)
bun run build       # tsup -> dist/index.js (single self-contained file) + tsc d.ts
npm pack            # produces opencode-okf-context-0.1.2.tgz
```

**Always run `bun test` + `bunx tsc --noEmit` before committing.** Do not commit if either fails.

## Architecture map

```
src/
  index.ts        plugin entry: wires discovery + tools + transform hooks
  discovery.ts    bundle scanning & OKF concept parsing (fs traversal here; parsing pure)
  frontmatter.ts  YAML frontmatter split / serialize (uses `yaml` package)
  config.ts       layered okf.jsonc loading (JSONC strip + deep merge)
  state.ts        in-memory bundle cache + per-session unload/nudge state (singleton)
  registry.ts     bundle/concept resolution, placeholders, glob matching (pure, dependency-free)
  indexing.ts     L0 manifest + L1 index rendering (auto-synthesizes missing index.md)
  tools.ts        the 6 okf_* tools (list/read/search/write/validate/unload)
  validate.ts     concept- + bundle-level validation rules + link extraction (pure)
  messages.ts     outbound transform: dedup + auto/manual unload + soft nudge
tests/            core, messages (unload/dedup/nudge), write, validate, search, robustness, integration
fixtures/sample-bundle/   a 3-concept OKF bundle for dogfooding & tests
.opencode/plugin/okf.ts   local-dev re-export so the plugin dogfoods in this repo
```

### The three disclosure layers (how context is managed)

- **L0 manifest** — always in the system prompt (`index.ts` system.transform). Bundle list + counts.
- **L1 index** — on demand via `okf_list`. Titles + descriptions only (no full bodies).
- **L2 full text** — on demand via `okf_read`. Full concept enters context; has a lifetime.

After N user turns (default 2) or on `okf_unload`, an L2 `okf_read` output is replaced by a compact
placeholder (title + type + description) in the **outbound** messages only (`messages.ts`). The real
history is untouched.

## The 6 tools (registered in `tools.ts` `buildTools`)

| tool | purpose |
|---|---|
| `okf_list` | browse a bundle/sub-directory index (titles + descriptions only) |
| `okf_read` | load one concept, or a batch via `ids` (unloads as a unit); footer reminds to unload |
| `okf_search` | metadata-first keyword search (title/description/tags), body only as fallback |
| `okf_write` | create/update/delete a concept. **`update` = partial update** (only passed fields change); **`delete`** removes file + index entry + logs it |
| `okf_validate` | read-only validation; concept-level rules + (all:true) bundle-level (okf_version/log/links); emits ready-to-run `okf_write` fix commands |
| `okf_unload` | release concept(s) from context immediately |

## OKF format essentials (v0.2)

Per the [official SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md):

- **Concept** = a `.md` file with optional YAML frontmatter. The **only required frontmatter key is
  `type`**. Convenience keys: `type`, `title`, `description`, `tags`.
- **Bundle** = a directory tree of concepts + reserved files.
- **Reserved files** (must NOT be concepts): `index.md` (directory listing), `log.md` (changelog).
- **Concept ID** = file's relative path without `.md`, POSIX separators (e.g. `tables/customers`).
- **`okf_version`** — a bundle-root `index.md` **MAY** declare it (spec says MAY, optional). ⚠️ But
  this plugin's *auto-scan* treats it as the marker for recognizing a bundle root (see caveat below).

### Bundle-root detection heuristic

Auto-scan (`discovery.ts` `isBundleRoot`) accepts a directory when either:
1. its root `index.md` declares `okf_version` (spec §12 marker), **OR**
2. it has an `index.md` or `log.md` AND at least one concept with a `type` key.

Condition 2 was added to honor the spec's MAY-level `okf_version` (previously a spec-valid bundle
without it wasn't auto-discovered). Ordinary markdown projects (no index/log/typed concepts) are
still not mis-classified; edge cases can always be declared via explicit `bundles` config.

## Key conventions (follow these when editing)

1. **Pure vs. I/O separation.** Keep pure logic out of filesystem code so it's unit-testable:
   `discovery.ts` (fs traversal) calls `parseConcept`/`indexDeclaresBundle` (pure).
   `registry.ts`, `validate.ts`, `frontmatter.ts` helpers are pure and dependency-free.
2. **Tools return strings** (opencode renders tool output as text). `okf_read` output is the ONLY
   output the messages-transform layer tracks for placeholder substitution.
3. **`okf_write` partial update is load-bearing.** In `mode: "update"`, only passed fields change;
   the rest are read from disk and preserved. This is what makes `okf_validate`'s fix commands safe
   to run. Do not regress it to full overwrite. After any write, call `state.markStale()` so the
   in-memory bundle cache refreshes.
4. **Never mutate real session history.** All unload/dedup/nudge happens in the *outbound* transform
   (`messages.ts`) only.
5. **`yaml` is bundled**, not a runtime dep. `tsup.config.ts` marks `yaml` and `@opencode-ai/*` as
   `noExternal` to produce a self-contained single file.
6. **Config is layered** (global → env → project → plugin options), deep-merged via `mergeConfig`.
   Arrays are replaced, not concatenated.

## Testing patterns

- Tests use `bun:test`. Pure-function tests call exports directly; integration tests load the real
  `OkfPlugin` entry and exercise hooks + tools end-to-end (no opencode server needed).
- Throwaway bundles are created in `os.tmpdir()` (see `tests/write.test.ts` `cloneFixture`,
  `tests/validate.test.ts` `setupTempBundle`). Always `rm` them in `finally` + `state.markStale()`.
- A bundle root needs an `index.md` with `okf_version: "0.2"` + an (empty) `log.md` to be recognized.

## Config schema

`okf.schema.json` (root) is a JSON Schema (draft-07) for the **plugin config file** `okf.jsonc` — it
validates config keys (`enabled`, `scan`, `bundles`, `disclosure`, `unload`, `nudge`, `write`,
`protectedConcepts`, `debug`). It is **NOT** a schema for OKF concept documents. A copy lives at
`release/okf.schema.json` (keep them in sync if you change config).

## Build artifacts (gitignored — never commit)

`dist/`, `release/`, `*.tgz`, `*.tar.gz` are build products regenerated from source. The offline
distribution is `opencode-okf-context-0.1.2-offline.tar.gz` (contains `okf.js` + `INSTALL.txt` +
`okf.schema.json`); rebuild it with `bun run build` then re-tar from `release/`.

## Commit & push

- Default branch: `main`. Commits to `main` are pushed to `origin` on request.
- Do not commit failing tests or type errors. Do not commit build artifacts.
- Keep `README.md` and `README.zh-CN.md` in sync (they mirror each other section-for-section).
