/**
 * Data-only long-horizon goal tracking for Agent Teams.
 *
 * Goals deliberately have no executable check field. Verification must happen
 * through Pi's normal authorized tool surface; callers then record the result
 * with goals_update.
 */

export const MAX_GOALS = 100;
export const MAX_GOAL_DESCRIPTION_BYTES = 4 * 1024;
export const MAX_GOAL_PROGRESS_BYTES = 8 * 1024;
export const MAX_GOALS_AGGREGATE_BYTES = 48 * 1024;
export const MAX_GOALS_CONTEXT_BYTES = 48 * 1024;
export const MAX_GOALS_TOOL_OUTPUT_BYTES = 48 * 1024;
export const TEAM_GOALS_ENTRY_TYPE = "team-goals";
export const TEAM_GOALS_CONTEXT_MESSAGE_TYPE = "team-goals-context";

const GOAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_GOAL_KEYS = new Set([
  "id",
  "description",
  "progress",
  "completed",
  "createdAt",
  "completedAt",
  // Explicitly recognized only so legacy persisted goals can be recovered
  // after this authority repair. These values are always discarded.
  "checkCommand",
  "check_command",
]);

export interface Goal {
  id: string;
  description: string;
  /** Qualitative progress notes */
  progress?: string;
  /** Whether the goal is completed */
  completed: boolean;
  /** When the goal was created */
  createdAt: number;
  /** When the goal was completed */
  completedAt?: number;
}

/** Project a replayed goals_add call onto the current data-only schema. */
export function prepareGoalAddArguments(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(["description", "checkCommand", "check_command"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return value;

  const description = descriptors.description;
  if (!description || !Object.hasOwn(description, "value")) return value;
  for (const key of ["checkCommand", "check_command"] as const) {
    const descriptor = descriptors[key];
    if (descriptor && (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string")) {
      return value;
    }
  }
  return { description: description.value };
}

export interface GoalsCheckReport {
  goals: readonly Goal[];
  text: string;
}

/** Copy one goal for a persistence or result boundary and make it immutable. */
export function snapshotGoal(goal: Goal): Goal {
  const copy: Goal = {
    id: goal.id,
    description: goal.description,
    completed: goal.completed,
    createdAt: goal.createdAt,
  };
  if (goal.progress !== undefined) copy.progress = goal.progress;
  if (goal.completedAt !== undefined) copy.completedAt = goal.completedAt;
  return Object.freeze(copy);
}

/** Copy a goal collection for a persistence or result boundary. */
export function snapshotGoals(goals: readonly Goal[]): readonly Goal[] {
  return Object.freeze(goals.map(snapshotGoal));
}

/** Serialized size of the durable aggregate goal payload. */
export function goalStorageBytes(goals: readonly Goal[]): number {
  return Buffer.byteLength(JSON.stringify({ goals }), "utf8");
}

/** Reject mutations that would make the durable aggregate goal payload unbounded. */
export function requireGoalAggregateSize(goals: readonly Goal[]): void {
  const bytes = goalStorageBytes(goals);
  if (goals.length > MAX_GOALS || bytes > MAX_GOALS_AGGREGATE_BYTES) {
    throw new Error(
      `Aggregate goal storage must be at most ${MAX_GOALS_AGGREGATE_BYTES} UTF-8 bytes and ${MAX_GOALS} goals (received ${bytes} bytes and ${goals.length} goals).`,
    );
  }
}

function truncateUtf8WithNotice(text: string, maxBytes: number, notice: string): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  if (noticeBytes > maxBytes) throw new Error("Truncation notice exceeds its output limit.");

  const contentBytes = maxBytes - noticeBytes;
  let used = 0;
  let prefix = "";
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > contentBytes) break;
    prefix += character;
    used += bytes;
  }
  return prefix + notice;
}

/** Cap model-visible goal tool text and always disclose truncation. */
export function capGoalToolOutput(text: string): string {
  return truncateUtf8WithNotice(
    text,
    MAX_GOALS_TOOL_OUTPUT_BYTES,
    "\n\n[Goal tool output truncated at 48 KiB.]",
  );
}

/** Cap an aggregate goal context section and always disclose truncation. */
export function capGoalsContext(text: string): string {
  return truncateUtf8WithNotice(
    text,
    MAX_GOALS_CONTEXT_BYTES,
    "\n\n[Active goal context truncated at 48 KiB.]",
  );
}

/**
 * Compatibility behavior for the historical goals_check tool. This function
 * only selects and formats in-memory data; it has no callback or execution
 * capability and never mutates goals.
 */
export function buildGoalsCheckReport(goals: readonly Goal[], id?: string): GoalsCheckReport {
  const selected = id === undefined
    ? snapshotGoals(goals)
    : snapshotGoals([goals[requireGoalIndexText(id, goals.length)]]);

  if (selected.length === 0) return { goals: selected, text: "No goals defined." };
  const lines = selected.map((goal) => goal.completed
    ? `✓ ${goal.description} (recorded complete)`
    : `○ ${goal.description} (requires verification through normal authorized tools)`);
  return {
    goals: selected,
    text: capGoalToolOutput(
      `Reported ${selected.length} qualitative goal(s); no commands were executed.\n\n${lines.join("\n")}`,
    ),
  };
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value"))) return null;
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && (allowEmpty || value.trim().length > 0)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export function requireGoalDescription(value: string): string {
  const description = value.trim();
  if (!description || Buffer.byteLength(description, "utf8") > MAX_GOAL_DESCRIPTION_BYTES) {
    throw new Error(
      `Goal description must be non-empty and at most ${MAX_GOAL_DESCRIPTION_BYTES} UTF-8 bytes.`,
    );
  }
  return description;
}

export function requireGoalProgress(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_GOAL_PROGRESS_BYTES) {
    throw new Error(`Goal progress must be at most ${MAX_GOAL_PROGRESS_BYTES} UTF-8 bytes.`);
  }
}

