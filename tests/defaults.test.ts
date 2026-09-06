/**
 * Drift gate for the 256K-window default tuning (see README "Configuration").
 *
 * These values are a product decision, not an implementation detail: unload now holds
 * concepts longer (reloading costs a full re-read + a tool round-trip) and the nudge only
 * fires when retained knowledge is genuinely large. Changing them is intentional only
 * with an explicit rationale — update this test in the same commit.
 */
import { test, expect } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config.js";

test("256K-window defaults: unload after 4 turns, keep 2 recent, nudge at 25000 chars", () => {
  expect(DEFAULT_CONFIG.unload.afterTurns).toBe(4);
  expect(DEFAULT_CONFIG.unload.keepRecent).toBe(2);
  expect(DEFAULT_CONFIG.nudge.threshold).toBe(25000);
  // Unchanged basics the tuning must not accidentally regress.
  expect(DEFAULT_CONFIG.unload.enabled).toBe(true);
  expect(DEFAULT_CONFIG.nudge.frequency).toBe(3);
  expect(DEFAULT_CONFIG.write.enabled).toBe(true);
});
