import test from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_REVIEW_MESSAGE,
  MEMORY_STATE_ENTRY,
  applyMemoryStateEvent,
  flagsFromEnvironment,
  initialMemoryState,
  reconstructMemoryState,
  reminderDecision,
  shouldRequestCompaction,
  thresholdReminderDecision,
  type CustomStateEntryLike,
} from "./state.js";

test("all four feature flags are independently off by default and exact-on only", () => {
  assert.deepEqual(flagsFromEnvironment({}), { guidance: false, review: false, compaction: false, ledger: false });
  assert.deepEqual(flagsFromEnvironment({
    PI_MEMORY_CONTEXT_GUIDANCE: "on",
    PI_MEMORY_CONTEXT_REVIEW: "true",
    PI_MEMORY_CONTEXT_COMPACTION: "1",
    PI_MEMORY_CONTEXT_LEDGER: "ON",
  }), { guidance: true, review: false, compaction: false, ledger: false });
});

test("ordinary reminder decision sends first review before retry on a direct below-96K to above-128K jump", () => {
  const flags = { guidance: false, review: true, compaction: true, ledger: false };
  let state = initialMemoryState();
  assert.equal(reminderDecision(state, 95_999, flags), "none");
  assert.equal(reminderDecision(state, 130_000, flags), "review");
  state = applyMemoryStateEvent(state, { version: 1, kind: "review_reminded", generation: 1, reminder: "review" });
  assert.equal(reminderDecision(state, 130_000, flags), "none", "pending review turn prevents same-turn retry");
  state = applyMemoryStateEvent(state, { version: 1, kind: "review_reminder_started", generation: 1, reminder: "review" });
  assert.equal(reminderDecision(state, 130_000, flags), "retry");
  state = applyMemoryStateEvent(state, { version: 1, kind: "review_reminded", generation: 1, reminder: "retry" });
  assert.equal(shouldRequestCompaction(state, 130_000, flags), false, "queued retry must run first");
  state = applyMemoryStateEvent(state, { version: 1, kind: "review_reminder_started", generation: 1, reminder: "retry" });
  assert.equal(shouldRequestCompaction(state, 130_000, flags), true);
});

test("native threshold gating retries at imminent compaction but passes smaller model thresholds", () => {
  const flags = { guidance: false, review: true, compaction: true, ledger: false };
  let state = initialMemoryState();
  assert.equal(thresholdReminderDecision(state, 80_000, flags), "none");
  assert.equal(thresholdReminderDecision(state, 100_000, flags), "review");
  state = applyMemoryStateEvent(state, { version: 1, kind: "review_reminded", generation: 1, reminder: "review" });
  state = applyMemoryStateEvent(state, { version: 1, kind: "review_reminder_started", generation: 1, reminder: "review" });
  assert.equal(thresholdReminderDecision(state, 100_000, flags), "retry");
  state = applyMemoryStateEvent(state, { version: 1, kind: "review_reminded", generation: 1, reminder: "retry" });
  state = applyMemoryStateEvent(state, { version: 1, kind: "review_reminder_started", generation: 1, reminder: "retry" });
  assert.equal(thresholdReminderDecision(state, 100_000, flags), "none");
});

test("review outcome permits 128K compaction without consuming retry", () => {
  const flags = { guidance: false, review: true, compaction: true, ledger: false };
  const state = applyMemoryStateEvent(initialMemoryState(), {
    version: 1, kind: "review_completed", generation: 1, outcome: "read_only",
  });
  assert.equal(state.retryReminderSent, false);
  assert.equal(shouldRequestCompaction(state, 128_000, flags), true);
});

test("typed entries reconstruct pending reminders, reject extra fields, and reset on compaction", () => {
  const entries: CustomStateEntryLike[] = [
    { type: "custom", customType: MEMORY_STATE_ENTRY, data: { version: 1, kind: "review_reminded", generation: 1, reminder: "review" } },
    { type: "custom", customType: MEMORY_STATE_ENTRY, data: { version: 1, kind: "review_completed", generation: 1, outcome: "wrote", memory_text: "must reject" } },
  ];
  assert.equal(reconstructMemoryState(entries).pendingReminder, "review");
  entries.push({
    type: "custom_message",
    customType: MEMORY_REVIEW_MESSAGE,
    details: { version: 1, generation: 1, reminder: "review" },
  });
  assert.equal(reconstructMemoryState(entries).pendingReminder, null, "delivered branch message reconstructs started state");
  entries.push(
    { type: "custom", customType: MEMORY_STATE_ENTRY, data: { version: 1, kind: "review_reminder_started", generation: 1, reminder: "review" } },
    { type: "custom", customType: MEMORY_STATE_ENTRY, data: { version: 1, kind: "review_completed", generation: 1, outcome: "wrote" } },
    { type: "custom", customType: MEMORY_STATE_ENTRY, data: { version: 1, kind: "compaction_completed", generation: 1, next_generation: 2 } },
  );
  assert.deepEqual(reconstructMemoryState(entries), {
    generation: 2,
    reviewReminderSent: false,
    retryReminderSent: false,
    pendingReminder: null,
    reviewOutcome: null,
    compactionRequested: false,
  });
});
