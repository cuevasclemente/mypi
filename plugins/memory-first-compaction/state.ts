export const MEMORY_STATE_ENTRY = "memory-first-compaction.state.v1";
export const MEMORY_REVIEW_MESSAGE = "memory-first-compaction.review.v1";
export const REVIEW_THRESHOLD_TOKENS = 96_000;
export const COMPACTION_THRESHOLD_TOKENS = 128_000;

export const REVIEW_OUTCOMES = ["wrote", "read_only", "not_relevant", "blocked"] as const;
export type MemoryReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
export type ReminderKind = "review" | "retry";

export interface MemoryContextFlags {
  guidance: boolean;
  review: boolean;
  compaction: boolean;
  ledger: boolean;
}

export type MemoryStateEvent =
  | { version: 1; kind: "review_reminded"; generation: number; reminder: ReminderKind }
  | { version: 1; kind: "review_reminder_started"; generation: number; reminder: ReminderKind }
  | { version: 1; kind: "review_completed"; generation: number; outcome: MemoryReviewOutcome }
  | { version: 1; kind: "compaction_requested"; generation: number }
  | { version: 1; kind: "compaction_failed"; generation: number }
  | { version: 1; kind: "compaction_completed"; generation: number; next_generation: number };

export interface MemoryGenerationState {
  generation: number;
  reviewReminderSent: boolean;
  retryReminderSent: boolean;
  pendingReminder: ReminderKind | null;
  reviewOutcome: MemoryReviewOutcome | null;
  compactionRequested: boolean;
}

export interface CustomStateEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

export function flagsFromEnvironment(env: NodeJS.ProcessEnv = process.env): MemoryContextFlags {
  return {
    guidance: env.PI_MEMORY_CONTEXT_GUIDANCE === "on",
    review: env.PI_MEMORY_CONTEXT_REVIEW === "on",
    compaction: env.PI_MEMORY_CONTEXT_COMPACTION === "on",
    ledger: env.PI_MEMORY_CONTEXT_LEDGER === "on",
  };
}

export function initialMemoryState(): MemoryGenerationState {
  return {
    generation: 1,
    reviewReminderSent: false,
    retryReminderSent: false,
    pendingReminder: null,
    reviewOutcome: null,
    compactionRequested: false,
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

export function isMemoryReviewOutcome(value: unknown): value is MemoryReviewOutcome {
  return typeof value === "string" && (REVIEW_OUTCOMES as readonly string[]).includes(value);
}

export function isMemoryStateEvent(value: unknown): value is MemoryStateEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.version !== 1 || typeof event.kind !== "string" || !validGeneration(event.generation)) return false;
  switch (event.kind) {
    case "review_reminded":
    case "review_reminder_started":
      return exactKeys(event, ["version", "kind", "generation", "reminder"])
        && (event.reminder === "review" || event.reminder === "retry");
    case "review_completed":
      return exactKeys(event, ["version", "kind", "generation", "outcome"])
        && isMemoryReviewOutcome(event.outcome);
    case "compaction_requested":
    case "compaction_failed":
      return exactKeys(event, ["version", "kind", "generation"]);
    case "compaction_completed":
      return exactKeys(event, ["version", "kind", "generation", "next_generation"])
        && validGeneration(event.next_generation)
        && event.next_generation === (event.generation as number) + 1;
    default:
      return false;
  }
}

export function applyMemoryStateEvent(
  current: MemoryGenerationState,
  event: MemoryStateEvent,
): MemoryGenerationState {
  if (event.kind === "compaction_completed") {
    if (event.generation < current.generation || event.next_generation <= current.generation) return current;
    return { ...initialMemoryState(), generation: event.next_generation };
  }
  if (event.generation !== current.generation) return current;
  switch (event.kind) {
    case "review_reminded":
      return event.reminder === "review"
        ? { ...current, reviewReminderSent: true, pendingReminder: "review" }
        : { ...current, reviewReminderSent: true, retryReminderSent: true, pendingReminder: "retry" };
    case "review_reminder_started":
      return current.pendingReminder === event.reminder ? { ...current, pendingReminder: null } : current;
    case "review_completed":
      return { ...current, reviewOutcome: event.outcome, pendingReminder: null };
    case "compaction_requested":
      return { ...current, compactionRequested: true };
    case "compaction_failed":
      return { ...current, compactionRequested: false };
  }
}

export function deliveredReminderDetails(value: unknown): { generation: number; reminder: ReminderKind } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const details = value as Record<string, unknown>;
  const allowed = ["generation", "reminder", "version"];
  if (Object.keys(details).some((key) => !allowed.includes(key))) return null;
  if (details.version !== 1 || !validGeneration(details.generation)) return null;
  if (details.reminder !== "review" && details.reminder !== "retry") return null;
  return { generation: details.generation, reminder: details.reminder };
}

export function reconstructMemoryState(entries: readonly CustomStateEntryLike[]): MemoryGenerationState {
  let state = initialMemoryState();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === MEMORY_STATE_ENTRY && isMemoryStateEvent(entry.data)) {
      state = applyMemoryStateEvent(state, entry.data);
      continue;
    }
    if (entry.type === "custom_message" && entry.customType === MEMORY_REVIEW_MESSAGE) {
      const delivered = deliveredReminderDetails(entry.details);
      if (delivered) {
        state = applyMemoryStateEvent(state, {
          version: 1,
          kind: "review_reminder_started",
          generation: delivered.generation,
          reminder: delivered.reminder,
        });
      }
    }
  }
  return state;
}

export type ReminderDecision = "none" | ReminderKind;

/** Reminder used after an ordinary agent turn or during high-context reload recovery. */
export function reminderDecision(
  state: Readonly<MemoryGenerationState>,
  tokens: number | null,
  flags: Readonly<MemoryContextFlags>,
): ReminderDecision {
  if (tokens === null || !Number.isFinite(tokens) || state.reviewOutcome !== null || state.pendingReminder !== null) return "none";
  const firstReviewDue = !state.reviewReminderSent && (
    (flags.review && tokens >= REVIEW_THRESHOLD_TOKENS)
    || (flags.compaction && tokens >= COMPACTION_THRESHOLD_TOKENS)
  );
  if (firstReviewDue) return "review";
  if (
    flags.compaction
    && tokens >= COMPACTION_THRESHOLD_TOKENS
    && state.reviewReminderSent
    && !state.retryReminderSent
  ) return "retry";
  return "none";
}

/** Reminder used when native threshold compaction is imminent. */
export function thresholdReminderDecision(
  state: Readonly<MemoryGenerationState>,
  tokens: number | null,
  flags: Readonly<MemoryContextFlags>,
): ReminderDecision {
  if (tokens === null || tokens < REVIEW_THRESHOLD_TOKENS || state.reviewOutcome !== null || state.pendingReminder !== null) {
    return "none";
  }
  if (!flags.review && !(flags.compaction && tokens >= COMPACTION_THRESHOLD_TOKENS)) return "none";
  if (!state.reviewReminderSent) return "review";
  if (!state.retryReminderSent) return "retry";
  return "none";
}

export function shouldRequestCompaction(
  state: Readonly<MemoryGenerationState>,
  tokens: number | null,
  flags: Readonly<MemoryContextFlags>,
): boolean {
  return Boolean(
    flags.compaction
    && tokens !== null
    && Number.isFinite(tokens)
    && tokens >= COMPACTION_THRESHOLD_TOKENS
    && state.pendingReminder === null
    && !state.compactionRequested
    && (state.reviewOutcome !== null || state.retryReminderSent),
  );
}
