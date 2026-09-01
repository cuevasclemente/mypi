import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import commandAuthorizationMonitor from "../plugins/command-authorization-monitor.ts";

const PIN_FILENAME = "command-guard-identity-pin";
const DENIAL = "Protected identity configuration is unavailable to agent tools.";
const UNRESOLVED_DENIAL =
	"Command contains an unresolved operational shell expansion; use a literal path or an explicitly supported variable form.";
const RAW_SUDO_DENIAL = "Raw sudo is disabled; use sudo_exec with an absolute executable path and exact argv.";
const WAYANG_SESSION_OWNERSHIP_SYMBOL = Symbol.for("wayang.owned-session-managers.v1");
const MODES = ["off", "audit", "balanced", "strict"] as const;
const TOOL_NAMES = ["bash", "read", "grep", "find", "ls", "write", "edit", "sudo_exec"] as const;

type Handler = (event: any, ctx: any) => Promise<any> | any;

function createHarness(cwd: string, runtime: "wayang" | "cli" = "wayang") {
	const handlers = new Map<string, Handler[]>();
	let modelLookups = 0;
	const pi: any = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage() {},
	};
	commandAuthorizationMonitor(pi);
	const sessionManager = {
		getBranch: () => [],
		getSessionFile: () => undefined,
		getSessionId: () => undefined,
	};
	if (runtime === "wayang") {
		const globals = globalThis as any;
		const owners = globals[WAYANG_SESSION_OWNERSHIP_SYMBOL] instanceof WeakSet
			? globals[WAYANG_SESSION_OWNERSHIP_SYMBOL] as WeakSet<object>
			: new WeakSet<object>();
		owners.add(sessionManager);
		globals[WAYANG_SESSION_OWNERSHIP_SYMBOL] = owners;
	}
	const ctx: any = {
		cwd,
		hasUI: false,
		mode: runtime === "wayang" ? "rpc" : "tui",
		model: { provider: "test", id: "test" },
		modelRegistry: {
			find() {
				modelLookups++;
				return undefined;
			},
		},
		sessionManager,
	};

	return {
		get modelLookups() { return modelLookups; },
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
		async userBash(command: string) {
			let executed = false;
			let result: any;
			for (const handler of handlers.get("user_bash") ?? []) {
				result = await handler({ command, cwd, excludeFromContext: false }, ctx);
				if (result?.result || result?.operations) break;
			}
			if (!result?.result && !result?.operations) executed = true;
			return { result, executed };
		},
	};
}

function toolInput(toolName: typeof TOOL_NAMES[number], scope: string): Record<string, unknown> {
	switch (toolName) {
		case "bash": return { command: `cat ${scope}` };
		case "read": return { path: scope };
		case "grep": return { pattern: "nonsecret", path: scope };
		case "find": return { pattern: "*", path: scope };
		case "ls": return { path: scope };
		case "write": return { path: scope, content: "nonsecret" };
		case "edit": return { path: scope, edits: [{ oldText: "before", newText: "after" }] };
		case "sudo_exec": return { executable: "/usr/bin/cat", argv: [scope] };
	}
}

function assertGenericToolDenial(
	outcome: { result: any; executed: boolean },
	modelLookups: number,
	expectedReason = DENIAL,
) {
	assert.equal(outcome.result?.block, true);
	assert.equal(outcome.result?.reason, expectedReason);
	assert.ok(Buffer.byteLength(outcome.result.reason, "utf8") <= 128);
	assert.equal(outcome.executed, false, "denial must not reach simulated tool execution");
	assert.equal(modelLookups, 0, "denial must not route to a guard model");
}

function assertGenericUserBashDenial(
	outcome: { result: any; executed: boolean },
	modelLookups: number,
	expectedReason = DENIAL,
) {
	assert.equal(outcome.result?.result?.output, expectedReason);
	assert.equal(outcome.result?.result?.exitCode, 1);
	assert.ok(Buffer.byteLength(outcome.result.result.output, "utf8") <= 128);
	assert.equal(outcome.executed, false, "denial must not reach simulated user shell execution");
	assert.equal(modelLookups, 0, "denial must not route to a guard model");
}

