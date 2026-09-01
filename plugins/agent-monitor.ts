/**
 * Agent Monitor Extension
 *
 * A lightweight monitor that watches the main agent's output using a cheap/fast
 * model (default: DeepSeek V4 Flash). At the end of each agent turn, it
 * evaluates whether the work completed is significant enough to warrant
 * journaling, updating memoriki, or other follow-up actions.
 *
 * When triggered, it injects a distinctly-styled custom message into the chat
 * that is clearly delineated as coming from the monitor agent.
 *
 * Configuration (.pi/hooks.json):
 * {
 *   "monitors": [
 *     {
 *       "name": "journal-reminder",
 *       "model": "deepseek/deepseek-v4-flash",
 *       "prompt": "Does this work warrant journaling? Respond JSON: {\"triggered\": bool, \"reason\": \"...\"}",
 *       "message": "Consider journaling this work in ./docs/journals/ and updating memoriki."
 *     }
 *   ]
 * }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, getModel, type AssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

interface MonitorDefinition {
	name: string;
	/** Model spec like "deepseek/deepseek-v4-flash" or "openai/gpt-4o-mini" */
	model: string;
	/** Prompt sent to the monitor model. Should instruct it to output JSON with at least {triggered: boolean, reason: string}. */
	prompt: string;
	/** Message injected when the monitor triggers. Use {reason} as a placeholder. */
	message: string;
	/** Minimum number of assistant messages between monitor evaluations (default 3). */
	minInterval?: number;
	/** Maximum tokens of assistant output to send to the monitor model (default 1500). */
	maxContextTokens?: number;
}

interface MonitorConfig {
	monitors: MonitorDefinition[];
}

interface MonitorState {
	/** How many assistant messages since last evaluation (per monitor) */
	messagesSinceEval: Map<string, number>;
	/** Collected assistant text since last evaluation */
	pendingText: Map<string, string[]>;
}

// ── Config loading ──────────────────────────────────────────────────────────

function loadConfig(cwd: string): MonitorConfig {
	const sources = [
		path.join(process.env.HOME || "~", ".pi/agent/hooks.json"),
		path.join(cwd, ".pi/hooks.json"),
	];

	const monitors: MonitorDefinition[] = [];

	for (const src of sources) {
		try {
			if (fs.existsSync(src)) {
				const raw = fs.readFileSync(src, "utf-8");
				const parsed = JSON.parse(raw);
				const items: MonitorDefinition[] = parsed.monitors ?? [];
				for (const m of items) {
					if (m.name && m.model && m.prompt && m.message) {
						monitors.push(m);
					}
				}
			}
		} catch {
			// Silently skip invalid configs
		}
	}

	return { monitors };
}

// ── Text extraction from assistant messages ─────────────────────────────────

interface TextBlock {
	type: "text";
	text: string;
}

function extractAssistantText(message: AssistantMessage): string {
	if (!message.content || !Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && typeof (block as TextBlock).text === "string") {
			parts.push((block as TextBlock).text);
		}
	}
	return parts.join("\n");
}

// ── Model resolution ────────────────────────────────────────────────────────

function resolveModel(spec: string): { provider: string; modelId: string } | null {
	const parts = spec.split("/");
	// Support both 2-part (provider/modelId) and 3-part (provider/prefix/modelId) specs.
	// 3-part is used for OpenRouter-style routing: openrouter/deepseek/deepseek-v4-flash
	if (parts.length === 2) return { provider: parts[0], modelId: parts[1] };
	if (parts.length === 3) return { provider: parts[0], modelId: parts.slice(1).join("/") };
	return null;
}

// ── Truncate to approximate token count (4 chars ≈ 1 token) ─────────────────

function approxTruncate(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return text.slice(text.length - maxChars);
}

// ── Monitor evaluation ──────────────────────────────────────────────────────

