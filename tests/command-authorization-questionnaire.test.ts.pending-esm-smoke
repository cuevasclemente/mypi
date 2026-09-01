import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The validation script bundles the extension against Pi's runtime surface,
// exercises its exported human-input projection, and rejects forged/malformed
// Wayang custom-message provenance before installing the extension.
test("command guard recognizes durable Wayang questionnaire authorization", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-extensions.cjs", "command-authorization-monitor"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /extension validation passed/);
});
