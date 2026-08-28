import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createMemoryFirstCompactionExtension } from "./index.js";
import { MEMORY_STATE_ENTRY } from "./state.js";

function harness(
  env: NodeJS.ProcessEnv,
  seedEntries: any[] = [],
  injectedLedger: any = undefined,
  allSeedEntries: any[] = seedEntries,
) {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries = [...seedEntries];
  const separateAllEntries = allSeedEntries !== seedEntries;
  const allEntries = separateAllEntries ? [...allSeedEntries] : entries;
  const notifications: string[] = [];
  const compactCalls: any[] = [];
  const sentMessages: Array<{ message: any; options: any }> = [];
  let tokens = 0;
  let pendingMessages = false;
  const manager: any = {
    getBranch: () => entries,
    getEntries: () => allEntries,
    getSessionId: () => "fixture-session-id",
    getLeafId: () => entries.at(-1)?.id ?? "fixture-leaf",
  };
  const ctx: any = {
    mode: "tui",
    cwd: "/fixture/project",
    hasUI: true,
    model: { provider: "active-provider", id: "active-model" },
    sessionManager: manager,
    getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: tokens / 2_000 }),
    hasPendingMessages: () => pendingMessages,
    compact(options: any) { compactCalls.push(options); },
    ui: { notify(message: string) { notifications.push(message); } },
  };
  const pi: any = {
    on(name: string, handler: (event: any, context: ExtensionContext) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      if (separateAllEntries) allEntries.push(entry);
    },
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
      pendingMessages = true;
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } satisfies Partial<ExtensionAPI>;
  createMemoryFirstCompactionExtension({ env, ledger: injectedLedger })(pi as ExtensionAPI);

  async function deliverLastReminder(): Promise<void> {
    const sent = sentMessages.at(-1);
    if (!sent) throw new Error("no queued reminder");
    pendingMessages = false;
    const entry = {
      type: "custom_message",
      customType: sent.message.customType,
      details: sent.message.details,
      content: sent.message.content,
      display: sent.message.display,
    };
    entries.push(entry);
    if (separateAllEntries) allEntries.push(entry);
    const message = { role: "custom", ...sent.message };
    for (const handler of handlers.get("message_start") ?? []) await handler({ type: "message_start", message }, ctx);
  }

  return {
    handlers, entries, allEntries, tools, commands, notifications, compactCalls, sentMessages,
    ctx: ctx as ExtensionContext,
    setTokens(value: number) { tokens = value; },
    setPending(value: boolean) { pendingMessages = value; },
    deliverLastReminder,
    async emit(name: string, event: any = {}) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}

const startup = { type: "session_start", reason: "startup" };
const before = { type: "before_agent_start", systemPrompt: "base", prompt: "fixture" };

test("default-off extension has no review tool, prompt injection, state writes, messages, or compaction", async () => {
  const h = harness({});
  assert.equal(h.tools.has("memory_review_complete"), false);
  assert.equal(h.commands.has("memory-context-status"), true);
  await h.emit("session_start", startup);
  h.setTokens(150_000);
  assert.deepEqual(await h.emit("before_agent_start", before), [undefined]);
  await h.emit("agent_end", {});
  await h.emit("agent_settled", {});
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.compactCalls.length, 0);
  assert.equal(h.entries.length, 0);
});

test("state reconstruction never imports entries from an abandoned branch when active branch is empty", async () => {
  const abandoned = [
    {
      type: "custom",
      customType: MEMORY_STATE_ENTRY,
      data: { version: 1, kind: "review_completed", generation: 1, outcome: "wrote" },
    },
  ];
  const h = harness({ PI_MEMORY_CONTEXT_REVIEW: "on" }, [], undefined, abandoned);
  await h.emit("session_start", startup);
  h.setTokens(100_000);
  const [result] = await h.emit("before_agent_start", before);
  assert.equal(result.message.details.reminder, "review");
});

test("ledger activation fails closed without both >=32-byte key and explicit absolute path", async () => {
  for (const env of [
    { PI_MEMORY_CONTEXT_LEDGER: "on", PI_MEMORY_CONTEXT_LEDGER_HMAC_KEY: "x".repeat(32) },
    { PI_MEMORY_CONTEXT_LEDGER: "on", PI_MEMORY_CONTEXT_LEDGER_PATH: "relative.jsonl", PI_MEMORY_CONTEXT_LEDGER_HMAC_KEY: "x".repeat(32) },
    { PI_MEMORY_CONTEXT_LEDGER: "on", PI_MEMORY_CONTEXT_LEDGER_PATH: "/tmp/fixture.jsonl", PI_MEMORY_CONTEXT_LEDGER_HMAC_KEY: "short" },
  ]) {
    const h = harness(env);
    await h.emit("session_start", startup);
    await h.commands.get("memory-context-status").handler("", h.ctx);
    assert.match(h.notifications.at(-1)!, /ledger=blocked: explicit absolute ledger path/);
  }
});