test("standalone Pi CLI sessions do not inherit Wayang protected-identity preflight", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-cli-scope-${process.pid}`);
	const configHome = path.join(fixtureRoot, "config");
	const pinPath = path.join(configHome, "pi", PIN_FILENAME);
	const cwd = path.join(fixtureRoot, "project");
	process.env.XDG_CONFIG_HOME = configHome;
	process.env.PI_COMMAND_GUARD_MODE = "off";

	const toolCases: Array<[string, Record<string, unknown>]> = [
		["bash", { command: 'resolvectl query -4 --cache=no archlinux.org; echo "rc=$?"' }],
		["bash", { command: `cat ${pinPath}` }],
		["bash", { command: "env" }],
		["read", { path: pinPath }],
		["custom_path_tool", { path: pinPath }],
	];
	for (const [toolName, input] of toolCases) {
		const harness = createHarness(cwd, "cli");
		const outcome = await harness.tool(toolName, input);
		assert.equal(outcome.result, undefined, toolName);
		assert.equal(outcome.executed, true, toolName);
		assert.equal(harness.modelLookups, 0, toolName);
	}

	for (const command of [
		'resolvectl query -4 --cache=no archlinux.org; echo "rc=$?"',
		`cat ${pinPath}`,
		"env",
	]) {
		const harness = createHarness(cwd, "cli");
		const outcome = await harness.userBash(command);
		assert.equal(outcome.result, undefined, command);
		assert.equal(outcome.executed, true, command);
		assert.equal(harness.modelLookups, 0, command);
	}
});

test("Wayang-owned sessions keep protected preflight for the reported DNS-query shape", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-wayang-dns-scope-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	process.env.PI_COMMAND_GUARD_MODE = "off";
	const cwd = path.join(fixtureRoot, "project");
	const command = 'resolvectl query -4 --cache=no archlinux.org; echo "rc=$?"';

	const toolHarness = createHarness(cwd);
	assertGenericToolDenial(
		await toolHarness.tool("bash", { command }),
		toolHarness.modelLookups,
		UNRESOLVED_DENIAL,
	);
	const userHarness = createHarness(cwd);
	assertGenericUserBashDenial(
		await userHarness.userBash(command),
		userHarness.modelLookups,
		UNRESOLVED_DENIAL,
	);
});

test("PIN path invariant is unconditional across Wayang modes, tools, and direct/relative/ancestor/glob scopes", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-invariant-${process.pid}`);
	const configHome = path.join(fixtureRoot, "config");
	const pinParent = path.join(configHome, "pi");
	const pinPath = path.join(pinParent, PIN_FILENAME);
	const project = path.join(fixtureRoot, "project");
	process.env.XDG_CONFIG_HOME = configHome;

	const scopes = [
		{ name: "direct", cwd: project, value: pinPath },
		{ name: "relative", cwd: path.join(pinParent, "nested"), value: ".." },
		{ name: "ancestor", cwd: project, value: configHome },
		{ name: "glob", cwd: project, value: path.join(pinParent, "*") },
	];

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const scope of scopes) {
			for (const toolName of TOOL_NAMES) {
				const harness = createHarness(scope.cwd);
				const outcome = await harness.tool(toolName, toolInput(toolName, scope.value));
				assertGenericToolDenial(outcome, harness.modelLookups);
				assert.equal(outcome.result.reason.includes(PIN_FILENAME), false, `${mode}/${scope.name}/${toolName} leaked protected input`);
			}

			const harness = createHarness(scope.cwd);
			const outcome = await harness.userBash(`cat ${scope.value}`);
			assertGenericUserBashDenial(outcome, harness.modelLookups);
			assert.equal(outcome.result.result.output.includes(PIN_FILENAME), false, `${mode}/${scope.name}/user_bash leaked protected input`);
		}
	}
});

