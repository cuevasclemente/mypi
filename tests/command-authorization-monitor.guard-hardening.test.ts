/**
 * Guard verdict-hardening tests: raised verdict budget with capped reasoning,
 * circuit breaker for consecutive model failures, and the human-approval
 * fallback when the guard model cannot produce a verdict.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

// Set before the plugin import: enables the env-gated completer seam and a
// short breaker for fast cooldown-expiry coverage.
process.env.PI_COMMAND_GUARD_TEST_COMPLETER = "1";
process.env.PI_COMMAND_GUARD_BREAKER_THRESHOLD = "2";
process.env.PI_COMMAND_GUARD_BREAKER_COOLDOWN_MS = "150";

const guard = await import("../plugins/command-authorization-monitor.ts");

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const GUARD_ENV_KEYS = [
	"PI_COMMAND_GUARD_MODE",
	"PI_COMMAND_GUARD_TEST_COMPLETER",
	"PI_COMMAND_GUARD_MAX_TOKENS",
	"PI_COMMAND_GUARD_REASONING",
	"PI_COMMAND_GUARD_BREAKER_THRESHOLD",
	"PI_COMMAND_GUARD_BREAKER_COOLDOWN_MS",
	"PI_COMMAND_GUARD_APPROVAL_TIMEOUT_MS",
];
for (const key of GUARD_ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

const globalStubs: Array<[string, any]> = [];

function stubGlobal(name: string, value: any): void {
	globalStubs.push([name, (globalThis as any)[name]]);
	(globalThis as any)[name] = value;
}

function setCompleter(
	impl: (model: any, context: any, options: any) => Promise<any>,
): { calls: { model: any; context: any; options: any }[] } {
	const calls: { model: any; context: any; options: any }[] = [];
	stubGlobal("__pi_command_guard_model_completer", async (model: any, context: any, options: any) => {
		calls.push({ model, context, options });
		return impl(model, context, options);
	});
	return { calls };
}

function allowVerdictResponse(): any {
	return {
		content: [{ type: "text", text: JSON.stringify({ allow: true, reason: "test allow", risk: "low" }) }],
		stopReason: "stop",
	};
}

function lengthOverflowThinkingResponse(): any {
	return {
		content: [{ type: "thinking", thinking: "reasoning..." }],
		stopReason: "length",
	};
}

function makeCtx(overrides: Record<string, unknown> = {}): any {
	return {
		cwd: "/tmp/guard-hardening-test",
		hasUI: false,
		model: { provider: "together", id: "zai-org/GLM-5.3-Flash" },
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
		},
		sessionManager: {
			getBranch: () => [],
			getSessionFile: () => undefined,
			getSessionId: () => undefined,
		},
		...overrides,
	};
}

function makeHookHarness(ctx: any): { tool: (toolName: string, input: Record<string, unknown>) => Promise<{ result: any; executed: boolean }> } {
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	const pi: any = {
		on(name: string, handler: any) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage() {},
	};
	guard.default(pi);
	return {
		async tool(toolName: string, input: Record<string, unknown>) {
			let executed = false;
			let result: any;
			for (const handler of handlers.get("tool_call") ?? []) {
				result = await handler({ toolName, input, toolCallId: "test" }, ctx);
				if (result?.block) break;
			}
			if (!result?.block) executed = true;
			return { result, executed };
		},
	};
}

after(() => {
	for (const key of GUARD_ENV_KEYS) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
		else process.env[key] = ORIGINAL_ENV[key];
	}
	for (const [name, value] of globalStubs) {
		if (value === undefined) delete (globalThis as any)[name];
		else (globalThis as any)[name] = value;
	}
	guard.resetGuardModelHealth();
});

test("verdict call uses raised budget and low reasoning by default", async () => {
	guard.resetGuardModelHealth();
	const { calls } = setCompleter(async () => allowVerdictResponse());
	const result = await guard.evaluateCommand("printf ok", {}, makeCtx());
	assert.equal(calls.length, 1);
	assert.equal(result.modelFailure, undefined);
	assert.equal(result.verdict.allow, true);
	assert.equal(calls[0]!.options.maxTokens, 4096);
	assert.equal(calls[0]!.options.reasoning, "low");
});

test("budget and reasoning honor environment overrides at call time", async () => {
	guard.resetGuardModelHealth();
	process.env.PI_COMMAND_GUARD_MAX_TOKENS = "2048";
	process.env.PI_COMMAND_GUARD_REASONING = "off";
	try {
		const { calls } = setCompleter(async () => allowVerdictResponse());
		const result = await guard.evaluateCommand("printf ok", {}, makeCtx());
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.options.maxTokens, 2048);
		assert.equal(calls[0]!.options.reasoning, "off");
		assert.equal(result.modelFailure, undefined);
		const budgets = guard.guardVerdictBudgets();
		assert.equal(budgets.maxTokens, 2048);
		assert.equal(budgets.reasoning, "off");
	} finally {
		delete process.env.PI_COMMAND_GUARD_MAX_TOKENS;
		delete process.env.PI_COMMAND_GUARD_REASONING;
	}
});

test("thinking-only length responses are recorded as model failures", async () => {
	guard.resetGuardModelHealth();
	const { calls } = setCompleter(async () => lengthOverflowThinkingResponse());
	const result = await guard.evaluateCommand("printf ok", {}, makeCtx());
	assert.equal(result.modelFailure, true);
	assert.equal(result.verdict.allow, false);
	assert.ok(result.verdict.reason.includes("stopReason=length"));
	assert.equal(guard.guardModelHealthSnapshot().consecutiveFailures, 1);
	assert.equal(calls.length, 1);
});

test("circuit breaker opens at threshold and skips the model entirely", async () => {
	guard.resetGuardModelHealth();
	const { calls } = setCompleter(async () => lengthOverflowThinkingResponse());
	await guard.evaluateCommand("printf one", {}, makeCtx());
	await guard.evaluateCommand("printf two", {}, makeCtx());
	const snapshot = guard.guardModelHealthSnapshot();
	assert.equal(snapshot.consecutiveFailures, 2);
	assert.equal(snapshot.breakerOpen, true);
	const third = await guard.evaluateCommand("printf three", {}, makeCtx());
	assert.equal(calls.length, 2, "breaker must skip the model call");
	assert.equal(third.modelFailure, true);
	assert.equal(third.model, "circuit-breaker");
	assert.ok(third.verdict.reason.includes("circuit breaker open"));
});

test("circuit breaker closes after the cooldown window", async () => {
	guard.resetGuardModelHealth();
	const { calls } = setCompleter(async () => lengthOverflowThinkingResponse());
	await guard.evaluateCommand("printf one", {}, makeCtx());
	await guard.evaluateCommand("printf two", {}, makeCtx());
	assert.equal(guard.guardModelHealthSnapshot().breakerOpen, true);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(guard.guardModelHealthSnapshot().breakerOpen, false);
	await guard.evaluateCommand("printf three", {}, makeCtx());
	assert.equal(calls.length, 3, "model must be retried after cooldown");
});

test("a parseable verdict resets the failure count", async () => {
	guard.resetGuardModelHealth();
	let fail = true;
	setCompleter(async () => (fail ? lengthOverflowThinkingResponse() : allowVerdictResponse()));
	await guard.evaluateCommand("printf one", {}, makeCtx());
	assert.equal(guard.guardModelHealthSnapshot().consecutiveFailures, 1);
	fail = false;
	const result = await guard.evaluateCommand("printf two", {}, makeCtx());
	assert.equal(result.modelFailure, undefined);
	assert.equal(guard.guardModelHealthSnapshot().consecutiveFailures, 0);
});

test("human approval bridge allows a command when the model fails", async () => {
	guard.resetGuardModelHealth();
	process.env.PI_COMMAND_GUARD_MODE = "strict";
	setCompleter(async () => lengthOverflowThinkingResponse());
	const approvals: Array<{ command?: string; reason?: string }> = [];
	stubGlobal("__pi_command_guard_pi_sessions", new Map([["pi-session-1", "wayang-session-1"]]));
	stubGlobal("__pi_command_guard_approval_bridge", {
		requestCommandApproval: async (_sessionId: string, prompt: string, timeoutMs: number, options: any) => {
			assert.equal(typeof timeoutMs, "number");
			approvals.push({ command: options?.command, reason: options?.reason });
			return true;
		},
	});
	const ctx = makeCtx({ sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "pi-session-1" } });
	const harness = makeHookHarness(ctx);
	const outcome = await harness.tool("bash", { command: "printf ok" });
	assert.equal(outcome.executed, true, "approved command must run");
	assert.equal(approvals.length, 1);
	assert.equal(approvals[0]!.command, "printf ok");
	assert.ok(approvals[0]!.reason!.includes("stopReason=length"));
});

test("human denial blocks the command with a clear reason", async () => {
	guard.resetGuardModelHealth();
	process.env.PI_COMMAND_GUARD_MODE = "strict";
	setCompleter(async () => lengthOverflowThinkingResponse());
	stubGlobal("__pi_command_guard_pi_sessions", new Map([["pi-session-2", "wayang-session-2"]]));
	stubGlobal("__pi_command_guard_approval_bridge", {
		requestCommandApproval: async () => false,
	});
	const ctx = makeCtx({ sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "pi-session-2" } });
	const harness = makeHookHarness(ctx);
	const outcome = await harness.tool("bash", { command: "printf ok" });
	assert.equal(outcome.executed, false);
	assert.equal(outcome.result?.block, true);
	assert.ok(outcome.result?.reason.includes("user denied"));
});

test("approval timeout or unavailable channel fails closed", async () => {
	guard.resetGuardModelHealth();
	process.env.PI_COMMAND_GUARD_MODE = "strict";
	setCompleter(async () => lengthOverflowThinkingResponse());
	// No approval bridge registered and hasUI=false: must fail closed.
	const ctx = makeCtx();
	const harness = makeHookHarness(ctx);
	const outcome = await harness.tool("bash", { command: "printf ok" });
	assert.equal(outcome.executed, false);
	assert.equal(outcome.result?.block, true);
	assert.ok(outcome.result?.reason.includes("human approval unavailable"));
});

test("audit mode keeps warn-only semantics on model failure", async () => {
	guard.resetGuardModelHealth();
	process.env.PI_COMMAND_GUARD_MODE = "audit";
	setCompleter(async () => lengthOverflowThinkingResponse());
	const ctx = makeCtx();
	const harness = makeHookHarness(ctx);
	const outcome = await harness.tool("bash", { command: "printf ok" });
	assert.equal(outcome.executed, true, "audit mode must not block");
	assert.equal(outcome.result, undefined);
});

test("no configured models counts as a model failure for the fallback path", async () => {
	guard.resetGuardModelHealth();
	process.env.PI_COMMAND_GUARD_MODE = "strict";
	const ctx = makeCtx({
		model: { provider: "unrouted-provider", id: "some-model" },
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
		},
	});
	const result = await guard.evaluateCommand("printf ok", {}, ctx);
	assert.equal(result.modelFailure, true);
	assert.equal(result.verdict.reason, "Command guard model unavailable");
	assert.equal(guard.guardModelHealthSnapshot().consecutiveFailures, 1);
});