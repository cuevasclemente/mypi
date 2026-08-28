import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";

import {
  COMPACTION_THRESHOLD_TOKENS,
  MEMORY_REVIEW_MESSAGE,
  MEMORY_STATE_ENTRY,
  REVIEW_OUTCOMES,
  REVIEW_THRESHOLD_TOKENS,
  applyMemoryStateEvent,
  deliveredReminderDetails,
  flagsFromEnvironment,
  initialMemoryState,
  reconstructMemoryState,
  reminderDecision,
  shouldRequestCompaction,
  thresholdReminderDecision,
  type MemoryReviewOutcome,
  type MemoryStateEvent,
  type ReminderKind,
} from "./state.js";
import {
  ASSISTANT_OUTCOMES,
  MetadataLedger,
  SOURCE_CLASSES,
  type AssistantOutcome,
  type CompactionCause,
  type MemorySourceClass,
  type UsageComponents,
} from "./ledger.js";

const GUIDANCE = [
  "Memory context: Treat only an authorized Memoriki or a privacy-matched project wiki as persisted short- and long-term future-value memory.",
  "Read it when continuity matters; write information likely to help future work, including ongoing activities and projects, decisions, commitments, preferences, and reusable facts, within its authority and privacy scope.",
  "Scheduled runs must not wait for input: continue safe work and report blocked memory access or writes.",
  "Subagents should return future-value memory candidates to the parent unless explicitly authorized to write the matching memory.",
].join(" ");

function sourceClass(ctx: ExtensionContext, env: NodeJS.ProcessEnv): MemorySourceClass {
  const configured = env.PI_MEMORY_CONTEXT_SOURCE_CLASS;
  if (configured && (SOURCE_CLASSES as readonly string[]).includes(configured)) return configured as MemorySourceClass;
  if (env.PI_AGENT_ROLE === "subagent" || env.MYPI_SUBAGENT === "1") return "subagent";
  if (env.PI_SCHEDULED_TASK === "1" || env.WAYANG_SCHEDULED_TASK === "1") return "scheduled";
  if ((ctx as any).mode === "tui") return "interactive";
  if ((ctx as any).mode === "rpc") return "rpc";
  return "unknown";
}

function usageTokens(ctx: ExtensionContext): number | null {
  const tokens = ctx.getContextUsage()?.tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? Math.round(tokens) : null;
}

function usageComponents(value: unknown): UsageComponents | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const usage = candidate.usage && typeof candidate.usage === "object"
    ? candidate.usage as Record<string, unknown>
    : candidate;
  let observed = false;
  const read = (...keys: string[]): number => {
    for (const key of keys) {
      const item = usage[key];
      if (typeof item === "number" && Number.isFinite(item) && item >= 0) {
        observed = true;
        return Math.round(item);
      }
    }
    return 0;
  };
  const input = read("input", "inputTokens", "input_tokens");
  const output = read("output", "outputTokens", "output_tokens");
  const cacheRead = read("cacheRead", "cacheReadTokens", "cache_read_tokens");
  const cacheWrite = read("cacheWrite", "cacheWriteTokens", "cache_write_tokens");
  const totalKeys = ["totalTokens", "total", "total_tokens"];
  const hasTotal = totalKeys.some((key) => {
    const item = usage[key];
    return typeof item === "number" && Number.isFinite(item);
  });
  const total = read(...totalKeys);
  return observed ? {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: hasTotal ? total : input + output + cacheRead + cacheWrite,
  } : null;
}

function assistantOutcome(value: unknown): AssistantOutcome {
  if (value === "toolUse" || value === "tool_use") return "tool_use";
  if (typeof value === "string" && (ASSISTANT_OUTCOMES as readonly string[]).includes(value)) return value as AssistantOutcome;
  return "unknown";
}

function reviewReminder(tokens: number, reminder: ReminderKind): string {
  const lead = reminder === "retry"
    ? `Context is at ${tokens.toLocaleString()} tokens. This is the single review retry before ordinary compaction.`
    : `Context is at ${tokens.toLocaleString()} tokens. Complete the memory review before ordinary compaction.`;
  return [
    lead,
    "Review authorized persisted memory now: read what is needed and write privacy-matched information with short- or long-term future value, including ongoing activities or projects when useful.",
    "Then call memory_review_complete with exactly one outcome: wrote, read_only, not_relevant, or blocked.",
    "Never place memory text in that tool call.",
  ].join(" ");
}

function branchEntries(ctx: ExtensionContext) {
  return ctx.sessionManager.getBranch();
}

