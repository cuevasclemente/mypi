import assert from "node:assert/strict";
import { after, test } from "node:test";

import commandAuthorizationMonitor, {
	PROTECTED_IDENTITY_DENIAL_REASON,
	protectedPathScopeRequested,
	protectedShellCommandRequested,
	protectedToolAccessRequested,
} from "../plugins/command-authorization-monitor.ts";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalMode = process.env.PI_COMMAND_GUARD_MODE;
const configHome = "/tmp/pi-command-guard-synthetic-config";
const workspace = "/tmp/pi-command-guard-synthetic-workspace";
const pinPath = `${configHome}/pi/command-guard-identity-pin`;

process.env.XDG_CONFIG_HOME = configHome;
process.env.PI_COMMAND_GUARD_MODE = "off";

after(() => {
	if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalConfigHome;
	if (originalMode === undefined) delete process.env.PI_COMMAND_GUARD_MODE;
	else process.env.PI_COMMAND_GUARD_MODE = originalMode;
});

test("protected path scopes cover direct, relative, ancestor, glob, env, and proc access", () => {
	const denied: Array<[unknown, string]> = [
		[pinPath, workspace],
		["command-guard-identity-pin", `${configHome}/pi`],
		["pi", configHome],
		[`${configHome}/pi/*`, workspace],
		["$XDG_CONFIG_HOME/pi/*", workspace],
		["/proc", workspace],
		["/proc/self", workspace],
		["/proc/self/environ", workspace],
		["/proc/4242/environ", workspace],
	];
	for (const [scope, cwd] of denied) {
		assert.equal(protectedPathScopeRequested(scope, cwd), true, `expected protected scope: ${String(scope)}`);
	}

	for (const scope of [undefined, null, "", "src/index.ts", "../another-project/file.ts"]) {
		assert.equal(protectedPathScopeRequested(scope, workspace), false, `expected ordinary/empty scope: ${String(scope)}`);
	}
});

test("tool-specific extraction denies protected fields without overblocking empty or irrelevant fields", () => {
	const protectedCases: Array<[string, unknown, string]> = [
		["bash", { command: `cat ${pinPath}` }, workspace],
		["read", { path: pinPath }, workspace],
		["grep", { pattern: "needle", path: `${configHome}/pi` }, workspace],
		["find", { pattern: "*", path: `${configHome}/pi/*` }, workspace],
		["ls", { path: "pi" }, configHome],
		["sudo_exec", { executable: "/usr/bin/cat", argv: [pinPath] }, workspace],
		["sudo_exec", { executable: "/usr/bin/env", argv: [] }, workspace],
		["edit", { path: pinPath, edits: [] }, workspace],
		["write", { path: pinPath, content: "replacement" }, workspace],
	];
	for (const [toolName, input, cwd] of protectedCases) {
		assert.equal(protectedToolAccessRequested(toolName, input, cwd), true, `expected ${toolName} denial`);
	}

	const ordinaryCases: Array<[string, unknown]> = [
		["bash", { command: "printf ok" }],
		["read", { path: "src/index.ts", offset: 0 }],
		["grep", { pattern: "", path: "src", glob: "" }],
		["find", { pattern: "*.ts", path: "src" }],
		["ls", { path: "src", limit: 0 }],
		["sudo_exec", { executable: "/usr/bin/id", argv: ["-u"] }],
		["read", {}],
		["read", { path: "", offset: 0 }],
		["bash", { command: "", timeout: 0 }],
		["bash", null],
		["edit", { path: "src/index.ts", edits: [] }],
		["write", { path: "src/generated.ts", content: "ok" }],
	];
	for (const [toolName, input] of ordinaryCases) {
		assert.equal(protectedToolAccessRequested(toolName, input, workspace), false, `expected ${toolName} control to pass`);
	}
});

