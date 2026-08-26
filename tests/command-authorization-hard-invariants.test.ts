import assert from "node:assert/strict";
import test from "node:test";

import commandAuthorizationMonitor, {
	PROTECTED_IDENTITY_DENIAL_REASON,
	commandInvokesSudo,
	evaluateCommand,
	protectedPathScopeRequested,
	protectedShellCommandRequested,
	protectedToolAccessRequested,
} from "../plugins/command-authorization-monitor.ts";

const CWD = "/tmp/synthetic-command-guard-project";
const PIN_PATH = "$XDG_CONFIG_HOME/pi/command-guard-identity-pin";

test("pure classifiers deny PIN, broad environment, protected path, raw sudo, and wrappers", () => {
	assert.equal(protectedPathScopeRequested(PIN_PATH, CWD), true);
	assert.equal(protectedShellCommandRequested(`cat ${PIN_PATH}`, CWD), true);
	assert.equal(protectedShellCommandRequested("env", CWD), true);
	assert.equal(protectedShellCommandRequested("python -c 'print(os.environ)'", CWD), true);
	assert.equal(protectedShellCommandRequested("cat /proc/self/environ", CWD), true);
	assert.equal(protectedShellCommandRequested(`env -- cat ${PIN_PATH}`, CWD), true);
	assert.equal(protectedShellCommandRequested(`bash -lc 'cat ${PIN_PATH}'`, CWD), true);
	assert.equal(protectedToolAccessRequested("sudo_exec", { executable: "/usr/bin/env", argv: [] }, CWD), true);
	assert.equal(commandInvokesSudo("sudo -n true"), true);
	assert.equal(commandInvokesSudo("env -- bash -lc 'sudo -n true'"), true);
	assert.equal(commandInvokesSudo("timeout 1 sudo -n true"), true);
});

test("model unavailability fails closed for residual commands", async () => {
	const result = await evaluateCommand(
		"git push synthetic-remote HEAD",
		{ command: "git push synthetic-remote HEAD" },
		{
			model: undefined,
			modelRegistry: { find: () => undefined },
		} as any,
	);

	assert.equal(result.verdict.allow, false);
	assert.equal(result.verdict.risk, "high");
	assert.match(result.verdict.reason, /model unavailable/i);
});

function registeredHandlers() {
	const handlers = new Map<string, Function[]>();
	const pi = {
		on(name: string, handler: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage() {},
	} as any;
	commandAuthorizationMonitor(pi);
	return handlers;
}

function hookContext() {
	return {
		cwd: CWD,
		hasUI: false,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => undefined,
			getSessionFile: () => undefined,
		},
	} as any;
}

test("hard controls run before mode, tool, local allow, and model branches", async () => {
	const previousMode = process.env.PI_COMMAND_GUARD_MODE;
	process.env.PI_COMMAND_GUARD_MODE = "off";
	try {
		const handlers = registeredHandlers();
		const toolCall = handlers.get("tool_call")?.[0];
		assert.ok(toolCall);

		const readDenial = await toolCall(
			{ toolName: "read", input: { path: PIN_PATH } },
			hookContext(),
		);
		assert.deepEqual(readDenial, { block: true, reason: PROTECTED_IDENTITY_DENIAL_REASON });

		const sudoExecDenial = await toolCall(
			{ toolName: "sudo_exec", input: { executable: "/usr/bin/env", argv: [] } },
			hookContext(),
		);
		assert.deepEqual(sudoExecDenial, { block: true, reason: PROTECTED_IDENTITY_DENIAL_REASON });

		const rawSudoDenial = await toolCall(
			{ toolName: "bash", input: { command: "env -- sudo -n true" } },
			hookContext(),
		);
		assert.equal(rawSudoDenial?.block, true);
		assert.match(rawSudoDenial?.reason ?? "", /Raw sudo is disabled/);
	} finally {
		if (previousMode === undefined) delete process.env.PI_COMMAND_GUARD_MODE;
		else process.env.PI_COMMAND_GUARD_MODE = previousMode;
	}
});

test("residual hook path fails closed when every model is unavailable", async () => {
	const previousMode = process.env.PI_COMMAND_GUARD_MODE;
	process.env.PI_COMMAND_GUARD_MODE = "strict";
	try {
		const toolCall = registeredHandlers().get("tool_call")?.[0];
		assert.ok(toolCall);
		const denial = await toolCall(
			{ toolName: "bash", input: { command: "git push synthetic-remote HEAD" } },
			hookContext(),
		);
		assert.equal(denial?.block, true);
		assert.match(denial?.reason ?? "", /model unavailable/i);
	} finally {
		if (previousMode === undefined) delete process.env.PI_COMMAND_GUARD_MODE;
		else process.env.PI_COMMAND_GUARD_MODE = previousMode;
	}
});

test("direct user_bash cannot bypass protected-access enforcement", () => {
	const handlers = registeredHandlers();
	const userBash = handlers.get("user_bash")?.[0];
	assert.ok(userBash);

	const denial = userBash({ command: "env", cwd: CWD }, hookContext());
	assert.equal(denial?.result?.exitCode, 1);
	assert.equal(denial?.result?.output, PROTECTED_IDENTITY_DENIAL_REASON);
});
