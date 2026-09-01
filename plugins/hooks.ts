/**
 * Hooks Extension — Reminders injected at specific lifecycle points.
 *
 * Hooks are defined in .pi/hooks.json (project) or ~/.pi/agent/hooks.json (global).
 * Each hook has a `trigger` (lifecycle point), an optional `message`, optional `todos`, and optional conditions.
 *
 * Trigger points:
 *   session_start    — inject a message once when a session starts (any reason)
 *   new_session      — inject only for brand-new sessions (not resume/fork/reload)
 *   every_turn       — inject reminder text into the system prompt every turn
 *   every_n_turns    — inject every N turns (configured via `every` field)
 *   after_tool       — inject on the next turn after a specific tool runs
 *   on_command       — inject when user input matches a prefix or pattern
 *
 * Hook config example (.pi/hooks.json):
 * {
 *   "hooks": [
 *     { "name": "venv", "trigger": "session_start", "message": "Always activate venv first." },
 *     { "name": "test", "trigger": "every_n_turns", "every": 5, "message": "Have you run the tests?" },
 *     { "name": "concise", "trigger": "every_turn", "message": "Keep responses concise." },
 *     { "name": "session-end", "trigger": "session_start", "todos": [{ "text": "Journal at session end" }] }
 *   ]
 * }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

interface HookTodoSeed {
	text: string;
	priority?: "low" | "medium" | "high" | "critical";
	status?: "pending" | "in_progress" | "done" | "blocked" | "cancelled";
	assignee?: string;
	notes?: string;
}

interface HookDefinition {
	name: string;
	trigger: "session_start" | "new_session" | "every_turn" | "every_n_turns" | "after_tool" | "on_command";
	/** Optional reminder text to inject/display when the hook fires. */
	message?: string;
	/** Optional TODOs to preseed via the todo extension when the hook fires. */
	todos?: HookTodoSeed[];
	/** For every_n_turns: fire every N turns (default 5) */
	every?: number;
	/** For after_tool: tool name(s) that trigger this hook */
	tools?: string | string[];
	/** For on_command: regex pattern or literal prefix to match user input */
	match?: string;
	/** If true, match is treated as a regex */
	regex?: boolean;
	/** If true, only inject once (for on_command, resets on session restart) */
	once?: boolean;
}

interface HooksConfig {
	hooks: HookDefinition[];
}

// ── State ───────────────────────────────────────────────────────────────────

interface HookState {
	turnCount: number;
	toolsThisTurn: string[];
	toolUsage: Record<string, number>;
	firedOnce: Set<string>;
	turnOffsets: Map<string, number>;
}

// ── Config loading ──────────────────────────────────────────────────────────

