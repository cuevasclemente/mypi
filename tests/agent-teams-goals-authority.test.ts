import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_GOALS,
  buildGoalsCheckReport,
  prepareGoalAddArguments,
  sanitizePersistedGoal,
  sanitizePersistedGoals,
} from "../plugins/agent-teams/goals.ts";
import {
  AGENT_TEAMS_TOOL_NAMES,
  withoutAgentTeamsTools,
} from "../plugins/agent-teams/tool-names.ts";

const validGoal = (overrides: Record<string, unknown> = {}) => ({
  id: "goal-1",
  description: "Review the repair",
  completed: false,
  createdAt: 1,
  ...overrides,
});

test("legacy executable check strings are discarded and never executed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-teams-goals-noexec-"));
  const marker = join(dir, "executed");
  try {
    const restored = sanitizePersistedGoals([validGoal({
      checkCommand: `touch ${JSON.stringify(marker)}`,
      check_command: `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)}`,
    })]);

    assert.equal(restored.length, 1);
    assert.deepEqual(Object.keys(restored[0]).sort(), ["completed", "createdAt", "description", "id"]);
    const report = buildGoalsCheckReport(restored);
    assert.match(report.text, /no commands were executed/i);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goals_add compatibility discards plain legacy checks and rejects accessors without reading them", () => {
  assert.deepEqual(prepareGoalAddArguments({
    description: "Keep safe data",
    check_command: "touch /tmp/should-not-run",
  }), { description: "Keep safe data" });

  let executableGetterRead = false;
  const crafted = Object.defineProperties({}, {
    description: { value: "Keep safe data", enumerable: true },
    check_command: {
      enumerable: true,
      get() {
        executableGetterRead = true;
        return "touch /tmp/should-not-run";
      },
    },
  });
  assert.equal(prepareGoalAddArguments(crafted), crafted);
  assert.equal(executableGetterRead, false);
});

test("persisted goal restore is atomic and strictly bounded", () => {
  assert.deepEqual(sanitizePersistedGoals([
    validGoal(),
    validGoal({ id: "goal-2", unexpected: true }),
  ]), []);
  assert.deepEqual(sanitizePersistedGoals([
    validGoal(),
    validGoal(),
  ]), []);
  assert.deepEqual(sanitizePersistedGoals([
    validGoal({ checkCommand: { command: "echo unsafe" } }),
  ]), []);
  assert.deepEqual(sanitizePersistedGoals(new Array(MAX_GOALS + 1).fill(validGoal())), []);
  assert.deepEqual(sanitizePersistedGoals([
    validGoal({ completedAt: 2 }),
  ]), []);
  const arrayWithExtraProperty = [validGoal()];
  Object.defineProperty(arrayWithExtraProperty, "unexpected", { value: true });
  assert.deepEqual(sanitizePersistedGoals(arrayWithExtraProperty), []);
});

test("persisted goal validation rejects accessors without invoking them", () => {
  let invoked = false;
  const crafted = validGoal();
  Object.defineProperty(crafted, "description", {
    enumerable: true,
    get() {
      invoked = true;
      return "crafted";
    },
  });
  assert.equal(sanitizePersistedGoal(crafted), null);
  assert.equal(invoked, false);
});

test("goals_check compatibility only reports exact selected status", () => {
  const goals = sanitizePersistedGoals([
    validGoal(),
    validGoal({ id: "goal-2", description: "Already done", completed: true, completedAt: 3 }),
  ]);
  const before = structuredClone(goals);

  assert.match(buildGoalsCheckReport(goals, "1").text, /requires verification/);
  assert.match(buildGoalsCheckReport(goals, "2").text, /recorded complete/);
  assert.throws(() => buildGoalsCheckReport(goals, "1x"), /Invalid goal index/);
  assert.throws(() => buildGoalsCheckReport(goals, "0"), /Invalid goal index/);
  assert.deepEqual(goals, before);
});

test("denied-policy set covers the complete Agent Teams model-callable surface", () => {
  const indexSource = readFileSync(new URL("../plugins/agent-teams/index.ts", import.meta.url), "utf8");
  const registeredTools = [...indexSource.matchAll(/pi\.registerTool\(\{\s*name:\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
  const expected = [
    "goals_add",
    "goals_check",
    "goals_list",
    "goals_remove",
    "goals_update",
    "subagent_dispatch",
    "subagent_list",
    "subagent_poll",
    "subagent_send",
    "subagent_spawn",
    "subagent_stop",
  ];

  assert.deepEqual(registeredTools, expected);
  assert.deepEqual([...AGENT_TEAMS_TOOL_NAMES].sort(), expected);
  assert.deepEqual(withoutAgentTeamsTools(["read", ...AGENT_TEAMS_TOOL_NAMES, "edit"]), ["read", "edit"]);
});

test("goals implementation has no shell or process execution dependency", () => {
  const goalsSource = readFileSync(new URL("../plugins/agent-teams/goals.ts", import.meta.url), "utf8");
  const indexSource = readFileSync(new URL("../plugins/agent-teams/index.ts", import.meta.url), "utf8");
  const goalsBlock = indexSource.slice(indexSource.indexOf("// ── Goals Tools"));

  assert.doesNotMatch(goalsSource, /node:child_process|\bexec(?:File|Sync)?\s*\(|\bspawn(?:Sync)?\s*\(/);
  assert.doesNotMatch(goalsBlock, /\bpi\.exec\s*\(|node:child_process|\bspawn(?:Sync)?\s*\(/);
});
