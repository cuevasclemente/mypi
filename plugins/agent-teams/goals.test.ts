import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_GOAL_DESCRIPTION_BYTES,
  MAX_GOAL_PROGRESS_BYTES,
  MAX_GOALS_AGGREGATE_BYTES,
  MAX_GOALS_CONTEXT_BYTES,
  MAX_GOALS_TOOL_OUTPUT_BYTES,
  TEAM_GOALS_CONTEXT_MESSAGE_TYPE,
  TEAM_GOALS_ENTRY_TYPE,
  allocateGoalId,
  buildGoalsCheckReport,
  buildGoalsSystemPrompt,
  capGoalToolOutput,
  filterHistoricalGoalsContextMessages,
  formatGoalsForPrompt,
  goalStorageBytes,
  requireGoalAggregateSize,
  requireGoalDescription,
  requireGoalIndex,
  requireGoalProgress,
  restoreGoalsFromCurrentBranch,
  sanitizePersistedGoal,
  sanitizePersistedGoals,
  snapshotGoal,
  snapshotGoals,
  type Goal,
} from "./goals.js";

const goal = (id: string, description: string): Goal => ({
  id,
  description,
  completed: false,
  createdAt: 1,
});

const snapshot = (goals: Goal[]) => ({
  type: "custom",
  customType: TEAM_GOALS_ENTRY_TYPE,
  data: { goals },
});

test("latest empty snapshot removes stale goals", () => {
  const restored = restoreGoalsFromCurrentBranch({
    getBranch: () => [
      snapshot([goal("goal-1", "stale")]),
      snapshot([]),
    ],
  });

  assert.deepEqual(restored, []);
  assert.deepEqual(
    restoreGoalsFromCurrentBranch({
      getBranch: () => [
        snapshot([goal("goal-1", "stale")]),
        { type: "custom", customType: TEAM_GOALS_ENTRY_TYPE, data: { goals: "malformed" } },
      ],
    }),
    [],
  );
});

test("goal restoration is isolated to the current branch", () => {
  const current = goal("goal-current", "current branch");
  const offBranch = goal("goal-off-branch", "must not restore");
  const sessionManager = {
    getBranch: () => [snapshot([current])],
    getEntries: () => [snapshot([current]), snapshot([offBranch])],
  };

  assert.deepEqual(restoreGoalsFromCurrentBranch(sessionManager), [current]);
});

test("branch navigation restores the newly selected branch snapshot", () => {
  const left = [goal("goal-1", "left branch")];
  const right = [goal("goal-7", "right branch")];
  let currentBranch = [snapshot(left)];
  const sessionManager = { getBranch: () => currentBranch };

  assert.deepEqual(restoreGoalsFromCurrentBranch(sessionManager), left);
  currentBranch = [snapshot(right)];
  assert.deepEqual(restoreGoalsFromCurrentBranch(sessionManager), right);
});

test("persistence snapshots and check results are immutable defensive copies", () => {
  const source = goal("goal-1", "original");
  const one = snapshotGoal(source);
  const many = snapshotGoals([source]);
  const report = buildGoalsCheckReport([source]);

  assert.notEqual(one, source);
  assert.notEqual(many[0], source);
  assert.notEqual(report.goals[0], source);
  assert.ok(Object.isFrozen(one));
  assert.ok(Object.isFrozen(many));
  assert.ok(Object.isFrozen(many[0]));
  assert.ok(Object.isFrozen(report.goals));
  try { (many[0] as Goal).description = "mutated"; } catch {}
  try { (report.goals[0] as Goal).completed = true; } catch {}
  assert.equal(many[0]!.description, "original");
  assert.equal(report.goals[0]!.completed, false);
  assert.equal(source.description, "original");
  assert.equal(source.completed, false);
});

test("gap IDs are reallocated against the current restored set without collisions", () => {
  const restored = restoreGoalsFromCurrentBranch({
    getBranch: () => [snapshot([
      goal("goal-1", "one"),
      goal("goal-3", "three"),
    ])],
  });

  const gapId = allocateGoalId(restored);
  assert.equal(gapId, "goal-2");
  restored.push(goal(gapId, "two"));
  assert.equal(allocateGoalId(restored), "goal-4");
  assert.equal(new Set(restored.map((item) => item.id)).size, restored.length);
});

test("denied companion policy injects no goal context", () => {
  const original = "base system prompt";
  assert.equal(buildGoalsSystemPrompt(original, [goal("goal-1", "secret context")], false), undefined);

  const allowed = buildGoalsSystemPrompt(original, [goal("goal-1", "visible context")], true);
  assert.match(allowed ?? "", /^base system prompt/);
  assert.match(allowed ?? "", /visible context/);
});