test("implicit cwd readers are denied when cwd is a protected ancestor scope", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-implicit-scope-${process.pid}`);
	const configHome = path.join(fixtureRoot, "config");
	process.env.XDG_CONFIG_HOME = configHome;
	process.env.PI_COMMAND_GUARD_MODE = "off";
	const cases: Array<[typeof TOOL_NAMES[number], Record<string, unknown>]> = [
		["bash", { command: "ls" }],
		["grep", { pattern: "anything" }],
		["find", { pattern: "*" }],
		["ls", {}],
		["sudo_exec", { executable: "/usr/bin/ls", argv: [] }],
		["sudo_exec", { executable: "/usr/bin/env", argv: ["-i", "/usr/bin/ls"] }],
	];
	for (const [toolName, input] of cases) {
		const harness = createHarness(configHome);
		assertGenericToolDenial(await harness.tool(toolName, input), harness.modelLookups);
	}
	const harness = createHarness(configHome);
	assertGenericUserBashDenial(await harness.userBash("env -i find"), harness.modelLookups);
});

test("path omission, empty string, and bare @ follow each built-in tool's cwd semantics", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-path-normalization-${process.pid}`);
	const configHome = path.join(fixtureRoot, "config");
	process.env.XDG_CONFIG_HOME = configHome;
	process.env.PI_COMMAND_GUARD_MODE = "off";

	for (const toolName of ["grep", "find", "ls"] as const) {
		for (const pathInput of [undefined, "", "@"] as const) {
			const harness = createHarness(configHome);
			const input = toolName === "grep"
				? { pattern: "anything", ...(pathInput === undefined ? {} : { path: pathInput }) }
				: toolName === "find"
					? { pattern: "*", ...(pathInput === undefined ? {} : { path: pathInput }) }
					: pathInput === undefined ? {} : { path: pathInput };
			assertGenericToolDenial(await harness.tool(toolName, input), harness.modelLookups);
		}
	}

	for (const toolName of ["read", "write", "edit"] as const) {
		const omittedHarness = createHarness(configHome);
		const omitted = toolName === "write"
			? { content: "data" }
			: toolName === "edit"
				? { edits: [{ oldText: "before", newText: "after" }] }
				: {};
		const omittedOutcome = await omittedHarness.tool(toolName, omitted);
		assert.equal(omittedOutcome.result, undefined, `${toolName} omission is left to its required-field schema`);
		assert.equal(omittedHarness.modelLookups, 0);

		for (const pathInput of ["", "@"] as const) {
			const harness = createHarness(configHome);
			assertGenericToolDenial(await harness.tool(toolName, toolInput(toolName, pathInput)), harness.modelLookups);
		}
	}
});

test("XDG config path expressions cannot hide ancestor or glob scope", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-expanded-path-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	process.env.PI_COMMAND_GUARD_MODE = "off";
	const cwd = path.join(fixtureRoot, "project");
	for (const scope of ["$XDG_CONFIG_HOME", "${XDG_CONFIG_HOME}/pi/*"]) {
		for (const toolName of TOOL_NAMES) {
			const harness = createHarness(cwd);
			assertGenericToolDenial(await harness.tool(toolName, toolInput(toolName, scope)), harness.modelLookups);
		}
		const harness = createHarness(cwd);
		assertGenericUserBashDenial(await harness.userBash(`find ${scope}`), harness.modelLookups);
	}
});

test("legacy PIN environment reads are denied without inspecting the variable value", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-env-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	process.env.PI_COMMAND_GUARD_MODE = "off";
	const cwd = path.join(fixtureRoot, "project");
	const cases: Array<[typeof TOOL_NAMES[number], Record<string, unknown>]> = [
		["bash", { command: "env" }],
		["bash", { command: "env -i printenv" }],
		["bash", { command: "printenv PI_COMMAND_GUARD_IDENTITY_PIN" }],
		["bash", { command: "echo $PI_COMMAND_GUARD_IDENTITY_PIN" }],
		["read", { path: "/proc/self/environ" }],
		["grep", { pattern: "anything", path: "/proc/self" }],
		["find", { pattern: "environ", path: "/proc" }],
		["ls", { path: "/proc/self" }],
		["sudo_exec", { executable: "/usr/bin/env", argv: [], cwd }],
		["sudo_exec", { executable: "/usr/bin/cat", argv: ["/proc/1/environ"], cwd }],
	];

	for (const [toolName, input] of cases) {
		const harness = createHarness(cwd);
		assertGenericToolDenial(await harness.tool(toolName, input), harness.modelLookups);
	}
	for (const command of ["env", "env -i printenv", "export -p", "echo $PI_COMMAND_GUARD_IDENTITY_PIN", "bash -c 'printenv'"]) {
		const harness = createHarness(cwd);
		assertGenericUserBashDenial(await harness.userBash(command), harness.modelLookups);
	}
});