test("guidance covers future-value short/long-term memory and ongoing activities/projects", async () => {
  const h = harness({ PI_MEMORY_CONTEXT_GUIDANCE: "on" });
  await h.emit("session_start", startup);
  const [result] = await h.emit("before_agent_start", before);
  assert.match(result.systemPrompt, /short- and long-term future-value memory/);
  assert.match(result.systemPrompt, /ongoing activities and projects/);
  assert.match(result.systemPrompt, /Scheduled runs must not wait/);
  assert.match(result.systemPrompt, /Subagents should return/);
  assert.ok(result.systemPrompt.length < 900);
});

test("agent_end queues follow-up and actual custom message_start marks it started without before_agent_start", async () => {
  const h = harness({ PI_MEMORY_CONTEXT_REVIEW: "on" });
  await h.emit("session_start", startup);
  h.setTokens(10_000);
  await h.emit("before_agent_start", before);
  h.setTokens(96_000);
  await h.emit("agent_end", {});
  assert.equal(h.sentMessages.length, 1);
  assert.deepEqual(h.sentMessages[0]!.options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(h.sentMessages[0]!.message.content, /future value/);
  const pendingSeed = [...h.entries];
  await h.emit("message_start", {
    message: {
      role: "custom",
      customType: h.sentMessages[0]!.message.customType,
      details: { version: 1, generation: 999, reminder: "review" },
    },
  });
  assert.equal(h.entries.filter((entry) => entry.data?.kind === "review_reminder_started").length, 0);
  await h.deliverLastReminder();
  assert.equal(
    h.entries.filter((entry) => entry.data?.kind === "review_reminder_started").length,
    1,
    "normal continuation has no synthetic before_agent_start",
  );

  const reloaded = harness({ PI_MEMORY_CONTEXT_REVIEW: "on" }, pendingSeed);
  await reloaded.emit("session_start", { type: "session_start", reason: "reload" });
  reloaded.setTokens(96_000);
  const [recovery] = await reloaded.emit("before_agent_start", before);
  assert.match(recovery.message.content, /Complete the memory review/);
  assert.equal(recovery.message.details.recovery, true);
});

test("direct below-96K to above-128K jump runs first and retry turns before agent_settled compaction", async () => {
  const h = harness({ PI_MEMORY_CONTEXT_REVIEW: "on", PI_MEMORY_CONTEXT_COMPACTION: "on" });
  await h.emit("session_start", startup);
  h.setTokens(80_000);
  await h.emit("before_agent_start", before);
  h.setTokens(130_000);
  await h.emit("agent_end", {});
  assert.equal(h.sentMessages[0]!.message.details.reminder, "review");
  await h.emit("agent_settled", {});
  assert.equal(h.compactCalls.length, 0);

  await h.deliverLastReminder();
  await h.emit("agent_end", {});
  assert.equal(h.sentMessages[1]!.message.details.reminder, "retry");
  await h.emit("agent_settled", {});
  assert.equal(h.compactCalls.length, 0);

  await h.deliverLastReminder();
  await h.emit("agent_end", {});
  assert.equal(h.compactCalls.length, 0, "agent_end must never request compaction");
  await h.emit("agent_settled", {});
  assert.equal(h.compactCalls.length, 1);
});

test("threshold compaction queues/cancels first and retry reminders, then passes; manual and overflow always pass", async () => {
  const h = harness({ PI_MEMORY_CONTEXT_REVIEW: "on", PI_MEMORY_CONTEXT_COMPACTION: "on" });
  await h.emit("session_start", startup);
  h.setTokens(80_000);
  await h.emit("before_agent_start", before);
  h.setTokens(100_000);

  // Exercise first-gate queueing after crossing 96K. A prior
  // before_agent_start at 100K would intentionally deliver recovery guidance
  // and make this the retry gate.
  const [first] = await h.emit("session_before_compact", { reason: "threshold", preparation: { tokensBefore: 100_000 } });
  assert.deepEqual(first, { cancel: true });
  assert.equal(h.sentMessages.at(-1)!.message.details.reminder, "review");
  const queuedCount = h.sentMessages.length;
  assert.deepEqual(await h.emit("session_before_compact", { reason: "threshold", preparation: { tokensBefore: 100_000 } }), [{ cancel: true }]);
  assert.equal(h.sentMessages.length, queuedCount, "an already queued reminder still gates without duplication");
  await h.deliverLastReminder();
  const [retry] = await h.emit("session_before_compact", { reason: "threshold", preparation: { tokensBefore: 100_000 } });
  assert.deepEqual(retry, { cancel: true });
  assert.equal(h.sentMessages.at(-1)!.message.details.reminder, "retry");
  await h.deliverLastReminder();
  assert.deepEqual(await h.emit("session_before_compact", { reason: "threshold", preparation: { tokensBefore: 100_000 } }), [undefined]);

  const sent = h.sentMessages.length;
  assert.deepEqual(await h.emit("session_before_compact", { reason: "manual", preparation: { tokensBefore: 150_000 } }), [undefined]);
  assert.deepEqual(await h.emit("session_before_compact", { reason: "overflow", preparation: { tokensBefore: 180_000 } }), [undefined]);
  assert.equal(h.sentMessages.length, sent);
});

test("native threshold below 96K for a smaller-context model is never cancelled", async () => {
  const h = harness({ PI_MEMORY_CONTEXT_REVIEW: "on", PI_MEMORY_CONTEXT_COMPACTION: "on" });
  await h.emit("session_start", startup);
  h.setTokens(80_000);
  await h.emit("before_agent_start", before);
  assert.deepEqual(await h.emit("session_before_compact", { reason: "threshold", preparation: { tokensBefore: 80_000 } }), [undefined]);
  assert.equal(h.sentMessages.length, 0);
});

test("bounded review outcome permits settled compaction without retry", async () => {
  const h = harness({ PI_MEMORY_CONTEXT_REVIEW: "on", PI_MEMORY_CONTEXT_COMPACTION: "on" });
  await h.emit("session_start", startup);
  h.setTokens(128_000);
  const tool = h.tools.get("memory_review_complete");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["outcome"]);
  assert.equal(tool.parameters.additionalProperties, false);
  const result = await tool.execute("call", { outcome: "not_relevant" }, undefined, undefined, h.ctx);
  await h.emit("agent_end", {});
  assert.equal(h.compactCalls.length, 0);
  await h.emit("agent_settled", {});
  assert.equal(h.compactCalls.length, 1);
  assert.deepEqual(result.details, { version: 1, generation: 1, outcome: "not_relevant" });
  assert.doesNotMatch(JSON.stringify(h.entries), /memory_text|secret content/ui);
});