function loadConfig(cwd: string): HooksConfig {
	const sources = [
		path.join(process.env.HOME || "~", ".pi/agent/hooks.json"),
		path.join(cwd, ".pi/hooks.json"),
	];

	const merged: HookDefinition[] = [];

	for (const src of sources) {
		try {
			if (fs.existsSync(src)) {
				const raw = fs.readFileSync(src, "utf-8");
				const parsed = JSON.parse(raw);
				const hooks: HookDefinition[] = Array.isArray(parsed) ? parsed : parsed.hooks ?? [];
				for (const h of hooks) merged.push(h);
			}
		} catch {
			// Silently skip invalid configs
		}
	}

	return { hooks: merged };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hookId(hook: HookDefinition): string {
	return `${hook.trigger}:${hook.name}`;
}

function matchesInput(hook: HookDefinition, text: string): boolean {
	if (!hook.match) return false;
	if (hook.regex) {
		try {
			return new RegExp(hook.match, "i").test(text);
		} catch {
			return false;
		}
	}
	return text.toLowerCase().includes(hook.match.toLowerCase());
}

function formatHookReminder(hook: HookDefinition): string | undefined {
	if (!hook.message) return undefined;
	return `\n[Hook: ${hook.name}] ${hook.message}`;
}

function preseedTodos(pi: ExtensionAPI, hook: HookDefinition): void {
	const todos = hook.todos?.filter((todo) => typeof todo.text === "string" && todo.text.trim().length > 0);
	if (!todos || todos.length === 0) return;
	pi.appendEntry("todo-preseed", {
		hook: hook.name,
		trigger: hook.trigger,
		todos: todos.map((todo) => ({ ...todo, text: todo.text.trim() })),
	});
}

function sendHookMessage(pi: ExtensionAPI, hook: HookDefinition): void {
	if (!hook.message) return;
	pi.sendMessage({
		customType: "hook",
		content: hook.message,
		display: true,
		details: { hook: hook.name, trigger: hook.trigger },
	});
}

function fireSessionHook(pi: ExtensionAPI, hook: HookDefinition): void {
	preseedTodos(pi, hook);
	sendHookMessage(pi, hook);
}

function hookSummary(hook: HookDefinition): string {
	if (hook.message) return hook.message;
	const count = hook.todos?.length ?? 0;
	if (count > 0) return `Preseed ${count} TODO${count === 1 ? "" : "s"}`;
	return "(no action)";
}

function stashTurns(turnOffsets: Map<string, number>): [string, number][] {
	return [...turnOffsets];
}

function loadTurns(raw: unknown): Map<string, number> {
	const m = new Map<string, number>();
	if (Array.isArray(raw)) {
		for (const [k, v] of raw as [string, number][]) {
			if (typeof v === "number") m.set(k, v);
		}
	}
	return m;
}

function stashSet(s: Set<string>): string[] {
	return [...s];
}

function loadSet(raw: unknown): Set<string> {
	return new Set(Array.isArray(raw) ? (raw as string[]) : []);
}

function stashUsage(u: Record<string, number>): Record<string, number> {
	return { ...u };
}

function loadUsage(raw: unknown): Record<string, number> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof v === "number") out[k] = v;
		}
		return out;
	}
	return {};
}

function createInitialState(): HookState {
	return {
		turnCount: 0,
		toolsThisTurn: [],
		toolUsage: {},
		firedOnce: new Set(),
		turnOffsets: new Map(),
	};
}

// ── State persistence via session entries ───────────────────────────────────

function persistState(pi: ExtensionAPI, state: HookState): void {
	pi.appendEntry("hooks-state", {
		turnCount: state.turnCount,
		toolUsage: stashUsage(state.toolUsage),
		firedOnce: stashSet(state.firedOnce),
		turnOffsets: stashTurns(state.turnOffsets),
	});
}

function restoreState(ctx: ExtensionContext): HookState {
	const state = createInitialState();

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && (entry as any).customType === "hooks-state" && (entry as any).data) {
			const d = (entry as any).data as Record<string, unknown>;
			if (typeof d.turnCount === "number") state.turnCount = d.turnCount;
			state.toolUsage = loadUsage(d.toolUsage);
			state.firedOnce = loadSet(d.firedOnce);
			state.turnOffsets = loadTurns(d.turnOffsets);
		}
	}

	return state;
}

// ── Reminder collection ─────────────────────────────────────────────────────