test("historical durable goal-context messages are filtered from provider context", () => {
  const keep = { role: "user", content: "keep" };
  const stale = {
    role: "custom",
    customType: TEAM_GOALS_CONTEXT_MESSAGE_TYPE,
    content: "stale snapshot",
  };
  const otherCustom = { role: "custom", customType: "other", content: "keep too" };

  assert.deepEqual(
    filterHistoricalGoalsContextMessages([keep, stale, otherCustom]),
    [keep, otherCustom],
  );
});

test("invalid indexes and oversized goal input throw protocol-visible errors", () => {
  assert.throws(() => requireGoalIndex(0, 1), /Invalid goal index 0/);
  assert.throws(() => requireGoalIndex(2, 1), /Invalid goal index 2/);
  assert.throws(
    () => buildGoalsCheckReport([goal("goal-1", "one")], "2"),
    /Invalid goal index 2/,
  );
  assert.throws(
    () => requireGoalDescription("x".repeat(MAX_GOAL_DESCRIPTION_BYTES + 1)),
    /Goal description must be non-empty and at most/,
  );
  assert.throws(
    () => requireGoalProgress("x".repeat(MAX_GOAL_PROGRESS_BYTES + 1)),
    /Goal progress must be at most/,
  );
});

test("aggregate storage accepts exactly 48 KiB and rejects larger restoration", () => {
  const goals = Array.from({ length: 7 }, (_, index): Goal => ({
    ...goal(`goal-${index + 1}`, `goal ${index + 1}`),
    progress: "",
  }));
  let remaining = MAX_GOALS_AGGREGATE_BYTES - goalStorageBytes(goals);
  for (const item of goals) {
    const bytes = Math.min(remaining, MAX_GOAL_PROGRESS_BYTES);
    item.progress = "x".repeat(bytes);
    remaining -= bytes;
  }

  assert.equal(remaining, 0);
  assert.equal(goalStorageBytes(goals), MAX_GOALS_AGGREGATE_BYTES);
  assert.doesNotThrow(() => requireGoalAggregateSize(goals));
  assert.deepEqual(sanitizePersistedGoals(goals), goals);

  const oversized = [...goals, goal("goal-8", "over limit")];
  assert.throws(() => requireGoalAggregateSize(oversized), /Aggregate goal storage/);
  assert.deepEqual(sanitizePersistedGoals(oversized), []);
  assert.deepEqual(
    restoreGoalsFromCurrentBranch({ getBranch: () => [snapshot(oversized)] }),
    [],
  );
});

test("aggregate context and tool output are capped at 48 KiB with explicit truncation", () => {
  const largeGoals = Array.from({ length: 100 }, (_, index): Goal => ({
    ...goal(`goal-${index + 1}`, "d".repeat(MAX_GOAL_DESCRIPTION_BYTES)),
    progress: "p".repeat(MAX_GOAL_PROGRESS_BYTES),
  }));

  const context = formatGoalsForPrompt(largeGoals);
  assert.ok(Buffer.byteLength(context, "utf8") <= MAX_GOALS_CONTEXT_BYTES);
  assert.match(context, /context truncated at 48 KiB/);

  const base = "base";
  const prompt = buildGoalsSystemPrompt(base, largeGoals, true) ?? "";
  const injected = prompt.slice(base.length + 2);
  assert.ok(Buffer.byteLength(injected, "utf8") <= MAX_GOALS_CONTEXT_BYTES);
  assert.match(injected, /context truncated at 48 KiB/);

  const exact = "x".repeat(MAX_GOALS_TOOL_OUTPUT_BYTES);
  assert.equal(capGoalToolOutput(exact), exact);
  const capped = capGoalToolOutput(`${exact}overflow`);
  assert.ok(Buffer.byteLength(capped, "utf8") <= MAX_GOALS_TOOL_OUTPUT_BYTES);
  assert.match(capped, /tool output truncated at 48 KiB/);
});

test("legacy executable goal fields are discarded without evaluation", () => {
  let getterRan = false;
  const crafted = {
    id: "goal-1",
    description: "safe data",
    completed: false,
    createdAt: 1,
    get checkCommand() {
      getterRan = true;
      return "exit 99";
    },
  };

  assert.equal(sanitizePersistedGoal(crafted), null);
  assert.equal(getterRan, false);
});