test("direct environment dumps stay denied through nested command wrappers in every mode", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-wrapper-env-dumps-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	const cwd = path.join(fixtureRoot, "project");
	const commands = [
		"/usr/bin/timeout 1 /usr/bin/env",
		"xargs env </dev/null",
		"setsid env",
		"stdbuf -oL env",
		"command timeout --signal TERM 1 env -u PATH",
		"time -f elapsed timeout --kill-after 2 1 printenv --null",
		"nohup setsid stdbuf --output=L env --ignore-environment",
		"nice -n 5 timeout 1 bash -c set",
		"timeout --preserve-status 1 bash -c 'export -p'",
		"setsid bash -c 'declare -p'",
		"stdbuf -o L bash -c 'typeset -p'",
		"xargs --max-args 1 bash -c export </dev/null",
		"env --unset PATH --chdir /tmp command -- env",
	];

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const toolHarness = createHarness(cwd);
			assertGenericToolDenial(await toolHarness.tool("bash", { command }), toolHarness.modelLookups);
			const userHarness = createHarness(cwd);
			assertGenericUserBashDenial(await userHarness.userBash(command), userHarness.modelLookups);
		}
	}
});

test("benign wrapper commands and option arguments are not mistaken for environment dumps", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-wrapper-controls-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	const cwd = path.join(fixtureRoot, "project");
	const commands = [
		"/usr/bin/timeout 1 /usr/bin/printf ok",
		"xargs printf </dev/null",
		"setsid printf ok",
		"stdbuf -oL printf ok",
		"timeout --signal env 1 printf ok",
		"time -f env printf ok",
		"nice -n env printf ok",
		"stdbuf -o env printf ok",
		"xargs -a env printf </dev/null",
		"env -u env printf ok",
		"command -v env",
	];

	process.env.PI_COMMAND_GUARD_MODE = "off";
	for (const command of commands) {
		const toolHarness = createHarness(cwd);
		const toolOutcome = await toolHarness.tool("bash", { command });
		assert.equal(toolOutcome.result, undefined, command);
		assert.equal(toolOutcome.executed, true, command);
		assert.equal(toolHarness.modelLookups, 0, command);
	}

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const userHarness = createHarness(cwd);
			const userOutcome = await userHarness.userBash(command);
			assert.equal(userOutcome.result, undefined, `${mode}/${command}`);
			assert.equal(userOutcome.executed, true, `${mode}/${command}`);
			assert.equal(userHarness.modelLookups, 0, `${mode}/${command}`);
		}
	}
});

test("data fields may mention protected environment tokens without becoming access paths", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-data-fields-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	process.env.PI_COMMAND_GUARD_MODE = "balanced";
	const cwd = path.join(fixtureRoot, "project");
	const marker = "process.env.PI_COMMAND_GUARD_IDENTITY_PIN";
	const cases: Array<[string, Record<string, unknown>]> = [
		["grep", { pattern: marker, path: cwd }],
		["find", { pattern: `*${marker}*`, path: cwd }],
		["write", { path: path.join(cwd, "example.ts"), content: marker }],
		["edit", { path: path.join(cwd, "example.ts"), edits: [{ oldText: marker, newText: `${marker}_renamed` }] }],
		["custom_search", { pattern: marker, content: marker, replacements: [{ from: marker, to: marker }] }],
	];
	for (const [toolName, input] of cases) {
		const harness = createHarness(cwd);
		const outcome = await harness.tool(toolName, input);
		assert.equal(outcome.result, undefined, toolName);
		assert.equal(outcome.executed, true, toolName);
		assert.equal(harness.modelLookups, 0, toolName);
	}
	for (const command of [
		`rg '${marker}' ${cwd}`,
		`grep '${marker}' ${path.join(cwd, "example.ts")}`,
		`find ${cwd} -name '${marker}'`,
	]) {
		const toolHarness = createHarness(cwd);
		const toolOutcome = await toolHarness.tool("bash", { command });
		assert.equal(toolOutcome.result, undefined, command);
		assert.equal(toolHarness.modelLookups, 0, command);
		const userHarness = createHarness(cwd);
		const userOutcome = await userHarness.userBash(command);
		assert.equal(userOutcome.result, undefined, command);
		assert.equal(userHarness.modelLookups, 0, command);
	}
});