function compactionReason(value: unknown): "manual" | "threshold" | "overflow" | "unknown" {
  return value === "manual" || value === "threshold" || value === "overflow" ? value : "unknown";
}

export function createMemoryFirstCompactionExtension(options: {
  env?: NodeJS.ProcessEnv;
  ledger?: MetadataLedger | null;
} = {}) {
  const env = options.env ?? process.env;
  const flags = flagsFromEnvironment(env);

  return function memoryFirstCompaction(pi: ExtensionAPI): void {
    let state = initialMemoryState();
    let latestTokens: number | null = null;
    let recoveryArmed = true;
    let requestSequence = 0;
    let pendingCompactionReason: "manual" | "threshold" | "overflow" | "unknown" = "unknown";
    let ledger: MetadataLedger | null = options.ledger ?? null;
    let ledgerStatus = flags.ledger ? "initializing" : "off";

    if (flags.ledger && options.ledger === undefined) {
      const key = env.PI_MEMORY_CONTEXT_LEDGER_HMAC_KEY;
      const ledgerPath = env.PI_MEMORY_CONTEXT_LEDGER_PATH;
      if (!key || Buffer.byteLength(key, "utf8") < 32 || !ledgerPath || !path.isAbsolute(ledgerPath)) {
        ledgerStatus = "blocked: explicit absolute ledger path and >=32-byte HMAC key are required";
      } else {
        try {
          ledger = new MetadataLedger({ filePath: ledgerPath, hmacKey: key });
          ledgerStatus = "on";
        } catch {
          ledgerStatus = "blocked: ledger setup failed";
        }
      }
    } else if (flags.ledger && ledger) {
      ledgerStatus = "on";
    }

    const persist = (event: MemoryStateEvent): void => {
      pi.appendEntry(MEMORY_STATE_ENTRY, event);
      state = applyMemoryStateEvent(state, event);
    };

    const ledgerIdentity = (ctx: ExtensionContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const boundaryId = ctx.sessionManager.getLeafId() ?? "root";
      return sessionId ? { sessionId, boundaryId, sourceClass: sourceClass(ctx, env) } : null;
    };

    const recordLedger = (ctx: ExtensionContext, input: Parameters<MetadataLedger["append"]>[1]): void => {
      if (!flags.ledger || !ledger) return;
      const identity = ledgerIdentity(ctx);
      if (!identity) {
        ledgerStatus = "blocked: session identity is unavailable";
        return;
      }
      try {
        ledger.append(identity, input);
        ledgerStatus = "on";
      } catch {
        ledgerStatus = "blocked: ledger write failed";
      }
    };

    const reconstruct = (ctx: ExtensionContext): void => {
      const entries = branchEntries(ctx);
      state = reconstructMemoryState(entries);
      const nativeGeneration = entries.filter((entry) => entry.type === "compaction").length + 1;
      if (nativeGeneration > state.generation) state = { ...initialMemoryState(), generation: nativeGeneration };
      requestSequence = entries.filter((entry) => entry.type === "message" && (entry as any).message?.role === "assistant").length;
      latestTokens = usageTokens(ctx);
      recoveryArmed = true;
    };

    const queueReminder = (reminder: ReminderKind, tokens: number): boolean => {
      try {
        pi.sendMessage({
          customType: MEMORY_REVIEW_MESSAGE,
          content: reviewReminder(tokens, reminder),
          display: true,
          details: { version: 1, generation: state.generation, reminder },
        }, { deliverAs: "followUp", triggerTurn: true });
        persist({ version: 1, kind: "review_reminded", generation: state.generation, reminder });
        return true;
      } catch {
        return false;
      }
    };

    pi.on("session_start", (_event, ctx) => reconstruct(ctx));
    pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

    pi.on("before_agent_start", (event, ctx) => {
      latestTokens = usageTokens(ctx);
      if (latestTokens !== null && flags.ledger) {
        const bucket = Math.floor(latestTokens / 8_192);
        recordLedger(ctx, {
          event: "context_usage",
          generation: state.generation,
          context_tokens: latestTokens,
          dedupe_key: `context:g${state.generation}:b${bucket}`,
        });
      }

      let message: { customType: string; content: string; display: boolean; details: object } | undefined;
      if (recoveryArmed && state.pendingReminder !== null) {
        const pending = state.pendingReminder;
        persist({ version: 1, kind: "review_reminder_started", generation: state.generation, reminder: pending });
        if (latestTokens !== null) {
          message = {
            customType: MEMORY_REVIEW_MESSAGE,
            content: reviewReminder(latestTokens, pending),
            display: true,
            details: { version: 1, generation: state.generation, reminder: pending, recovery: true },
          };
        }
      } else if (recoveryArmed) {
        const decision = reminderDecision(state, latestTokens, flags);
        if (decision !== "none" && latestTokens !== null) {
          persist({ version: 1, kind: "review_reminded", generation: state.generation, reminder: decision });
          persist({ version: 1, kind: "review_reminder_started", generation: state.generation, reminder: decision });
          message = {
            customType: MEMORY_REVIEW_MESSAGE,
            content: reviewReminder(latestTokens, decision),
            display: true,
            details: { version: 1, generation: state.generation, reminder: decision, recovery: true },
          };
        }
      }
      recoveryArmed = false;

      if (!flags.guidance && !message) return;
      return {
        ...(flags.guidance ? { systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` } : {}),
        ...(message ? { message } : {}),
      };
    });

    const markReminderDelivered = (message: unknown): void => {
      if (!message || typeof message !== "object") return;
      const custom = message as { role?: unknown; customType?: unknown; details?: unknown };
      if (custom.role !== "custom" || custom.customType !== MEMORY_REVIEW_MESSAGE) return;
      const delivered = deliveredReminderDetails(custom.details);
      if (!delivered || delivered.generation !== state.generation || delivered.reminder !== state.pendingReminder) return;
      persist({
        version: 1,
        kind: "review_reminder_started",
        generation: delivered.generation,
        reminder: delivered.reminder,
      });
    };

    pi.on("message_start", (event) => markReminderDelivered(event.message));

    pi.on("message_end", (event, ctx) => {
      markReminderDelivered(event.message);
      if (!flags.ledger) return;
      const message = event.message as any;
      if (message?.role !== "assistant" || typeof message.provider !== "string" || typeof message.model !== "string") return;
      requestSequence++;
      const usage = usageComponents(message.usage);
      if (!usage) return;
      recordLedger(ctx, {
        event: "request_usage",
        generation: state.generation,
        provider: message.provider,
        model: message.model,
        outcome: assistantOutcome(message.stopReason),
        ...usage,
        dedupe_key: `request:${requestSequence}:${message.timestamp ?? "unknown"}:${message.provider}:${message.model}:${usage.total_tokens}:${message.stopReason ?? "unknown"}`,
      });
    });

    pi.on("agent_end", (_event, ctx) => {
      latestTokens = usageTokens(ctx) ?? latestTokens;
      const decision = reminderDecision(state, latestTokens, flags);
      if (decision !== "none" && latestTokens !== null) queueReminder(decision, latestTokens);
    });

    pi.on("session_before_compact", (event, ctx) => {
      const reason = compactionReason((event as any).reason);
      pendingCompactionReason = reason;
      if (reason !== "threshold") return;
      const preparedTokens = (event.preparation as any)?.tokensBefore;
      latestTokens = typeof preparedTokens === "number" && Number.isFinite(preparedTokens)
        ? Math.max(0, Math.round(preparedTokens))
        : usageTokens(ctx) ?? latestTokens;
      const reviewApplies = latestTokens !== null && (
        (flags.review && latestTokens >= REVIEW_THRESHOLD_TOKENS)
        || (flags.compaction && latestTokens >= COMPACTION_THRESHOLD_TOKENS)
      );
      if (reviewApplies && state.reviewOutcome === null && state.pendingReminder !== null) return { cancel: true };
      const decision = thresholdReminderDecision(state, latestTokens, flags);
      if (decision === "none" || latestTokens === null) return;
      if (queueReminder(decision, latestTokens)) return { cancel: true };
      return;
    });

    pi.on("agent_settled", (_event, ctx) => {
      latestTokens = usageTokens(ctx) ?? latestTokens;
      if (ctx.hasPendingMessages() || !shouldRequestCompaction(state, latestTokens, flags)) return;
      const generation = state.generation;
      persist({ version: 1, kind: "compaction_requested", generation });
      ctx.compact({
        customInstructions: "Preserve goals, constraints, decisions, ongoing activities and projects, commitments, progress, blockers, next steps, and critical continuity. Persisted memory is external; do not invent memory contents.",
        onError: () => {
          if (state.generation === generation && state.compactionRequested) {
            persist({ version: 1, kind: "compaction_failed", generation });
          }
        },
      });
    });

    pi.on("session_compact", (event, ctx) => {
      const completedGeneration = state.generation;
      const eventReason = compactionReason((event as any).reason);
      const observedReason = eventReason === "unknown" ? pendingCompactionReason : eventReason;
      const cause: CompactionCause = state.compactionRequested
        ? "extension_threshold"
        : observedReason === "threshold" ? "native_threshold" : observedReason;
      const entry = event.compactionEntry as any;
      const tokens = typeof entry?.tokensBefore === "number" && Number.isFinite(entry.tokensBefore)
        ? Math.max(0, Math.round(entry.tokensBefore))
        : latestTokens ?? 0;
      recordLedger(ctx, {
        event: "compaction",
        generation: completedGeneration,
        cause,
        context_tokens: tokens,
        dedupe_key: `compaction:${entry?.id ?? completedGeneration}:${cause}`,
      });

      const summaryRequest = (event as any).summaryUsage
        ?? (event as any).summaryMessage
        ?? (event as any).usage
        ?? entry?.usage
        ?? entry?.summaryUsage
        ?? entry?.details?.summaryUsage
        ?? entry?.details?.summaryMessage
        ?? entry?.details?.usage;
      const summaryUsage = usageComponents(summaryRequest);
      if (summaryUsage) {
        const summaryModel = summaryRequest?.model;
        const provider = summaryRequest?.provider
          ?? (summaryModel && typeof summaryModel === "object" ? summaryModel.provider : undefined)
          ?? (event as any).provider
          ?? ctx.model?.provider;
        const model = (typeof summaryModel === "string" ? summaryModel : summaryModel?.id)
          ?? summaryRequest?.modelId
          ?? (event as any).model
          ?? (event as any).modelId
          ?? ctx.model?.id;
        if (typeof provider === "string" && typeof model === "string") {
          recordLedger(ctx, {
            event: "compaction_usage",
            generation: completedGeneration,
            provider,
            model,
            outcome: assistantOutcome(summaryRequest?.stopReason ?? summaryRequest?.outcome ?? "stop"),
            ...summaryUsage,
            dedupe_key: `compaction-usage:${entry?.id ?? completedGeneration}`,
          });
        }
      }

      if (flags.review || flags.compaction) {
        persist({
          version: 1,
          kind: "compaction_completed",
          generation: completedGeneration,
          next_generation: completedGeneration + 1,
        });
      } else {
        state = { ...initialMemoryState(), generation: completedGeneration + 1 };
      }
      latestTokens = usageTokens(ctx);
      pendingCompactionReason = "unknown";
      recoveryArmed = false;
    });

    if (flags.review || flags.compaction) {
      pi.registerTool({
        name: "memory_review_complete",
        label: "Memory Review Complete",
        description: "Record only the bounded outcome of this context generation's authorized persisted-memory review. Never include memory text.",
        parameters: Type.Object({ outcome: StringEnum(REVIEW_OUTCOMES) }, { additionalProperties: false }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const requestedOutcome = params.outcome as MemoryReviewOutcome;
          const outcome = state.reviewOutcome ?? requestedOutcome;
          if (state.reviewOutcome === null) {
            persist({ version: 1, kind: "review_completed", generation: state.generation, outcome });
            recordLedger(ctx, {
              event: "review",
              generation: state.generation,
              outcome,
              dedupe_key: `review:g${state.generation}`,
            });
          }
          return {
            content: [{ type: "text", text: `Memory review outcome recorded: ${outcome}.` }],
            details: { version: 1, generation: state.generation, outcome },
          };
        },
      });
    }

    pi.registerCommand("memory-context-status", {
      description: "Show memory guidance, review, compaction, and metadata-ledger status",
      handler: async (_args, ctx) => {
        latestTokens = usageTokens(ctx) ?? latestTokens;
        const values = [
          `guidance=${flags.guidance ? "on" : "off"}`,
          `review=${flags.review ? "on" : "off"}`,
          `compaction=${flags.compaction ? "on" : "off"}`,
          `ledger=${ledgerStatus}`,
          `tokens=${latestTokens ?? "unknown"}`,
          `generation=${state.generation}`,
          `review_reminded=${state.reviewReminderSent ? "yes" : "no"}`,
          `review_outcome=${state.reviewOutcome ?? "pending"}`,
          `retry_used=${state.retryReminderSent ? "yes" : "no"}`,
          `pending_reminder=${state.pendingReminder ?? "none"}`,
          `compaction_requested=${state.compactionRequested ? "yes" : "no"}`,
          `thresholds=${REVIEW_THRESHOLD_TOKENS}/${COMPACTION_THRESHOLD_TOKENS}`,
        ];
        ctx.ui.notify(values.join(" | "), "info");
      },
    });
  };
}

export default createMemoryFirstCompactionExtension();
