/**
 * Interview Tool — Ask the user one or more questions and get structured answers.
 *
 * Based on pi's questionnaire.ts example, extended with:
 * - TUI mode: tab-based question navigation via ctx.ui.custom()
 * - Web/SDK mode: event bridge via globalThis.__pi_interview for WebSocket relay
 *
 * The LLM calls this tool to clarify requirements, get preferences,
 * or confirm decisions when working on features.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  allowOther: boolean;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface InterviewResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Global interview bridge (for web/SDK mode without TUI)
// ---------------------------------------------------------------------------

/**
 * Interface for the bridge singleton that the backend (pi-bridge.ts / ws.ts)
 * stores on globalThis. The extension calls getBridge() to access it.
 */
interface BackendBridge {
  createRequest(
    sessionId: string,
    questions: any[],
    timeoutMs?: number,
  ): Promise<any[]>;
}

function getBridge(): BackendBridge {
  if (!(globalThis as any).__pi_interview_bridge) {
    // Create a minimal fallback that rejects — used if backend isn't loaded
    (globalThis as any).__pi_interview_bridge = {
      createRequest: () => Promise.reject(new Error("No interview backend")),
    };
  }
  return (globalThis as any).__pi_interview_bridge;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({ description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)" }),
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
  allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const InterviewParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string, questions: Question[] = []): {
  content: { type: "text"; text: string }[];
  details: InterviewResult;
} {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

function normalizeParams(rawQuestions: any[]): Question[] {
  return rawQuestions.map((q: any, i: number) => ({
    id: q.id || `q${i}`,
    label: q.label || `Q${i + 1}`,
    prompt: q.prompt || q.question || "",
    options: Array.isArray(q.options) ? q.options : [],
    allowOther: q.allowOther !== false,
  }));
}

// ---------------------------------------------------------------------------
// TUI mode — full interactive terminal UI via ctx.ui.custom()
// ---------------------------------------------------------------------------

async function tuiInterview(
  questions: Question[],
  ctx: NonNullable<Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4]>,
): Promise<InterviewResult> {
  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1; // questions + Submit tab

  const result = await ctx.ui.custom<InterviewResult>((tui, theme, _kb, done) => {
    let currentTab = 0;
    let optionIndex = 0;
    let inputMode = false;
    let inputQuestionId: string | null = null;
    let cachedLines: string[] | undefined;
    const answers = new Map<string, Answer>();

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

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit(cancelled: boolean) {
      done({ questions, answers: Array.from(answers.values()), cancelled });
    }

    function currentQuestion(): Question | undefined {
      return questions[currentTab];
    }

    function currentOptions(): RenderOption[] {
      const q = currentQuestion();
      if (!q) return [];
      const opts: RenderOption[] = [...q.options];
      if (q.allowOther) {
        opts.push({ value: "__other__", label: "Type something.", isOther: true });
      }
      return opts;
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

      if (currentTab === questions.length) {
        if (matchesKey(data, Key.enter) && allAnswered()) {
          submit(false);
        } else if (matchesKey(data, Key.escape)) {
          submit(true);
        }
        return;
      }

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

      if (matchesKey(data, Key.escape)) {
        submit(true);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const q = currentQuestion();
      const opts = currentOptions();

      const add = (s: string) => lines.push(truncateToWidth(s, width));

      add(theme.fg("accent", "─".repeat(width)));

      // Tab bar
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

      function renderOptions() {
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const selected = i === optionIndex;
          const isOther = opt.isOther === true;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const color = selected ? "accent" : "text";
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

      if (inputMode && q) {
        add(theme.fg("text", ` ${q.prompt}`));
        lines.push("");
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

    return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Web/SDK mode — event bridge for WebSocket relay
// ---------------------------------------------------------------------------

async function webInterview(questions: Question[], cwd: string): Promise<InterviewResult> {
  try {
    const bridge = getBridge();
    const cwdMap = (globalThis as any).__pi_interview_cwd_sessions as Map<string, string> | undefined;
    const sessionId = (cwdMap && cwd) ? cwdMap.get(cwd) : undefined;
    if (!sessionId) {
      return { questions, answers: [], cancelled: true };
    }
    const answers = await bridge.createRequest(sessionId, questions, 120_000);
    return {
      questions,
      answers: answers.map((a: any) => ({
        id: a.id,
        value: a.value,
        label: a.label,
        wasCustom: a.wasCustom || false,
        index: a.index,
      })),
      cancelled: answers.length === 0,
    };
  } catch {
    return { questions, answers: [], cancelled: true };
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

export default function interview(pi: ExtensionAPI) {
  pi.registerTool({
    name: "interview",
    label: "Interview",
    description:
      "Ask the user one or more questions with navigation between them. Use when clarifying requirements, getting preferences, or confirming decisions on new features. Questions can be multiple-choice (select from options) or free-text (allowOther).",
    parameters: InterviewParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      const questions = normalizeParams(params.questions);

      // TUI mode
      if (ctx.hasUI) {
        const result = await tuiInterview(questions, ctx as any);
        return formatResult(result);
      }

      // Web/SDK mode
      const result = await webInterview(questions, ctx.cwd);
      return formatResult(result);
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("interview "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as InterviewResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
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

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatResult(result: InterviewResult): {
  content: { type: "text"; text: string }[];
  details: InterviewResult;
} {
  if (result.cancelled) {
    return {
      content: [{ type: "text", text: "User cancelled the interview" }],
      details: result,
    };
  }

  const answerLines = result.answers.map((a) => {
    const qLabel = result.questions.find((q) => q.id === a.id)?.label || a.id;
    if (a.wasCustom) {
      return `${qLabel}: user wrote: ${a.label}`;
    }
    return `${qLabel}: user selected: ${a.index}. ${a.label}`;
  });

  return {
    content: [{ type: "text", text: answerLines.join("\n") }],
    details: result,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { getBridge };
export type { Question, Answer, InterviewResult };
