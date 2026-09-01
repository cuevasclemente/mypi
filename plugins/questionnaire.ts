/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	/** Legacy compatibility field; normalized to true because free text is always available. */
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

type QuestionnaireStatus = "submitted" | "pending" | "cancelled" | "error";

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	/** Explicit bridge outcome; do not infer cancellation from an empty answer list. */
	status: QuestionnaireStatus;
	/** Kept for existing TUI result renderers and consumers. */
	cancelled: boolean;
	requestId?: string;
	submissionId?: string;
	error?: string;
}

interface InterviewRequestMetadata {
	toolName: "questionnaire";
	toolCallId: string;
	piSessionId?: string;
	piSessionFile?: string;
}

type BridgeOutcome =
	| {
		status: "submitted";
		request: { requestId: string };
		submission: { submissionId: string };
		answers?: Answer[];
	}
	| {
		status: "pending" | "cancelled";
		request: { requestId: string };
	};

type WebQuestionnaireContext = {
	cwd: string;
	sessionManager?: {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Deprecated and ignored; free-text entry is always available." })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], status: "error", cancelled: false, error: message },
	};
}

interface BackendBridge {
	/** Durable bridge API: a grace-period expiry returns pending, not cancelled. */
	createRequestWithOutcome(
		sessionId: string,
		questions: Question[],
		options: InterviewRequestMetadata & { timeoutMs?: number },
	): Promise<BridgeOutcome>;
}

function getBridge(): BackendBridge {
	if (!(globalThis as any).__pi_interview_bridge) {
		(globalThis as any).__pi_interview_bridge = {
			createRequestWithOutcome: () => Promise.reject(new Error("No interview backend")),
		};
	}
	return (globalThis as any).__pi_interview_bridge;
}

function mapSessionId(mapName: string, key: string | undefined): string | undefined {
	if (!key) return undefined;
	const map = (globalThis as any)[mapName] as Map<string, string> | undefined;
	return map?.get(key);
}

function sessionIdentity(ctx: WebQuestionnaireContext): { piSessionId?: string; piSessionFile?: string } {
	try {
		return {
			piSessionId: ctx.sessionManager?.getSessionId?.(),
			piSessionFile: ctx.sessionManager?.getSessionFile?.(),
		};
	} catch {
		// Session identity is diagnostic metadata; retain the cwd fallback below.
		return {};
	}
}

function resolveWebSession(ctx: WebQuestionnaireContext): { sessionId?: string; piSessionId?: string; piSessionFile?: string } {
	const { piSessionId, piSessionFile } = sessionIdentity(ctx);
	const sessionId =
		mapSessionId("__pi_interview_pi_sessions", piSessionId) ??
		mapSessionId("__pi_interview_session_files", piSessionFile) ??
		mapSessionId("__pi_interview_cwd_sessions", ctx.cwd);
	return { sessionId, piSessionId, piSessionFile };
}

async function webQuestionnaire(
	questions: Question[],
	toolCallId: string,
	ctx: WebQuestionnaireContext,
): Promise<QuestionnaireResult> {
	const { sessionId, piSessionId, piSessionFile } = resolveWebSession(ctx);
	if (!sessionId) {
		return {
			questions,
			answers: [],
			status: "error",
			cancelled: false,
			error: "Questionnaire bridge has no Wayang session mapping for this pi session.",
		};
	}

	try {
		const outcome = await getBridge().createRequestWithOutcome(sessionId, questions, {
			toolName: "questionnaire",
			toolCallId,
			piSessionId,
			piSessionFile,
			timeoutMs: 120_000,
		});
		const requestId = outcome.request.requestId;
		if (typeof requestId !== "string" || !requestId) {
			throw new Error("Questionnaire bridge returned an outcome without durable request provenance.");
		}
		const submissionId = outcome.status === "submitted" ? outcome.submission?.submissionId : undefined;
		if (outcome.status === "submitted" && (typeof submissionId !== "string" || !submissionId)) {
			throw new Error("Questionnaire bridge returned a submitted outcome without durable submission provenance.");
		}
		const answers = (outcome.status === "submitted" ? outcome.answers ?? [] : []).map((a: any) => ({
			id: a.id,
			value: a.value,
			label: a.label,
			wasCustom: a.wasCustom || false,
			index: a.index,
		}));
		return {
			questions,
			answers,
			status: outcome.status,
			cancelled: outcome.status === "cancelled",
			requestId,
			submissionId,
		};
	} catch (error) {
		return {
			questions,
			answers: [],
			status: "error",
			cancelled: false,
			error: error instanceof Error ? error.message : "Questionnaire bridge request failed.",
		};
	}
}