test("unknown tools conservatively protect conventional operational fields", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-unknown-tools-${process.pid}`);
	const configHome = path.join(fixtureRoot, "config");
	const pinPath = path.join(configHome, "pi", PIN_FILENAME);
	process.env.XDG_CONFIG_HOME = configHome;
	process.env.PI_COMMAND_GUARD_MODE = "off";
	const cwd = path.join(fixtureRoot, "project");
	const cases: Record<string, unknown>[] = [
		{ path: pinPath },
		{ cwd: configHome },
		{ executable: pinPath },
		{ argv: [pinPath] },
		{ path: { candidate: pinPath } },
		{ command: `cat ${pinPath}` },
	];
	for (const input of cases) {
		const harness = createHarness(cwd);
		assertGenericToolDenial(await harness.tool("custom_path_tool", input), harness.modelLookups);
	}
});

test("bash and user_bash deny redirections and variable-built leaves below the protected parent", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-shell-operands-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	process.env.PI_COMMAND_GUARD_MODE = "off";
	const cwd = path.join(fixtureRoot, "project");
	const commands = [
		`printf ignored > "$XDG_CONFIG_HOME/pi/$leaf"`,
		`printf ignored >> "$XDG_CONFIG_HOME/pi/"*`,
		`cat < "$XDG_CONFIG_HOME/pi/$leaf"`,
		`leaf=runtime-chosen; cat "$XDG_CONFIG_HOME/pi/$leaf"`,
	];
	for (const command of commands) {
		const toolHarness = createHarness(cwd);
		assertGenericToolDenial(await toolHarness.tool("bash", { command }), toolHarness.modelLookups);
		const userHarness = createHarness(cwd);
		assertGenericUserBashDenial(await userHarness.userBash(command), userHarness.modelLookups);
	}
});

test("unresolved shell expansions in operational words fail closed before mode or model routing", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-unresolved-shell-expansion-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	const cwd = path.join(fixtureRoot, "project");
	const commands = [
		'cat "$runtime_path"',
		'cat "${runtime_path}"',
		'cat "$(printf runtime-path)"',
		"cat \"`printf runtime-path`\"",
		'printf ignored > "$runtime_path"',
		'printf ignored > "${runtime_path}"',
		'printf ignored > "$(printf runtime-path)"',
		"printf ignored > \"`printf runtime-path`\"",
		'cat <(printf runtime-path)',
		'cat "$[1+1]"',
		"cat $'/tmp/pi-command-guard-synthetic-config/pi/command-guard-identity-\\x70\\x69\\x6e'",
		'p=\'BEGIN { for (name in ENVIRON) print ENVIRON[name] }\'; awk "$p"',
		'sed_program=\'s|before|after|\'; sed "$sed_program" input.txt',
		'printf ignored > >(cat)',
	];

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const toolHarness = createHarness(cwd);
			assertGenericToolDenial(
				await toolHarness.tool("bash", { command }),
				toolHarness.modelLookups,
				UNRESOLVED_DENIAL,
			);
			const userHarness = createHarness(cwd);
			assertGenericUserBashDenial(
				await userHarness.userBash(command),
				userHarness.modelLookups,
				UNRESOLVED_DENIAL,
			);
		}
	}
});

test("XDG fallback plus split PIN leaf overwrite/read bypasses are fixed for bash and user_bash in every mode", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-xdg-fallback-split-pin-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	const cwd = path.join(fixtureRoot, "project");
	const dynamicPinPath = "${XDG_CONFIG_HOME:-$HOME/.config}/pi/command-guard-identity-p${IFS:+}in";
	const commands = [
		`printf ignored > "${dynamicPinPath}"`,
		`cat "${dynamicPinPath}"`,
	];

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const toolHarness = createHarness(cwd);
			assertGenericToolDenial(await toolHarness.tool("bash", { command }), toolHarness.modelLookups);
			const userHarness = createHarness(cwd);
			assertGenericUserBashDenial(await userHarness.userBash(command), userHarness.modelLookups);
		}
	}
});

test("data words cannot expand or query protected identity values", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-data-word-identity-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	const cwd = path.join(fixtureRoot, "project");
	const pinPath = path.join(process.env.XDG_CONFIG_HOME, "pi", PIN_FILENAME);
	const commands = [
		'grep "$PI_COMMAND_GUARD_IDENTITY_PIN" /dev/null',
		'grep -f "${XDG_CONFIG_HOME:-$HOME/.config}/pi/command-guard-identity-pin" /dev/null',
		'awk \'BEGIN { print ENVIRON["PI_COMMAND_GUARD_IDENTITY_PIN"] }\'',
		'awk \'BEGIN { for (name in ENVIRON) print ENVIRON[name] }\'',
		'gawk \'BEGIN { for (name in ENVIRON) print ENVIRON[name] }\'',
		'mawk \'BEGIN { for (name in ENVIRON) print ENVIRON[name] }\'',
		`awk "BEGIN { print \\"$(cat ${pinPath})\\" }"`,
	];

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const toolHarness = createHarness(cwd);
			assertGenericToolDenial(await toolHarness.tool("bash", { command }), toolHarness.modelLookups);
			const userHarness = createHarness(cwd);
			assertGenericUserBashDenial(await userHarness.userBash(command), userHarness.modelLookups);
		}
	}
});

test("safe grep rg awk and sed data words retain unresolved-expansion exclusions", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-shell-data-expansion-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	const cwd = path.join(fixtureRoot, "project");
	const commands = [
		`grep "$needle" ${path.join(cwd, "input.txt")}`,
		'rg "${needle}" ' + cwd,
		"awk 'BEGIN { print $1 }' " + path.join(cwd, "input.txt"),
		"sed 's|before|after|' " + path.join(cwd, "input.txt"),
	];

	for (const mode of ["off", "balanced"] as const) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const harness = createHarness(cwd);
			const outcome = await harness.tool("bash", { command });
			assert.equal(outcome.result, undefined, `${mode}/${command}`);
			assert.equal(outcome.executed, true, `${mode}/${command}`);
			assert.equal(harness.modelLookups, 0, `${mode}/${command}`);
		}
	}

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const harness = createHarness(cwd);
			const outcome = await harness.userBash(command);
			assert.equal(outcome.result, undefined, `${mode}/${command}`);
			assert.equal(outcome.executed, true, `${mode}/${command}`);
			assert.equal(harness.modelLookups, 0, `${mode}/${command}`);
		}
	}
});

test("awk and sed file-I/O or exec programs cannot hide fake protected paths in any mode", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-interpreter-programs-${process.pid}`);
	const configHome = path.join(fixtureRoot, "config");
	const pinPath = path.join(configHome, "pi", PIN_FILENAME);
	const cwd = path.join(fixtureRoot, "project");
	process.env.XDG_CONFIG_HOME = configHome;

	const commands = [
		{ name: "awk getline", command: `awk 'BEGIN { getline line < "${pinPath}" }'` },
		{ name: "awk system", command: `awk 'BEGIN { system("cat ${pinPath}") }'` },
		{ name: "awk command pipe", command: `awk 'BEGIN { "cat ${pinPath}" | getline line }'` },
		{ name: "awk output redirection", command: `awk 'BEGIN { print "data" > "${pinPath}" }'` },
		{ name: "awk attached source", command: `awk -e'BEGIN { system("cat ${pinPath}") }'` },
		{ name: "sed e command", command: `sed -e 'e cat "${pinPath}"'` },
		{ name: "sed substitution e flag", command: `sed -e 's|placeholder|cat ${pinPath}|e'` },
		{ name: "sed r command", command: `sed 'r ${pinPath}'` },
		{ name: "sed R command", command: `sed 'R ${pinPath}'` },
		{ name: "sed w command", command: `sed 'w ${pinPath}'` },
		{ name: "sed W command", command: `sed 'W ${pinPath}'` },
		{ name: "sed short script file", command: `sed -f "${pinPath}" input.txt` },
		{ name: "sed attached script file", command: `sed -f"${pinPath}" input.txt` },
		{ name: "sed long script file", command: `sed --file="${pinPath}" input.txt` },
	];

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const { name, command } of commands) {
			const toolHarness = createHarness(cwd);
			const toolOutcome = await toolHarness.tool("bash", { command });
			assertGenericToolDenial(toolOutcome, toolHarness.modelLookups);
			assert.equal(toolOutcome.result.reason.includes(PIN_FILENAME), false, `${mode}/${name}/bash leaked protected input`);

			const userHarness = createHarness(cwd);
			const userOutcome = await userHarness.userBash(command);
			assertGenericUserBashDenial(userOutcome, userHarness.modelLookups);
			assert.equal(userOutcome.result.result.output.includes(PIN_FILENAME), false, `${mode}/${name}/user_bash leaked protected input`);
		}
	}
});