async function evaluateMonitor(
	monitor: MonitorDefinition,
	assistantText: string,
	ctx: ExtensionContext,
): Promise<{ triggered: boolean; reason: string } | null> {
	const resolved = resolveModel(monitor.model);
	if (!resolved) {
		console.error(`[agent-monitor] Invalid model spec: ${monitor.model}`);
		return null;
	}

	const model = getModel(resolved.provider as any, resolved.modelId as any);
	if (!model) {
		console.error(`[agent-monitor] Model not found: ${monitor.model}`);
		return null;
	}

	let auth;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch {
		console.error(`[agent-monitor] Failed to get auth for model: ${monitor.model}`);
		return null;
	}

	if (!auth?.ok || !auth.apiKey) {
		// No API key configured for this model — skip silently
		return null;
	}

	const maxTokens = monitor.maxContextTokens ?? 1500;
	const truncated = approxTruncate(assistantText, maxTokens);

	const systemPrompt =
		"You are a concise monitor agent. Your job is to read coding agent output and determine if significant work was completed. Respond with ONLY a JSON object: {\"triggered\": true|false, \"reason\": \"brief explanation\"}. No other text.";

	try {
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: `${monitor.prompt}\n\n<assistant_output>\n${truncated}\n</assistant_output>` },
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 256,
				temperature: 0,
			},
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		// Parse JSON from response (may have markdown fences)
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;
		const parsed = JSON.parse(jsonMatch[0]);
		if (typeof parsed.triggered !== "boolean") return null;
		return {
			triggered: parsed.triggered,
			reason: typeof parsed.reason === "string" ? parsed.reason : "No reason given",
		};
	} catch (err) {
		// Silently ignore evaluation errors
		return null;
	}
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let config: MonitorConfig = { monitors: [] };
	const state: MonitorState = {
		messagesSinceEval: new Map(),
		pendingText: new Map(),
	};

	// ── Custom message renderer for monitor-triggered messages ───────────
	pi.registerMessageRenderer("agent-monitor", (message, _opts, theme) => {
		const details = (message as any).details as Record<string, unknown> | undefined;
		const monitorName = details?.monitor ?? "monitor";
		const reason = details?.reason ?? "";

		const header = theme.fg("accent", theme.bold(`🜁 Monitor: ${monitorName}`));
		const body = theme.fg("muted", (message as any).content as string);
		const reasonLine = reason
			? "\n" + theme.fg("dim", `   because: ${reason}`)
			: "";

		return new Text(`${header}\n${body}${reasonLine}`, 0, 0);
	});

	// ── Session start — reload config ────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		state.messagesSinceEval.clear();
		state.pendingText.clear();

		if (ctx.hasUI && config.monitors.length > 0) {
			ctx.ui.notify(
				`Agent monitor active (${config.monitors.map((m) => m.name).join(", ")})`,
				"info",
			);
		}
	});

	// ── Collect assistant output after each message ──────────────────────
	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const msg = event.message as AssistantMessage;
		const text = extractAssistantText(msg);
		if (!text.trim()) return;

		for (const monitor of config.monitors) {
			const key = monitor.name;
			const count = (state.messagesSinceEval.get(key) ?? 0) + 1;
			state.messagesSinceEval.set(key, count);

			const texts = state.pendingText.get(key) ?? [];
			texts.push(text);
			state.pendingText.set(key, texts);
		}
	});

	// ── Evaluate monitors when agent finishes its work ───────────────────
	pi.on("agent_end", async (_event, ctx) => {
		if (config.monitors.length === 0) return;

		for (const monitor of config.monitors) {
			const key = monitor.name;
			const count = state.messagesSinceEval.get(key) ?? 0;
			const minInterval = monitor.minInterval ?? 3;

			if (count < minInterval) continue;

			const texts = state.pendingText.get(key) ?? [];
			const combinedText = texts.join("\n---\n");
			if (!combinedText.trim()) continue;

			// Reset tracking for this monitor
			state.messagesSinceEval.set(key, 0);
			state.pendingText.set(key, []);

			// Evaluate asynchronously — don't block the session
			evaluateMonitor(monitor, combinedText, ctx).then((result) => {
				if (!result?.triggered) return;

				const resolvedMessage = monitor.message.replace(/\{reason\}/g, result.reason);

				pi.sendMessage({
					customType: "agent-monitor",
					content: resolvedMessage,
					display: true,
					details: {
						monitor: monitor.name,
						reason: result.reason,
						model: monitor.model,
					},
				});
			}).catch(() => {
				// Silently ignore
			});
		}
	});

	// ── Session shutdown — cleanup ───────────────────────────────────────
	pi.on("session_shutdown", async () => {
		state.messagesSinceEval.clear();
		state.pendingText.clear();
	});

	// ── /monitors command — list configured monitors ─────────────────────
	pi.registerCommand("monitors", {
		description: "List active agent monitors",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			if (config.monitors.length === 0) {
				ctx.ui.notify(
					"No monitors configured. Add monitors to .pi/hooks.json",
					"info",
				);
				return;
			}

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => done(), 8000);
				const lines = config.monitors.map((m) => {
					const name = theme.fg("accent", m.name.padEnd(24));
					const model = theme.fg("dim", m.model.padEnd(28));
					const interval = theme.fg("muted", `min interval: ${m.minInterval ?? 3} msgs`);
					return `  ${name} ${model} ${interval}`;
				});

				return {
					render: (width: number) => {
						const out: string[] = [];
						out.push(theme.fg("accent", theme.bold("🜁 Agent Monitors")));
						out.push(theme.fg("dim", "─".repeat(Math.min(width, 70))));
						out.push("");
						if (lines.length === 0) {
							out.push(theme.fg("dim", "  No monitors configured"));
						} else {
							for (const line of lines) out.push(line);
						}
						out.push("");
						out.push(theme.fg("dim", "  Auto-closes in 8s · Press any key to close"));
						return out;
					},
					handleInput: () => {
						if (timeout) { clearTimeout(timeout); timeout = null; }
						done();
						return true;
					},
					invalidate: () => {},
				};
			});
		},
	});
}
