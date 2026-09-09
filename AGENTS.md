# AGENTS.md

Guidance for AI coding agents working in this repository.
Read this before making changes.

## What this project is

`opencode-okf-context` is an [OpenCode](https://opencode.ai) plugin (v0.3.0, MIT) that brings
**progressive disclosure** and **use-and-unload** semantics to [OKF (Open Knowledge Format)](https://github.com/GoogleCloudPlatform/knowledge-catalog)
knowledge bundles. It lets an agent read a whole knowledge base without permanently bloating its
context window. Knowledge bases can live in the project, be declared via `bundles`, or be
**git-hosted remotes** synced into a shared local cache (`remotes` config).

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
bun test            # 165 tests across core / messages / write / validate / search / robustness / integration / version / sync / unload-dataset / prompt-trigger / cli / defaults / reload-e2e / compaction-e2e / efficiency-e2e (opt-in)
bunx tsc --noEmit   # type-check (must pass before any commit)
bun run build       # tsup -> dist/index.js (single self-contained file) + tsc d.ts
npm pack            # produces opencode-okf-context-0.3.0.tgz
```

**Always run `bun test` + `bunx tsc --noEmit` before committing.** Do not commit if either fails.

## Architecture map

```
src/
  index.ts        plugin entry: wires discovery + tools + transform hooks
  discovery.ts    bundle scanning & OKF concept parsing (fs traversal here; parsing pure)
  frontmatter.ts  YAML frontmatter split / serialize (uses `yaml` package)
  config.ts       layered okf.jsonc loading (JSONC strip + deep merge) + RemoteSource schema
  sync.ts         remote knowledge sources: git clone/fetch+reset into a shared cache
                  (~/.cache/opencode-okf/remotes/<hash(url+ref)>, override $OKF_REMOTE_CACHE),
                  offline degrade to cache, env-var token auth (never in okf.jsonc),
                  remoteBundleEntries() turns synced checkouts into configured bundles;
                  every sync appends to <cacheRoot>/sync.log ($OKF_SYNC_LOG) — status/
                  duration/commit/bundles, success included, rotated at 512KB, NEVER
                  containing the remote URL (ssh URLs embed user@host; git errors are
                  sanitized too); setSyncDebug(cfg.debug) mirrors lines to stderr
  state.ts        in-memory bundle cache + per-session unload/nudge state (singleton)
  registry.ts     bundle/concept resolution, placeholders, glob matching (pure, dependency-free)
  indexing.ts     L0 manifest + L1 index rendering (auto-synthesizes missing index.md)
  tools.ts        thin tool() wrappers over operations.ts — tool descriptions live here (wording contract)
  operations.ts   shared op layer: business logic of the 7 tools + dual-syntax rendering
                  (syntax "tool" = plugin output, byte-identical; "cli" = shell-style hints,
                  footer that never mentions okf_unload) + read intake control (fields/section/maxChars)
                  + remote-bundle write guard (origin "remote" → okf_write refuses)
  cli.ts          the `okf` bin (dist/cli.js): same operations for non-opencode agents, humans, CI.
                  Read-only by default (--write or .okf.jsonc write.enabled); exit codes 0/1/2.
                  `okf sync` force-updates remotes (exit 1 on failure, CI gate); other commands
                  clone on first use then run from cache (--sync / --no-sync to override)
  validate.ts     concept- + bundle-level validation rules + link extraction (pure)
  messages.ts     outbound transform: dedup (reads + searches) + auto/manual unload + search-result aging + soft nudge
  version.ts      PLUGIN_VERSION — self-reported in manifest/overview/validate (synced to package.json by test)
tests/            core, messages (unload/dedup/nudge), write, validate, search, robustness, integration,
                  version, sync (real local git repos via file:// URLs), unload-dataset, prompt-trigger,
                  cli, defaults, reload-e2e, compaction-e2e, efficiency-e2e (opt-in)
benchmark/        stress benchmark + hit-rate measurement for the intranet sharing deck:
                  stress.ts (S0 script baseline via real python subprocess / S1 no-unload /
                  S2 defaults), baseline_reader.py, hitrate.ts (placeholder fact-retention);
                  outputs results*.md / hitrate.md — NOT part of `bun test` (run manually)
fixtures/sample-bundle/   a 3-concept OKF bundle for dogfooding & tests
.opencode/plugin/okf.ts   local-dev re-export so the plugin dogfoods in this repo
```

### The three disclosure layers (how context is managed)

- **L0 manifest** — always in the system prompt (`index.ts` system.transform). Bundle list + counts.
- **L1 index** — on demand via `okf_list`. Titles + descriptions only (no full bodies).
- **L2 full text** — on demand via `okf_read`. Full concept enters context; has a lifetime.

After N user turns (default 4) or on `okf_unload`, an L2 `okf_read` output is replaced by a compact
placeholder (title + type + description) in the **outbound** messages only (`messages.ts`). The real
history is untouched.

## The 7 tools (registered in `tools.ts` `buildTools`)

| tool | purpose |
|---|---|
| `okf_list` | browse a bundle/sub-directory index (titles + descriptions only) |
| `okf_read` | load one concept, or a batch via `ids` (unloads as a unit); footer reminds to unload; output also annotates outgoing + incoming reference metadata so the model can decide whether to follow a cross-link without another `okf_list` |
| `okf_search` | metadata-first keyword search (title/description/tags), body only as fallback |
| `okf_write` | create/update/delete a concept. **`update` = partial update** (only passed fields change); **`delete`** removes file + index entry + logs it |
| `okf_validate` | read-only validation; concept-level rules + (all:true) bundle-level (okf_version/log/links); emits ready-to-run `okf_write` fix commands |
| `okf_unload` | release concept(s) from context immediately |
| `okf_refs` | query a concept's reference graph (incoming + outgoing neighbors, metadata only) via a real-time backlink scan; no body loaded — use for impact analysis ("who depends on X?") |

### The `okf` CLI (package bin)

`src/cli.ts` builds `dist/cli.js`, shipped as the package's `okf` bin — the same
`operations.ts` logic for environments the plugin cannot reach: other coding agents (via
their shell tool), humans, and CI (`okf validate --all` works as a repo gate, exit 1 on
errors). Contracts that differ from the plugin, by design:

- **CLI read footer never mentions `okf_unload`** — there is no unload outside opencode.
  The CLI's context lever is intake control: `--fields` / `--section <h>` / `--max-chars N`
  (asserted by tests/cli.test.ts).
- **Read-only by default**: `write`/`update`/`delete` need `--write` or
  `write.enabled: true` in `.okf.jsonc`. Config comes from `loadCliConfig` —
  `<project>/.okf.jsonc` only, NOT the opencode-layered paths.
- `okf manifest` prints a CLI-flavored L0 snippet (renderCliManifest in cli.ts) for
  pasting into non-opencode agents' rule files (AGENTS.md / CLAUDE.md).
- `okf sync` force-updates all `remotes` (exit 1 if any fails — a CI gate alongside
  `okf validate --all`). Other commands sync remotes in "on-clone" mode (clone once on
  first use, then cache-only) — routine reads never touch the network. `--sync` forces
  an update, `--no-sync` skips remote sync entirely.
- The CLI must run on plain Node 18 (not just Bun): the tsup CLI entry carries a
  `createRequire` banner because bundled `yaml` CJS does `require("process")`.

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

**Nested bundles:** a directory inside an accepted bundle is still accepted as its OWN bundle when
its `index.md` explicitly declares `okf_version` (condition 1 only — the spec marker). Heuristic
(condition 2) roots nested inside a bundle stay suppressed. When a nested bundle is accepted, its
subtree is EXCLUDED from the outer bundle's concepts. This keeps a real knowledge bundle (e.g.
`doca/wiki/`) discoverable even if a project root was also detected as a bundle (e.g. via an
AI-created root index.md). See tests/robustness.test.ts H4.

**Hidden directories:** scan skips all dot-directories **except `.opencode`** — it is opencode's
config dir but commonly hosts skill/knowledge bundles (e.g. `.opencode/skill/`), so it is traversed
like a normal directory. `SKIP_DIRS` (`node_modules`, `.git`, `dist`, `build`, `out`, `.next`,
`.turbo`, `.cache`, `coverage`, `.hg`, `.svn`) still apply at any depth — including inside
`.opencode`. Dot-files are always skipped. See tests/robustness.test.ts H5.

**Version self-report:** `version.ts` PLUGIN_VERSION is stamped into the L0 manifest, the
`okf_list` bundle overview, and the `okf_validate` report header — so users can verify which
build is actually loaded (opencode's `@latest` package cache can go stale). A drift-gate test
keeps it in sync with package.json.

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
7. **Remote bundles are read-only.** `remotes` sync git-hosted knowledge bases into a shared
   cache (`sync.ts`) and register them with `origin: "remote"`; `okf_write` refuses them (a
   `reset --hard` on the next sync would clobber local edits). Never weaken this guard, and
   never write auth tokens into okf.jsonc — `auth: "env:VARNAME"` reads them from the
   environment at sync time. Sync failures must always degrade (cache / skip), never break
   plugin load.

## Testing patterns

- Tests use `bun:test`. Pure-function tests call exports directly; integration tests load the real
  `OkfPlugin` entry and exercise hooks + tools end-to-end (no opencode server needed).
- Throwaway bundles are created in `os.tmpdir()` (see `tests/write.test.ts` `cloneFixture`,
  `tests/validate.test.ts` `setupTempBundle`). Always `rm` them in `finally` + `state.markStale()`.
- A bundle root needs an `index.md` with `okf_version: "0.2"` + an (empty) `log.md` to be recognized.

### Mandatory test gates for prompt / context / unload changes

Any change touching **source code that affects what the model sees or when content is
released from context** MUST pass these in addition to the full suite — this is the
plugin's core promise, don't ship a regression:

1. **`tests/messages.test.ts`** — unload/dedup/nudge unit tests. Any change to
   `src/messages.ts` (transform logic), `src/registry.ts` (placeholders), or
   `src/config.ts` (unload/nudge defaults) requires this file green.
2. **`tests/prompt-trigger.test.ts`** — prompt wording guards (always run, zero cost)
   + **opt-in E2E hit-rate suite**: run `OKF_TRIGGER_E2E=1 bun test tests/prompt-trigger.test.ts`
   after any change to `src/indexing.ts` (L0 manifest), `src/tools.ts` (tool descriptions),
   or `src/messages.ts` (nudge text). It fires real natural-language queries at a live
   `opencode run` in this repo and measures okf_* trigger rate (costs real LLM API; ~3 min).
   Note: the fixture bundle auto-scans as `opencode-okf-context` (project root) + `unload-bundle`
   + `sample-bundle` in a live run — assertions must target `unload-bundle`.
3. **`tests/unload-dataset.test.ts`** — disk dataset (`fixtures/unload-bundle/`, 40 concepts,
   3 docs > 6000 chars) + parameterized unload scenarios + the **8-turn context-size
   trajectory** (proves unload genuinely shrinks bytes sent to the LLM vs a no-unload control).
   Required after any change to `src/messages.ts`, `src/config.ts`, or `src/state.ts`.
4. **`tests/reload-e2e.test.ts` + `tests/compaction-e2e.test.ts`** — opt-in live LLM gates
   (`OKF_RELOAD_E2E=1` / `OKF_COMPACTION_E2E=1`, real API ~9/~5 min): after auto-unload,
   does the model follow the placeholder's reload hint (reload-e2e); after a simulated
   compaction, does the manifest still drive okf_* KB access (compaction-e2e; its control
   arms use `opencode run --pure` = plugin off). Run after ANY change to placeholder
   wording (`placeholderFor`, `searchPlaceholder`, `searchDedupPlaceholder`, read footer)
   or the L0 manifest.
5. **Full suite + typecheck**: `bun test` + `bunx tsc --noEmit` (currently 165 tests).

Prompt wording is a *contract*: `tests/prompt-trigger.test.ts` static guards pin the exact
wording (reactive/proactive triggers, bilingual phrases, decision guide, `okf_search`
scenario-first description); the search placeholders' anti-reload-loop wording is pinned in
`tests/messages.test.ts`. If a wording change is intentional, update the guards in the
same commit.

### Test dataset (fixtures/unload-bundle/)

40-concept OKF bundle (tables / metrics / glossary / runbooks / reference) built for
multi-turn unload testing. 3 reference docs (`sla_policy`, `api_schema`, `compliance`) exceed
6000 chars to cross the nudge threshold used *explicitly* by the tests (`threshold: 6000` —
the shipped default is 25000, tuned for large context windows; tests/defaults.test.ts pins
it); `data_model` / `ownership_matrix` are mid-sized for accumulation scenarios. All
frontmatter values are JSON-quoted (a bare `: ` in a string breaks YAML parsing). The
dataset is committed — extend it by adding .md files directly; keep concepts typed
(`type:` required) and, for new large docs, keep body > 6000 chars if they should cross
the test-time nudge threshold.

## Config schema

`okf.schema.json` (root) is a JSON Schema (draft-07) for the **plugin config file** `okf.jsonc` — it
validates config keys (`enabled`, `scan`, `bundles`, `remotes`, `disclosure`, `unload`, `nudge`,
`write`, `protectedConcepts`, `debug`). It is **NOT** a schema for OKF concept documents.

## Build artifacts (gitignored — never commit)

`dist/`, `release/`, `*.tgz`, `*.tar.gz` are build products regenerated from source.
**Distribution is npm-only** (the intranet pulls the package from its npm registry): the offline
tarball was discontinued (2026-09) — do not rebuild one; `release/` is a leftover local artifact.

## Commit & push

- Default branch: `main`. Commits to `main` are pushed to `origin` on request.
- Do not commit failing tests or type errors. Do not commit build artifacts.
- Keep `README.md` and `README.zh-CN.md` in sync (they mirror each other section-for-section).