function formatResult(result: QuestionnaireResult, questions: Question[]) {
	if (result.status === "error") {
		return {
			content: [{ type: "text" as const, text: `Questionnaire bridge error: ${result.error || "request failed"}` }],
			details: result,
		};
	}

	if (result.status === "pending") {
		const request = result.requestId ? ` (request ${result.requestId})` : "";
		return {
			content: [{
				type: "text" as const,
				text: `The questionnaire remains open${request}. Do not treat this as cancelled; a later submission will arrive as a wayang-interview-submission message.`,
			}],
			details: result,
		};
	}

	if (result.cancelled) {
		return {
			content: [{ type: "text" as const, text: "User cancelled the questionnaire" }],
			details: result,
		};
	}

	const answerLines = result.answers.map((a) => {
		const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
		if (a.wasCustom) return `${qLabel}: user wrote: ${a.label}`;
		return `${qLabel}: user selected: ${a.index}. ${a.label}`;
	});
	const provenanceLine = result.requestId && result.submissionId
		? `Questionnaire submitted (request ID ${JSON.stringify(result.requestId)}, submission ID ${JSON.stringify(result.submissionId)}).`
		: undefined;

	return {
		content: [{ type: "text" as const, text: [provenanceLine, ...answerLines].filter(Boolean).join("\n") }],
		details: result,
	};
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: QuestionnaireParams,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				// Retain the field for bridge/schema compatibility, but never disable free text.
				allowOther: true,
			}));

			if (!ctx.hasUI) {
				return formatResult(await webQuestionnaire(questions, toolCallId, ctx), questions);
			}

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				// Editor for "Type something" option
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function orderedAnswers(): Answer[] {
					return questions
						.map((question) => answers.get(question.id))
						.filter((answer): answer is Answer => answer !== undefined);
				}

				function submit(cancelled: boolean) {
					done({
						questions,
						// Navigation can answer questions out of order; preserve question order in results.
						answers: orderedAnswers(),
						status: cancelled ? "cancelled" : "submitted",
						cancelled,
					});
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					return [...q.options, { value: "__other__", label: "Type something.", isOther: true }];
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Select option
					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const q = currentQuestion();
					const opts = currentOptions();

					// Helper to add truncated line
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						add(` ${tabs.join("")}`);
						lines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const color = selected ? "accent" : "text";
							// Mark "Type something" differently when in input mode
							if (isOther && inputMode) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
							} else {
								add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
							}
							if (opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}
					}

					// Content
					if (inputMode && q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						// Show options for reference
						renderOptions();
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter to submit • Esc to cancel"));
					} else if (currentTab === questions.length) {
						add(theme.fg("accent", theme.bold(" Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`);
							}
						}
						lines.push("");
						if (allAnswered()) {
							add(theme.fg("success", " Press Enter to submit"));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							add(theme.fg("warning", ` Unanswered: ${missing}`));
						}
					} else if (q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						const help = isMulti
							? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
							: " ↑↓ navigate • Enter select • Esc cancel";
						add(theme.fg("dim", help));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			return formatResult(result, questions);
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.status === "error") {
				return new Text(theme.fg("error", details.error || "Questionnaire bridge error"), 0, 0);
			}
			if (details.status === "pending") {
				return new Text(theme.fg("warning", "Pending — a later submission will arrive as a Wayang message"), 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
