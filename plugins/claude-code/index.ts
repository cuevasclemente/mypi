/**
 * Claude Code (-p) Provider
 *
 * Exposes the user's Claude Code subscription as pi models. Each request
 * spawns `claude -p --verbose --output-format stream-json --include-partial-messages --model <id> ...`,
 * so cost flows through the user's Claude Code subscription rather than an
 * Anthropic API key. Output is streamed line-by-line for real-time display.
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
import { createInterface } from "node:readline";

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
				"--verbose",
				"--output-format",
				"stream-json",
				"--include-partial-messages",
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

			const rl = createInterface({
				input: child.stdout,
				crlfDelay: Infinity,
			});

			let stderr = "";
			child.stderr.on("data", (b) => {
				stderr += b.toString();
			});

			// Track content block state across streaming events
			let textContentIndex = -1;
			let thinkingContentIndex = -1;
			let currentTextBlock = "";

			for await (const line of rl) {
				if (!line.trim()) continue;

				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					continue; // skip unparseable lines
				}

				switch (event.type) {
					case "stream_event": {
						const e = event.event;
						if (!e) break;

						switch (e.type) {
							case "message_start": {
								// Capture initial usage info
								if (e.message?.usage) {
									const u = e.message.usage;
									output.usage.input = u.input_tokens ?? 0;
									output.usage.cacheRead =
										u.cache_read_input_tokens ?? 0;
									output.usage.cacheWrite =
										u.cache_creation_input_tokens ?? 0;
								}
								break;
							}

							case "content_block_start": {
								const cb = e.content_block;
								if (!cb) break;

								if (cb.type === "text") {
									textContentIndex = e.index;
									currentTextBlock = "";
									// Push a text placeholder into content array
									output.content.push({
										type: "text",
										text: "",
									});
									stream.push({
										type: "text_start",
										contentIndex: textContentIndex,
										partial: output,
									});
								} else if (cb.type === "thinking") {
									thinkingContentIndex = e.index;
									output.content.push({
										type: "thinking",
										thinking: "",
									});
									stream.push({
										type: "thinking_start",
										contentIndex: thinkingContentIndex,
										partial: output,
									});
								}
								break;
							}

							case "content_block_delta": {
								const d = e.delta;
								if (!d) break;

								if (
									d.type === "text_delta" &&
									textContentIndex >= 0
								) {
									currentTextBlock += d.text;
									const txtBlock = output.content[
										textContentIndex
									] as { type: "text"; text: string };
									if (txtBlock) {
										txtBlock.text += d.text;
									}
									stream.push({
										type: "text_delta",
										contentIndex: textContentIndex,
										delta: d.text,
										partial: output,
									});
								} else if (
									d.type === "thinking_delta" &&
									thinkingContentIndex >= 0
								) {
									const thinkBlock = output.content[
										thinkingContentIndex
									] as {
										type: "thinking";
										thinking: string;
									};
									if (thinkBlock) {
										thinkBlock.thinking += d.thinking;
									}
									stream.push({
										type: "thinking_delta",
										contentIndex: thinkingContentIndex,
										delta: d.thinking,
										partial: output,
									});
								} else if (
									d.type === "signature_delta" &&
									thinkingContentIndex >= 0
								) {
									// Accumulate thinking signature
									const thinkBlock = output.content[
										thinkingContentIndex
									] as any;
									if (thinkBlock) {
										thinkBlock.thinkingSignature =
											(thinkBlock.thinkingSignature ??
												"") + d.signature;
									}
								}
								break;
							}

							case "content_block_stop": {
								const idx = e.index;
								if (idx === textContentIndex) {
									stream.push({
										type: "text_end",
										contentIndex: textContentIndex,
										content: currentTextBlock,
										partial: output,
									});
									textContentIndex = -1;
								} else if (idx === thinkingContentIndex) {
									const thinkBlock = output.content[
										thinkingContentIndex
									] as {
										type: "thinking";
										thinking: string;
									};
									stream.push({
										type: "thinking_end",
										contentIndex: thinkingContentIndex,
										content: thinkBlock?.thinking ?? "",
										partial: output,
									});
									thinkingContentIndex = -1;
								}
								break;
							}

							case "message_delta": {
								// Final usage
								if (e.usage) {
									output.usage.input =
										e.usage.input_tokens ?? 0;
									output.usage.output =
										e.usage.output_tokens ?? 0;
									output.usage.cacheRead =
										e.usage.cache_read_input_tokens ?? 0;
									output.usage.cacheWrite =
										e.usage.cache_creation_input_tokens ??
										0;
									output.usage.totalTokens =
										output.usage.input +
										output.usage.output +
										output.usage.cacheRead +
										output.usage.cacheWrite;
								}
								break;
							}
						}
						break;
					}

					case "result": {
						// Final result — capture usage and cost
						if (event.usage) {
							output.usage.input =
								event.usage.input_tokens ?? 0;
							output.usage.output =
								event.usage.output_tokens ?? 0;
							output.usage.cacheRead =
								event.usage.cache_read_input_tokens ?? 0;
							output.usage.cacheWrite =
								event.usage.cache_creation_input_tokens ??
								0;
							output.usage.totalTokens =
								output.usage.input +
								output.usage.output +
								output.usage.cacheRead +
								output.usage.cacheWrite;
						}
						if (typeof event.total_cost_usd === "number") {
							output.usage.cost.total =
								event.total_cost_usd;
						}

						if (event.is_error) {
							throw new Error(
								`claude returned error: ${event.result || event.subtype || "unknown"}`,
							);
						}
						break;
					}
				}
			}

			// Wait for process to exit and check exit code
			const exitCode: number = await new Promise((resolve, reject) => {
				child.on("exit", (code) => resolve(code ?? 1));
				child.on("error", reject);
			});

			if (exitCode !== 0) {
				throw new Error(
					`claude exited ${exitCode}: ${stderr.trim() || "(no stderr)"}`,
				);
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
				maxTokens: 64000,
			},
			{
				id: "sonnet",
				name: "Claude Sonnet (via Claude Code)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "opus",
				name: "Claude Opus (via Claude Code)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
		],
	});
}