test("benign direct awk and sed programs remain data-only controls", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-interpreter-controls-${process.pid}`);
	const configHome = path.join(fixtureRoot, "config");
	const pinPath = path.join(configHome, "pi", PIN_FILENAME);
	const cwd = path.join(fixtureRoot, "project");
	process.env.XDG_CONFIG_HOME = configHome;
	const commands = [
		`awk 'BEGIN { print "${pinPath}" }'`,
		`sed -e 's|placeholder|${pinPath}|'`,
		`sed --expression='s|placeholder|${pinPath}|'`,
	];

	for (const mode of ["off", "balanced"] as const) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const toolHarness = createHarness(cwd);
			const toolOutcome = await toolHarness.tool("bash", { command });
			assert.equal(toolOutcome.result, undefined, `${mode}/${command}`);
			assert.equal(toolOutcome.executed, true, `${mode}/${command}`);
			assert.equal(toolHarness.modelLookups, 0, `${mode}/${command}`);
		}
	}

	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const userHarness = createHarness(cwd);
			const userOutcome = await userHarness.userBash(command);
			assert.equal(userOutcome.result, undefined, `${mode}/${command}`);
			assert.equal(userOutcome.executed, true, `${mode}/${command}`);
			assert.equal(userHarness.modelLookups, 0, `${mode}/${command}`);
		}
	}
});

test("symlink aliases are denied using fake parent metadata without creating or opening a PIN file", async () => {
	const fixtureRoot = mkdtempSync(path.join(tmpdir(), "command-guard-pin-symlink-"));
	try {
		const configHome = path.join(fixtureRoot, "config");
		const pinParent = path.join(configHome, "pi");
		const alias = path.join(fixtureRoot, "identity-config-alias");
		mkdirSync(pinParent, { recursive: true });
		symlinkSync(pinParent, alias, "dir");
		process.env.XDG_CONFIG_HOME = configHome;
		process.env.PI_COMMAND_GUARD_MODE = "off";

		for (const scope of [alias, path.join(alias, PIN_FILENAME), path.join(alias, "*")]) {
			const harness = createHarness(path.join(fixtureRoot, "project"));
			assertGenericToolDenial(await harness.tool("read", { path: scope }), harness.modelLookups);
		}
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

test("raw sudo remains denied through supported command wrappers in every mode", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-wrapped-raw-sudo-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	const cwd = path.join(fixtureRoot, "project");
	const commands = [
		"sudo id",
		"timeout 1 sudo id",
		"setsid sudo id",
		"timeout 1 su\\" + "\n" + "do -n true",
		"exec /usr/bin/sudo -n true",
		"eval 'sudo -n true'",
		"bash -c 'timeout 1 sudo id'",
		"bash -c 'exec /usr/bin/sudo -n true'",
	];
	for (const mode of MODES) {
		process.env.PI_COMMAND_GUARD_MODE = mode;
		for (const command of commands) {
			const harness = createHarness(cwd);
			const outcome = await harness.tool("bash", { command });
			assert.equal(outcome.result?.block, true, `${mode}/${command}`);
			assert.equal(outcome.result?.reason, RAW_SUDO_DENIAL, `${mode}/${command}`);
			assert.equal(outcome.executed, false, `${mode}/${command}`);
			assert.equal(harness.modelLookups, 0, `${mode}/${command}`);
		}
	}
});

test("unrelated calls remain outside the PIN invariant in off mode", async () => {
	const fixtureRoot = path.join(tmpdir(), `command-guard-pin-controls-${process.pid}`);
	process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, "config");
	process.env.PI_COMMAND_GUARD_MODE = "off";
	const cwd = path.join(fixtureRoot, "project");
	const safeInputs: Array<[typeof TOOL_NAMES[number], Record<string, unknown>]> = [
		["bash", { command: "printf ok" }],
		["read", { path: path.join(cwd, "README.md") }],
		["grep", { pattern: "hello", path: cwd }],
		["find", { pattern: "*.ts", path: cwd }],
		["ls", { path: cwd }],
		["write", { path: path.join(cwd, "output.txt"), content: "hello" }],
		["edit", { path: path.join(cwd, "output.txt"), edits: [{ oldText: "hello", newText: "world" }] }],
		["sudo_exec", { executable: "/usr/bin/true", argv: [], cwd }],
	];
	for (const [toolName, input] of safeInputs) {
		const harness = createHarness(cwd);
		const outcome = await harness.tool(toolName, input);
		assert.equal(outcome.result, undefined, toolName);
		assert.equal(outcome.executed, true, toolName);
		assert.equal(harness.modelLookups, 0, toolName);
	}
	const harness = createHarness(cwd);
	const outcome = await harness.userBash("printf ok");
	assert.equal(outcome.result, undefined);
	assert.equal(outcome.executed, true);
});
