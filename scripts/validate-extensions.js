#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = path.join(root, "plugins");
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const checkInstalled = process.argv.includes("--installed");

const pluginNames = requested.length > 0
	? requested.map((name) => name.replace(/\.ts$/, ""))
	: (await readdir(pluginsDir, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
		.map((entry) => entry.name.slice(0, -3));

function requireCondition(condition, message) {
	if (!condition) throw new Error(message);
}

function validateCommandGuardStructure(source) {
	for (const required of [
		"export function buildPrompt(",
		"export function commandInvokesSudo(",
		"export async function evaluateCommand(",
		"export function protectedPathScopeRequested(",
		"export function protectedShellCommandRequested(",
		"export function protectedToolAccessRequested(",
		"function protectedToolAccessFinding(",
		"pi.on(\"user_bash\"",
		"BROAD_ENVIRONMENT_ACCESS_RE",
		"UNRESOLVED_OPERATIONAL_EXPANSION_DENIAL_REASON",
	]) {
		requireCondition(source.includes(required), `command guard is missing required invariant/helper: ${required}`);
	}

	for (const forbidden of [
		"RECENT_ASSISTANT_MESSAGES",
		"function recentAssistantContext(",
		"<assistant_context",
		"<assistant_dialogue_or_thinking>",
		"<assistant_thinking>",
		'b.type === "thinking"',
	]) {
		requireCondition(!source.includes(forbidden), `assistant context leaked into command-guard authorization path: ${forbidden}`);
	}

	const hookStart = source.indexOf('pi.on("tool_call"');
	const hookEnd = source.indexOf('pi.on("user_bash"', hookStart);
	requireCondition(hookStart >= 0 && hookEnd > hookStart, "command guard tool_call/user_bash hooks are missing or out of order");
	const hook = source.slice(hookStart, hookEnd);
	const protectedFinding = hook.indexOf("protectedToolAccessFinding(event.toolName, event.input, ctx.cwd)");
	const bashBranch = hook.indexOf('event.toolName !== "bash"');
	const rawSudo = hook.indexOf("commandInvokesSudo(command)");
	const mode = hook.indexOf("currentMode()");
	const localAllow = hook.indexOf("isLocallySafeReadOnlyCommand(command)");
	const model = hook.indexOf("evaluateCommand(command, input, ctx)");
	for (const [label, index] of Object.entries({ protectedFinding, bashBranch, rawSudo, mode, localAllow, model })) {
		requireCondition(index >= 0, `command guard tool_call hook is missing ${label}`);
	}
	requireCondition(
		protectedFinding < bashBranch
		&& protectedFinding < rawSudo
		&& protectedFinding < mode
		&& protectedFinding < localAllow
		&& protectedFinding < model
		&& rawSudo < mode
		&& mode < localAllow
		&& localAllow < model,
		"command guard deterministic/model control ordering changed",
	);

	const unavailable = source.indexOf('model: "unavailable"');
	const unavailableBlock = source.indexOf("allow: false", unavailable);
	requireCondition(unavailable >= 0 && unavailableBlock > unavailable, "residual model unavailability must fail closed");
}

for (const name of pluginNames) {
	const entry = path.join(pluginsDir, `${name}.ts`);
	const source = await readFile(entry, "utf8");
	if (name === "command-authorization-monitor") validateCommandGuardStructure(source);

	await build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		write: false,
		logLevel: "silent",
	});
	console.log(`validated ${path.relative(root, entry)}`);
}

if (checkInstalled && pluginNames.includes("command-authorization-monitor")) {
	const sourcePath = path.join(pluginsDir, "command-authorization-monitor.ts");
	const runtimePath = process.env.PI_COMMAND_GUARD_RUNTIME_PATH
		?? path.join(process.env.HOME ?? "", ".pi", "agent", "extensions", "command-authorization-monitor.ts");
	const [source, runtime] = await Promise.all([readFile(sourcePath), readFile(runtimePath)]);
	requireCondition(source.equals(runtime), `installed command guard drift: ${runtimePath} is not byte-identical to canonical source`);
	console.log(`validated installed drift ${runtimePath}`);
}