test("ledger alone records per-request usage and compaction-summary usage without enabling prompt behavior", async () => {
  const ledgerEvents: any[] = [];
  const h = harness(
    { PI_MEMORY_CONTEXT_LEDGER: "on" },
    [],
    { append(identity: unknown, input: unknown) { ledgerEvents.push({ identity, input }); } },
  );
  await h.emit("session_start", startup);
  h.setTokens(50_000);
  assert.deepEqual(await h.emit("before_agent_start", before), [undefined]);
  await h.emit("message_end", {
    message: {
      role: "assistant", provider: "provider-raw", model: "model-raw", stopReason: "toolUse", timestamp: 123,
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, totalTokens: 154 },
    },
  });
  await h.emit("session_compact", {
    reason: "overflow",
    compactionEntry: {
      id: "raw-compaction-id",
      tokensBefore: 60_000,
      usage: { input: 50, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 65 },
    },
  });
  assert.equal(h.tools.has("memory_review_complete"), false);
  assert.equal(h.compactCalls.length, 0);
  assert.deepEqual(ledgerEvents.map((item) => item.input.event), ["context_usage", "request_usage", "compaction", "compaction_usage"]);
  const request = ledgerEvents.find((item) => item.input.event === "request_usage").input;
  const compactionUsage = ledgerEvents.find((item) => item.input.event === "compaction_usage").input;
  assert.deepEqual([compactionUsage.provider, compactionUsage.model, compactionUsage.total_tokens], ["active-provider", "active-model", 65]);
  assert.deepEqual(
    [request.input_tokens, request.output_tokens, request.cache_read_tokens, request.cache_write_tokens, request.total_tokens, request.outcome],
    [100, 20, 30, 4, 154, "tool_use"],
  );
});

test("session_compact resets typed generation state", async () => {
  const h = harness({ PI_MEMORY_CONTEXT_REVIEW: "on", PI_MEMORY_CONTEXT_COMPACTION: "on" });
  await h.emit("session_start", startup);
  await h.emit("session_compact", { reason: "manual", compactionEntry: { id: "c1", tokensBefore: 100_000 } });
  const reset = h.entries.filter((entry) => entry.customType === MEMORY_STATE_ENTRY).at(-1)?.data;
  assert.deepEqual(reset, { version: 1, kind: "compaction_completed", generation: 1, next_generation: 2 });
});

test("built Pi jiti loader resolves the directory extension", async () => {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const loaderUrl = pathToFileURL(path.join(path.dirname(packageEntry), "core/extensions/loader.js")).href;
  const { loadExtensions } = await import(loaderUrl) as {
    loadExtensions(paths: string[], cwd: string): Promise<{ extensions: unknown[]; errors: Array<{ path: string; error: string }> }>;
  };
  const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
  const result = await loadExtensions([extensionPath], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
});
