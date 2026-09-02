/**
 * Plugin version, surfaced in tool outputs so users can verify which build is
 * actually loaded (opencode's `@latest` package cache can go stale, and a
 * hand-edited dist is invisible otherwise). Kept in sync with package.json by
 * a test gate (tests/version.test.ts) rather than build-time magic.
 */
export const PLUGIN_VERSION = "0.1.8";