function collectTurnReminders(
	config: HooksConfig,
	state: HookState,
	userInput?: string,
): string[] {
	const reminders: string[] = [];

	for (const hook of config.hooks) {
		switch (hook.trigger) {
			case "every_turn": {
				const reminder = formatHookReminder(hook);
				if (reminder) reminders.push(reminder);
				break;
			}

			case "every_n_turns": {
				const every = hook.every ?? 5;
				const id = hookId(hook);
				const offset = state.turnOffsets.get(id) ?? 0;
				if ((state.turnCount - offset) % every === 0 && state.turnCount > 0) {
					const reminder = formatHookReminder(hook);
					if (reminder) reminders.push(reminder);
				}
				break;
			}

			case "after_tool": {
				const tools = typeof hook.tools === "string" ? [hook.tools] : hook.tools ?? [];
				const matched = state.toolsThisTurn.some((t) =>
					tools.some((target) => t === target || t.startsWith(target)),
				);
				if (matched) {
					const reminder = formatHookReminder(hook);
					if (reminder) reminders.push(reminder);
				}
				break;
			}

			case "on_command": {
				if (!userInput) break;
				if (hook.once && state.firedOnce.has(hookId(hook))) break;
				if (matchesInput(hook, userInput)) {
					if (hook.once) state.firedOnce.add(hookId(hook));
					const reminder = formatHookReminder(hook);
					if (reminder) reminders.push(reminder);
				}
				break;
			}

			case "session_start":
			case "new_session":
				// Handled separately via message injection
				break;
		}
	}

	return reminders;
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let config: HooksConfig = { hooks: [] };
	let state: HookState = createInitialState();

	const reloadConfig = (cwd: string) => {
		config = loadConfig(cwd);
	};

	// ── Custom message renderer for hook messages in the chat ───────────
	pi.registerMessageRenderer("hook", (message, _opts, theme) => {
		const details = (message as any).details as Record<string, unknown> | undefined;
		const hookName = details?.hook ?? "hook";
		const text =
			theme.fg("accent", theme.bold(`🔔 ${hookName}`)) +
			" " +
			theme.fg("muted", (message as any).content as string);
		return new Text(text, 0, 0);
	});

	// ── Session start ───────────────────────────────────────────────────
	pi.on("session_start", async (event, ctx) => {
		reloadConfig(ctx.cwd);
		state = restoreState(ctx);

		if (ctx.hasUI && config.hooks.length > 0) {
			ctx.ui.notify(`Loaded ${config.hooks.length} hook(s)`, "info");
		}

		// Fire session_start / new_session hooks. Hooks may display messages and/or preseed TODOs.
		for (const hook of config.hooks) {
			if (hook.trigger === "session_start") {
				fireSessionHook(pi, hook);
			}
			if (hook.trigger === "new_session" && event.reason === "new") {
				fireSessionHook(pi, hook);
			}
		}
	});

	// ── Before agent start — inject turn-level reminders into system prompt ─
	pi.on("before_agent_start", async (event, _ctx) => {
		state.turnCount++;

		const reminders = collectTurnReminders(config, state, event.prompt);

		// Reset per-turn tool tracking for next after_tool evaluation
		state.toolsThisTurn = [];

		persistState(pi, state);

		if (reminders.length === 0) return undefined;

		const hookBlock = `\n\n## Active Reminders\n${reminders.join("\n")}`;
		const updatedPrompt = `${event.systemPrompt}${hookBlock}`;

		return { systemPrompt: updatedPrompt };
	});

	// ── Track tool usage for after_tool hooks ───────────────────────────
	pi.on("tool_call", async (event, _ctx) => {
		state.toolsThisTurn.push(event.toolName);
		state.toolUsage[event.toolName] = (state.toolUsage[event.toolName] ?? 0) + 1;
		return undefined;
	});

	// ── Session shutdown — no-op (state is in session entries) ──────────
	pi.on("session_shutdown", async () => {
		// In-memory state discarded; restored from session entries on next start
	});

	// ── /hooks command — list active hooks ──────────────────────────────
	pi.registerCommand("hooks", {
		description: "List active hooks",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			if (config.hooks.length === 0) {
				ctx.ui.notify("No hooks configured. Add hooks to .pi/hooks.json", "info");
				return;
			}

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => done(), 8000);

				const lines = config.hooks.map((h) => {
					const trig = theme.fg("accent", h.trigger.padEnd(18));
					const name = theme.fg("text", h.name.padEnd(24));
					const summary = hookSummary(h);
					const msg =
						summary.length > 60
							? theme.fg("muted", summary.slice(0, 57) + "...")
							: theme.fg("muted", summary);
					return `  ${trig} ${name} ${msg}`;
				});

				return {
					render: (width: number) => {
						const out: string[] = [];
						out.push(theme.fg("accent", theme.bold(`▎ Hooks (${config.hooks.length}) `)));
						out.push(theme.fg("dim", "─".repeat(Math.min(width, 70))));
						out.push("");
						for (const line of lines) out.push(line);
						out.push("");
						out.push(theme.fg("dim", "  Auto-closes in 8s · Press any key to close"));
						return out;
					},
					handleInput: () => {
						if (timeout) {
							clearTimeout(timeout);
							timeout = null;
						}
						done();
						return true;
					},
					invalidate: () => {},
				};
			});
		},
	});

	// ── /hooks-reload command ───────────────────────────────────────────
	pi.registerCommand("hooks-reload", {
		description: "Reload hooks from config files",
		handler: async (_args, ctx) => {
			reloadConfig(ctx.cwd);
			ctx.ui.notify(`Reloaded ${config.hooks.length} hook(s)`, "info");
		},
	});
}