test("shell preflight catches environment and nested shell access while ordinary commands pass", () => {
	for (const command of [
		`cat ${pinPath}`,
		"printenv",
		"cat /proc/thread-self/environ",
		`bash -lc 'cat ${pinPath}'`,
		"printf '%s' \"$PI_COMMAND_GUARD_IDENTITY_PIN\"",
	]) {
		assert.equal(protectedShellCommandRequested(command, workspace), true, `expected shell denial: ${command}`);
	}
	assert.equal(protectedShellCommandRequested("ls -la", configHome), true, "expected default cwd ancestor scope denial");
	for (const command of ["", "printf ok", "npm test", "rg 'authorization' src"]) {
		assert.equal(protectedShellCommandRequested(command, workspace), false, `expected shell control to pass: ${command}`);
	}
});

type Handler = (event: any, ctx: any) => unknown;

function syntheticExtension() {
	const handlers = new Map<string, Handler[]>();
	let modelCalls = 0;
	let execCalls = 0;
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage() {},
		exec() {
			execCalls++;
			throw new Error("synthetic exec must not run");
		},
	};
	commandAuthorizationMonitor(pi as any);
	const ctx = {
		cwd: workspace,
		hasUI: false,
		modelRegistry: new Proxy({}, {
			get() {
				modelCalls++;
				throw new Error("synthetic model registry must not be touched");
			},
		}),
	};
	const toolCall = handlers.get("tool_call")?.[0] as Handler;
	const userBash = handlers.get("user_bash")?.[0] as Handler;
	return {
		toolCall,
		userBash,
		ctx,
		async dispatchTool(event: any, eventCtx = ctx) {
			const result = await toolCall(event, eventCtx);
			if (!(result && typeof result === "object" && (result as any).block === true)) execCalls++;
			return result;
		},
		async dispatchUserBash(event: any, eventCtx = ctx) {
			const result = await userBash(event, eventCtx);
			if (!(result && typeof result === "object" && "result" in result)) execCalls++;
			return result;
		},
		calls: () => ({ modelCalls, execCalls }),
	};
}

test("tool_call preflight is unconditional, fixed-reason, and before model execution", async () => {
	const harness = syntheticExtension();
	assert.equal(typeof harness.toolCall, "function");

	const cases: Array<[string, unknown, string]> = [
		["bash", { command: `cat ${pinPath}` }, workspace],
		["read", { path: pinPath }, workspace],
		["grep", { pattern: "x", path: `${configHome}/pi` }, workspace],
		["find", { pattern: "*", path: `${configHome}/pi/*` }, workspace],
		["ls", { path: "pi" }, configHome],
		["sudo_exec", { executable: "/usr/bin/cat", argv: [pinPath] }, workspace],
	];
	for (const mode of ["off", "audit", "balanced", "strict"]) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const [toolName, input, cwd] of cases) {
			const result = await harness.dispatchTool({ toolName, input }, { ...harness.ctx, cwd });
			assert.deepEqual(result, { block: true, reason: PROTECTED_IDENTITY_DENIAL_REASON });
		}
	}
	assert.deepEqual(harness.calls(), { modelCalls: 0, execCalls: 0 });

	process.env.PI_COMMAND_GUARD_MODE = "off";
	assert.equal(await harness.dispatchTool({ toolName: "read", input: { path: "src/index.ts" } }, harness.ctx), undefined);
	assert.equal(await harness.dispatchTool({ toolName: "bash", input: { command: "printf ok" } }, harness.ctx), undefined);
	assert.deepEqual(harness.calls(), { modelCalls: 0, execCalls: 2 });
});

test("user_bash returns a denial result before execution and passes ordinary controls", async () => {
	const harness = syntheticExtension();
	assert.equal(typeof harness.userBash, "function");

	for (const event of [
		{ command: `cat ${pinPath}`, cwd: workspace },
		{ command: "ls -la", cwd: configHome },
	]) {
		const result = await harness.dispatchUserBash(event, harness.ctx);
		assert.deepEqual(result, {
			result: {
				output: PROTECTED_IDENTITY_DENIAL_REASON,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		});
	}
	assert.deepEqual(harness.calls(), { modelCalls: 0, execCalls: 0 });
	assert.equal(await harness.dispatchUserBash({ command: "printf ok", cwd: workspace }, harness.ctx), undefined);
	assert.deepEqual(harness.calls(), { modelCalls: 0, execCalls: 1 });
});
