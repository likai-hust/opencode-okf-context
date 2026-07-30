/**
 * Local development wiring: opencode auto-loads .opencode/plugin/*.ts in a project.
 * This thin file re-exports the real plugin from src/ so you can dogfood the plugin
 * in this very repo (which also contains the fixtures/sample-bundle).
 */
export { OkfPlugin as default, OkfPlugin } from "../../src/index.js";
