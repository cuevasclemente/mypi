/**
 * Claude Code (-p) Provider
 *
 * Exposes the user's Claude Code subscription as pi models. Each request
 * spawns `claude -p --output-format json --model <id> ...`, so cost flows
 * through the user's Claude Code subscription rather than an Anthropic API key.
 *
 * Multi-turn note: claude -p has no native message-list input, so the pi
 * conversation is flattened into a single prompt with [USER]/[ASSISTANT]
 * markers. This loses claude's prompt-cache reuse across pi turns — fine for
 * one-shot use, suboptimal for long agentic loops.
 *
 * Same source on narwhal-horn and sceptre.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";

const CLAUDE_BIN = process.env.CLAUDE_CODE_BIN ?? "claude";

type FlatMessages = { systemPrompt: string; prompt: string };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n");
}

function flattenMessages(messages: any[]): FlatMessages {
	const sysParts: string[] = [];
	const turnParts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			const t = textOf(msg.content);
			if (t) sysParts.push(t);
		} else if (msg.role === "user") {
			turnParts.push(`[USER]\n${textOf(msg.content)}`);
		} else if (msg.role === "assistant") {
			turnParts.push(`[ASSISTANT]\n${textOf(msg.content)}`);
		}
		// tool_call / tool_result not supported in this v1 wrapper
	}

	return {
		systemPrompt: sysParts.join("\n\n"),
		prompt: turnParts.join("\n\n"),
	};
}

function streamClaudeCode(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			stream.push({ type: "start", partial: output });

			const { systemPrompt, prompt } = flattenMessages(
				(context as any).messages ?? [],
			);
			const args = [
				"-p",
				"--output-format",
				"json",
				"--model",
				model.id,
			];
			if (systemPrompt) {
				args.push("--append-system-prompt", systemPrompt);
			}
			args.push(prompt || "");

			const child = spawn(CLAUDE_BIN, args, {
				stdio: ["ignore", "pipe", "pipe"],
				signal: options?.signal,
			});

			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (b) => {
				stdout += b.toString();
			});
			child.stderr.on("data", (b) => {
				stderr += b.toString();
			});

			const exitCode: number = await new Promise((resolve, reject) => {
				child.on("exit", (code) => resolve(code ?? 1));
				child.on("error", reject);
			});

			if (exitCode !== 0) {
				throw new Error(
					`claude exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`,
				);
			}

			let parsed: any;
			try {
				parsed = JSON.parse(stdout);
			} catch (e) {
				throw new Error(
					`failed to parse claude output as JSON: ${(e as Error).message}\n${stdout.slice(0, 500)}`,
				);
			}

			if (parsed.is_error) {
				throw new Error(
					`claude returned error: ${parsed.result || parsed.subtype || "unknown"}`,
				);
			}

			const text: string = parsed.result ?? "";

			output.content.push({ type: "text", text: "" });
			stream.push({
				type: "text_start",
				contentIndex: 0,
				partial: output,
			});
			const block = output.content[0] as { type: "text"; text: string };
			block.text = text;
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: text,
				partial: output,
			});
			stream.push({
				type: "text_end",
				contentIndex: 0,
				content: text,
				partial: output,
			});

			if (parsed.usage) {
				output.usage.input = parsed.usage.input_tokens ?? 0;
				output.usage.output = parsed.usage.output_tokens ?? 0;
				output.usage.cacheRead =
					parsed.usage.cache_read_input_tokens ?? 0;
				output.usage.cacheWrite =
					parsed.usage.cache_creation_input_tokens ?? 0;
				output.usage.totalTokens =
					output.usage.input +
					output.usage.output +
					output.usage.cacheRead +
					output.usage.cacheWrite;
			}
			// Cost is tracked by claude itself; report it through to pi if present.
			if (typeof parsed.total_cost_usd === "number") {
				output.usage.cost.total = parsed.total_cost_usd;
			}

			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			(output as any).errorMessage =
				error instanceof Error ? error.message : String(error);
			stream.push({
				type: "error",
				reason: output.stopReason,
				error: output,
			});
			stream.end();
		}
	})();

	return stream;
}

export default function claudeCode(pi: ExtensionAPI) {
	pi.registerProvider("claude-code", {
		name: "Claude Code (-p)",
		api: "claude-code-cli",
		// pi requires baseUrl + apiKey on any provider that defines models;
		// streamSimple ignores both. Placeholders satisfy the schema.
		baseUrl: "local://claude-code",
		apiKey: "no-api-key-claude-code-uses-its-own-auth",
		streamSimple: streamClaudeCode as any,
		models: [
			{
				id: "haiku",
				name: "Claude Haiku (via Claude Code)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
			{
				id: "sonnet",
				name: "Claude Sonnet (via Claude Code)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
			{
				id: "opus",
				name: "Claude Opus (via Claude Code)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
		],
	});
}