export function requireGoalIndex(index: number, total: number): number {
  if (!Number.isSafeInteger(index) || index < 1 || index > total) {
    throw new Error(
      `Invalid goal index ${String(index)}. Use goals_list to see available goals (${total} total).`,
    );
  }
  return index - 1;
}

export function requireGoalIndexText(index: string, total: number): number {
  if (!/^[1-9][0-9]*$/.test(index)) {
    throw new Error(
      `Invalid goal index ${index}. Use goals_list to see available goals (${total} total).`,
    );
  }
  return requireGoalIndex(Number(index), total);
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate one persisted goal and project only the bounded data fields.
 * Legacy/crafted executable fields are neither returned nor interpreted.
 */
export function sanitizePersistedGoal(value: unknown): Goal | null {
  const record = ownRecord(value);
  if (!record || Reflect.ownKeys(record).some(
    (key) => typeof key !== "string" || !SAFE_GOAL_KEYS.has(key),
  )) return null;
  if (record.checkCommand !== undefined && typeof record.checkCommand !== "string") return null;
  if (record.check_command !== undefined && typeof record.check_command !== "string") return null;
  if (typeof record.id !== "string" || !GOAL_ID_RE.test(record.id)) return null;
  if (!boundedText(record.description, MAX_GOAL_DESCRIPTION_BYTES)) return null;
  if (typeof record.completed !== "boolean" || !safeTimestamp(record.createdAt)) return null;
  if (record.progress !== undefined
    && !boundedText(record.progress, MAX_GOAL_PROGRESS_BYTES, true)) return null;
  if (record.completedAt !== undefined && !safeTimestamp(record.completedAt)) return null;
  if (!record.completed && record.completedAt !== undefined) return null;

  const goal: Goal = {
    id: record.id,
    description: record.description,
    completed: record.completed,
    createdAt: record.createdAt,
  };
  if (record.progress !== undefined) goal.progress = record.progress;
  if (record.completedAt !== undefined) goal.completedAt = record.completedAt;
  return Object.freeze(goal);
}

/**
 * Recover a bounded, duplicate-free goal list from untrusted session data.
 * The container is atomic: one malformed or duplicate item rejects the entire
 * snapshot. Recognized legacy check strings are the sole exception; their
 * values are type-checked and then discarded without interpretation.
 */
export function sanitizePersistedGoals(value: unknown): Goal[] {
  if (!Array.isArray(value) || value.length > MAX_GOALS) return [];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return [];

  const restored: Goal[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return [];
    const goal = sanitizePersistedGoal(descriptor.value);
    if (!goal || ids.has(goal.id)) return [];
    ids.add(goal.id);
    restored.push({ ...goal });
  }
  if (goalStorageBytes(restored) > MAX_GOALS_AGGREGATE_BYTES) return [];
  return restored;
}

/** Restore only the newest snapshot reachable from the current session leaf. */
export function restoreGoalsFromCurrentBranch(
  sessionManager: { getBranch(): readonly unknown[] },
): Goal[] {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = ownRecord(branch[index]);
    if (entry?.type !== "custom" || entry.customType !== TEAM_GOALS_ENTRY_TYPE) continue;
    const data = ownRecord(entry.data);
    // A newest empty or malformed snapshot deliberately clears older state.
    return sanitizePersistedGoals(data?.goals);
  }
  return [];
}

/** Remove legacy durable goal-context messages from provider context only. */
export function filterHistoricalGoalsContextMessages<T>(messages: readonly T[]): T[] {
  return messages.filter((message) => {
    const record = ownRecord(message);
    return !(record?.role === "custom"
      && record.customType === TEAM_GOALS_CONTEXT_MESSAGE_TYPE);
  });
}

/** Build turn-local goal context without creating a durable custom message. */
export function buildGoalsSystemPrompt(
  systemPrompt: string,
  currentGoals: readonly Goal[],
  companionAllowed: boolean,
): string | undefined {
  if (!companionAllowed) return undefined;
  const activeGoals = currentGoals.filter((goal) => !goal.completed);
  if (activeGoals.length === 0) return undefined;
  const context = capGoalsContext(
    `## Active Goals\n\n${formatGoalsForPrompt(activeGoals)}\n\nUse goals_update to record status after verification through the normal authorized tool surface.`,
  );
  return `${systemPrompt}\n\n${context}`;
}

/** Find a collision-free sequence for generated goal-N IDs. */
export function nextGoalSequence(goals: readonly Goal[]): number {
  const ids = new Set(goals.map((goal) => goal.id));
  for (let sequence = 1; sequence <= MAX_GOALS + 1; sequence++) {
    if (!ids.has(`goal-${sequence}`)) return sequence;
  }
  return MAX_GOALS + 1;
}

/** Allocate an ID from the current set rather than from a stale cursor. */
export function allocateGoalId(goals: readonly Goal[]): string {
  return `goal-${nextGoalSequence(goals)}`;
}

/** Format goals for inclusion in an orchestrator or child prompt. */
export function formatGoalsForPrompt(goals: readonly Goal[]): string {
  if (goals.length === 0) return "(no active goals)";

  const formatted = goals
    .map((goal, index) => {
      const status = goal.completed ? "✓ COMPLETED" : "○ IN PROGRESS";
      const progress = goal.progress ? ` | Progress: ${goal.progress}` : "";
      return `${index + 1}. ${goal.description} [${status}]${progress}`;
    })
    .join("\n");
  return capGoalsContext(formatted);
}
