/**
 * Robust TODO Extension
 *
 * Provides a sticky TODO list that agents can manage via a `todo` tool.
 * Tasks persist in session entries, survive restarts, and work with branching.
 * A persistent widget shows tasks above the editor.
 *
 * Features:
 *   - `todo` tool: list, add, update, toggle, batch, clear_done
 *   - Task fields: id, text, status, priority, dependencies, assignee, timestamps
 *   - Persistent widget (above editor) showing current tasks
 *   - Interactive `/todos` command with keyboard navigation
 *   - `/todos-full` opens a full-screen interactive task manager
 *   - `/todos-reevaluate` asks the agent to re-evaluate and update todos
 *   - State reconstructed from session entries (works with branching)
 *   - Custom rendering for tool calls and results
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Keybindings,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  type SelectItem,
  SelectList,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Types ───────────────────────────────────────────────────────────────────────

type TodoStatus = "pending" | "in_progress" | "done" | "blocked" | "cancelled";
type TodoPriority = "low" | "medium" | "high" | "critical";

interface Todo {
  id: number;
  text: string;
  status: TodoStatus;
  priority: TodoPriority;
  /** IDs of tasks this one depends on */
  dependencies: number[];
  /** Subagent or role assigned to this task */
  assignee?: string;
  /** Optional notes/context */
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

interface TodoDetails {
  action: string;
  todos: Todo[];
  nextId: number;
  error?: string;
  message?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────────

const STATUS_ORDER: Record<TodoStatus, number> = {
  in_progress: 0,
  pending: 1,
  blocked: 2,
  done: 3,
  cancelled: 4,
};

const PRIORITY_ORDER: Record<TodoPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const STATUS_LABELS: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◉",
  done: "✓",
  blocked: "⊘",
  cancelled: "✗",
};

const STATUS_COLORS: Record<TodoStatus, string> = {
  pending: "muted",
  in_progress: "accent",
  done: "success",
  blocked: "warning",
  cancelled: "dim",
};

const PRIORITY_COLORS: Record<TodoPriority, string> = {
  critical: "error",
  high: "warning",
  medium: "accent",
  low: "muted",
};

// ── Sorting ─────────────────────────────────────────────────────────────────────

function sortTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    // Primary: status order
    const statusDiff = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (statusDiff !== 0) return statusDiff;
    // Secondary: priority order
    const prioDiff = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
    if (prioDiff !== 0) return prioDiff;
    // Tertiary: creation order
    return a.id - b.id;
  });
}

// ── Session State ───────────────────────────────────────────────────────────────

let todos: Todo[] = [];
let nextId = 1;

function resetState(): void {
  todos = [];
  nextId = 1;
}

function reconstructState(ctx: ExtensionContext): void {
  resetState();

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

    const details = msg.details as TodoDetails | undefined;
    if (details && details.todos) {
      // The last tool result that has todos reflects the current state
      todos = details.todos.map((t) => ({ ...t }));
      nextId = details.nextId ?? (todos.length > 0 ? Math.max(...todos.map((t) => t.id)) + 1 : 1);
    }
  }
}

function applyChanges(action: string, message?: string): TodoDetails {
  todos = sortTodos(todos);
  return { action, todos: todos.map((t) => ({ ...t })), nextId, message };
}

// ── Widget ──────────────────────────────────────────────────────────────────────

function renderWidgetLine(todo: Todo, theme: Theme, width: number): string {
  const statusIcon = STATUS_LABELS[todo.status];
  const statusColor = STATUS_COLORS[todo.status];
  const prioIcon = todo.priority === "critical" ? "!!" : todo.priority === "high" ? "!" : "";
  const prioColor = PRIORITY_COLORS[todo.priority];

  let line = ` ${theme.fg(statusColor, statusIcon)}`;
  if (prioIcon) line += theme.fg(prioColor, prioIcon);
  line += ` ${theme.fg(statusColor, `#${todo.id}`)} `;

  // Show assignee if present
  if (todo.assignee) {
    line += `[${todo.assignee}] `;
  }

  // Task text (dimmed if done or cancelled)
  const displayText =
    todo.status === "done" || todo.status === "cancelled"
      ? theme.fg("dim", todo.text)
      : theme.fg("text", todo.text);

  line += displayText;

  // Show dependency info if blocked
  if (todo.status === "blocked" && todo.dependencies.length > 0) {
    const deps = todo.dependencies
      .map((did) => {
        const dep = todos.find((t) => t.id === did);
        return dep ? `#${did}(${dep.status})` : `#${did}`;
      })
      .join(", ");
    line += ` ${theme.fg("warning", `[blocked by: ${deps}]`)}`;
  }

  return truncateToWidth(line, width);
}

function updateWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const active = todos.filter((t) => t.status !== "cancelled");
  const pending = active.filter((t) => t.status === "pending" || t.status === "in_progress");
  const done = active.filter((t) => t.status === "done");
  const blocked = active.filter((t) => t.status === "blocked");

  if (active.length === 0) {
    ctx.ui.setWidget("todo", undefined);
    ctx.ui.setStatus("todo", undefined);
    return;
  }

  // Status line
  const parts: string[] = [];
  if (pending.length > 0) parts.push(ctx.ui.theme.fg("accent", `${pending.length} active`));
  if (blocked.length > 0) parts.push(ctx.ui.theme.fg("warning", `${blocked.length} blocked`));
  if (done.length > 0) parts.push(ctx.ui.theme.fg("success", `${done.length} done`));
  ctx.ui.setStatus("todo", ctx.ui.theme.fg("muted", "📋 ") + parts.join(ctx.ui.theme.fg("dim", " · ")));

  // Widget above editor
  ctx.ui.setWidget("todo", (_tui, theme) => {
    const maxWidgetItems = 8;
    const visible = sortTodos(active).slice(0, maxWidgetItems);
    const more = active.length - visible.length;

    const lines: string[] = [];
    lines.push(theme.fg("borderMuted", "───") + theme.fg("accent", " TODO ") + theme.fg("borderMuted", "─".repeat(20)));

    for (const todo of visible) {
      lines.push(renderWidgetLine(todo, theme, 80));
    }

    if (more > 0) {
      lines.push(theme.fg("dim", `  ... and ${more} more (use /todos to see all)`));
    }

    lines.push(theme.fg("muted", "  /todos · /todos-reevaluate · /todos-full"));

    return {
      render: () => lines,
      invalidate: () => {},
    };
  });
}

// ── Interactive Todo List Component ─────────────────────────────────────────────

class TodoListComponent {
  private items: SelectItem[];
  private selectList: SelectList;
  private onClose: () => void;
  private theme: Theme;

  constructor(todoDisplay: { todo: Todo; label: string }[], theme: Theme, onClose: () => void) {
    this.theme = theme;
    this.onClose = onClose;

    this.items = todoDisplay.map((t) => ({
      value: String(t.todo.id),
      label: t.label,
    }));

    const visibleCount = Math.min(this.items.length, 20);
    this.selectList = new SelectList(this.items, visibleCount, {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    this.selectList.onSelect = () => onClose();
    this.selectList.onCancel = () => onClose();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
      return;
    }
    this.selectList.handleInput(data);
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    // Header
    const active = todos.filter((t) => t.status !== "cancelled");
    const done = active.filter((t) => t.status === "done");
    const pending = active.filter((t) => t.status !== "done");
    const header =
      th.fg("borderMuted", "───") +
      th.fg("accent", " Todos ") +
      th.fg("muted", `(${done.length}/${active.length} done, ${pending.length} remaining) `) +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 25)));

    lines.push(truncateToWidth(header, width));

    // Legend
    lines.push(
      truncateToWidth(
        `  ${th.fg("accent", "◉")}=active ${th.fg("muted", "○")}=pending ${th.fg("success", "✓")}=done ${th.fg("warning", "⊘")}=blocked ${th.fg("dim", "✗")}=cancelled`,
        width,
      ),
    );

    // List
    lines.push("");
    const rendered = this.selectList.render(width);
    lines.push(...rendered);

    // Help
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ navigate · esc close · type to search")}`, width));

    return lines;
  }

  invalidate(): void {
    this.selectList.invalidate();
  }
}

// ── Todo Manager Component (full-screen) ────────────────────────────────────────

type ManagerAction = "toggle" | "edit" | "delete" | "assign" | "reorder" | "exit";

class TodoManagerComponent {
  private onClose: () => void;
  private theme: Theme;
  private selectedIndex = 0;
  private actionMode: ManagerAction | null = null;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme, onClose: () => void) {
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (this.actionMode) {
      if (matchesKey(data, "escape")) {
        this.actionMode = null;
        return;
      }
      return;
    }

    const list = sortTodos(todos.filter((t) => t.status !== "cancelled"));

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    } else if (matchesKey(data, "up") && this.selectedIndex > 0) {
      this.selectedIndex--;
      this.invalidate();
    } else if (matchesKey(data, "down") && this.selectedIndex < list.length - 1) {
      this.selectedIndex++;
      this.invalidate();
    } else if (data === " " || data === "t") {
      // Toggle
      if (list[this.selectedIndex]) {
        const todo = list[this.selectedIndex];
        if (todo.status === "done") {
          todo.status = "pending";
        } else {
          todo.status = "done";
        }
        todo.updatedAt = Date.now();
        this.invalidate();
      }
    } else if (data === "d") {
      this.actionMode = "delete";
      if (list[this.selectedIndex]) {
        const t = list[this.selectedIndex];
        const idx = todos.findIndex((x) => x.id === t.id);
        if (idx >= 0) todos.splice(idx, 1);
        this.selectedIndex = Math.min(this.selectedIndex, todos.length - 1);
        this.actionMode = null;
        this.invalidate();
      }
    } else if (data === "b") {
      // Toggle blocked
      if (list[this.selectedIndex]) {
        const todo = list[this.selectedIndex];
        todo.status = todo.status === "blocked" ? "pending" : "blocked";
        todo.updatedAt = Date.now();
        this.invalidate();
      }
    } else if (data === "i") {
      // Toggle in_progress
      if (list[this.selectedIndex]) {
        const todo = list[this.selectedIndex];
        todo.status = todo.status === "in_progress" ? "pending" : "in_progress";
        todo.updatedAt = Date.now();
        this.invalidate();
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const list = sortTodos(todos.filter((t) => t.status !== "cancelled"));

    // Header
    lines.push("");
    const title = th.fg("accent", th.bold(" TODO Manager "));
    const headerStr =
      th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 17)));
    lines.push(truncateToWidth(headerStr, width));

    // Stats
    const done = list.filter((t) => t.status === "done").length;
    const active = list.filter((t) => t.status === "in_progress").length;
    const pending = list.filter((t) => t.status === "pending").length;
    const blocked = list.filter((t) => t.status === "blocked").length;
    const stats = [
      th.fg("accent", `${active} active`),
      th.fg("muted", `${pending} pending`),
      th.fg("success", `${done} done`),
    ];
    if (blocked > 0) stats.push(th.fg("warning", `${blocked} blocked`));
    lines.push(truncateToWidth(`  ${stats.join(th.fg("dim", " · "))}  ${th.fg("dim", `(${list.length} total)`)}`, width));

    lines.push("");

    // Task list
    if (list.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No active todos. Use the todo tool to add tasks.")}`, width));
    } else {
      for (let i = 0; i < list.length; i++) {
        const todo = list[i];
        const isSelected = i === this.selectedIndex;
        const cursor = isSelected ? th.fg("accent", "▶") : " ";
        const statusIcon = STATUS_LABELS[todo.status];
        const statusColor = STATUS_COLORS[todo.status];
        const prioColor = PRIORITY_COLORS[todo.priority];
        const prioLabel = todo.priority === "critical" ? "!!" : todo.priority === "high" ? "!" : "  ";

        let textColor = "text";
        if (todo.status === "done") textColor = "dim";
        else if (todo.status === "cancelled") textColor = "dim";
        else if (isSelected) textColor = "accent";

        let line = ` ${cursor} ${th.fg(statusColor, statusIcon)} ${th.fg(prioColor, prioLabel)} ${th.fg(
          "accent",
          `#${todo.id}`,
        )} `;

        if (isSelected) {
          line += th.fg(textColor, th.bold(todo.text));
        } else {
          line += th.fg(textColor, todo.text);
        }

        if (todo.assignee) {
          line += ` ${th.fg("muted", `[${todo.assignee}]`)}`;
        }

        lines.push(truncateToWidth(line, width));
      }
    }

    lines.push("");

    // Help bar
    const helpKeys = [
      "↑↓ navigate",
      "space/t toggle done",
      "i in-progress",
      "b toggle blocked",
      "d delete",
      "esc close",
    ];
    lines.push(truncateToWidth(`  ${th.fg("dim", helpKeys.join(" · "))}`, width));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function todoToMarkdown(todos: Todo[]): string {
  if (todos.length === 0) return "_No todos_";

  const sorted = sortTodos(todos);
  const lines: string[] = [];

  for (const t of sorted) {
    const icon = STATUS_LABELS[t.status];
    const prio = t.priority === "critical" ? "!!" : t.priority === "high" ? "!" : "";
    const assignee = t.assignee ? ` [@${t.assignee}]` : "";
    const blocked =
      t.status === "blocked" && t.dependencies.length > 0
        ? ` (blocked by: ${t.dependencies.map((d) => `#${d}`).join(", ")})`
        : "";
    const notes = t.notes ? ` — ${t.notes}` : "";

    // Using HTML-like strikethrough via ~~text~~
    const displayText = t.status === "done" ? `~~${t.text}~~` : t.text;

    lines.push(
      `- ${icon} ${prio ? `${prio} ` : ""}**#${t.id}** ${displayText}${assignee}${blocked}${notes}`,
    );
  }

  return lines.join("\n");
}

function formatTodosForPrompt(exported?: Todo[]): string {
  const list = sortTodos(exported ?? todos);
  if (list.length === 0) return "(no active todos)";

  const categories: Record<string, Todo[]> = {
    "In Progress": [],
    Pending: [],
    Blocked: [],
    Done: [],
  };

  for (const t of list) {
    if (t.status === "cancelled") continue;
    if (t.status === "in_progress") categories["In Progress"].push(t);
    else if (t.status === "done") categories["Done"].push(t);
    else if (t.status === "blocked") categories["Blocked"].push(t);
    else categories["Pending"].push(t);
  }

  const sections: string[] = [];
  for (const [label, items] of Object.entries(categories)) {
    if (items.length === 0) continue;
    sections.push(`## ${label}`);
    sections.push(
      ...items.map((t) => {
        const assignee = t.assignee ? ` [@${t.assignee}]` : "";
        const blocked =
          t.status === "blocked" && t.dependencies.length > 0
            ? ` (depends on: ${t.dependencies.map((d) => `#${d}`).join(", ")})`
            : "";
        const notes = t.notes ? ` — ${t.notes}` : "";
        return `- #${t.id} ${t.text}${assignee}${blocked}${notes}`;
      }),
    );
    sections.push("");
  }

  return sections.join("\n");
}

// ── Schema ──────────────────────────────────────────────────────────────────────

const TodoAction = StringEnum(
  ["list", "add", "update", "toggle", "batch", "clear_done", "reorder"] as const,
  { description: "Action to perform" },
);

const TodoPriorityEnum = StringEnum(["low", "medium", "high", "critical"] as const, {
  description: "Task priority",
});

const TodoStatusEnum = StringEnum(["pending", "in_progress", "done", "blocked", "cancelled"] as const, {
  description: "Task status",
});

const AddItem = Type.Object({
  text: Type.String({ description: "Todo text" }),
  priority: Type.Optional(TodoPriorityEnum),
  status: Type.Optional(TodoStatusEnum),
  assignee: Type.Optional(Type.String({ description: "Subagent or role assigned to this task" })),
  dependencies: Type.Optional(
    Type.Array(Type.Number(), { description: "IDs of tasks this depends on" }),
  ),
  notes: Type.Optional(Type.String({ description: "Additional notes/context" })),
});

const UpdateItem = Type.Object({
  id: Type.Number({ description: "ID of the todo to update" }),
  text: Type.Optional(Type.String({ description: "Updated todo text" })),
  status: Type.Optional(TodoStatusEnum),
  priority: Type.Optional(TodoPriorityEnum),
  assignee: Type.Optional(Type.String({ description: "Subagent or role assigned" })),
  dependencies: Type.Optional(
    Type.Array(Type.Number(), { description: "IDs of tasks this depends on" }),
  ),
  notes: Type.Optional(Type.String({ description: "Additional notes" })),
});

const BatchItem = Type.Object({
  action: StringEnum(["add", "update", "toggle", "delete"] as const),
  /** For add */
  text: Type.Optional(Type.String()),
  priority: Type.Optional(TodoPriorityEnum),
  assignee: Type.Optional(Type.String()),
  /** For update/toggle/delete */
  id: Type.Optional(Type.Number()),
  status: Type.Optional(TodoStatusEnum),
});

const TodoParams = Type.Object({
  action: TodoAction,
  /** For list: filter by status */
  status: Type.Optional(TodoStatusEnum),
  assignee: Type.Optional(Type.String({ description: "For add/update: subagent or role" })),
  /** For add */
  text: Type.Optional(Type.String({ description: "Todo text" })),
  priority: Type.Optional(TodoPriorityEnum),
  notes: Type.Optional(Type.String({ description: "Additional notes" })),
  dependencies: Type.Optional(
    Type.Array(Type.Number(), { description: "IDs of tasks this depends on" }),
  ),
  /** For update/toggle/reorder */
  id: Type.Optional(Type.Number({ description: "ID of the todo" })),
  newStatus: Type.Optional(TodoStatusEnum),
  newPriority: Type.Optional(TodoPriorityEnum),
  newAssignee: Type.Optional(Type.String()),
  newText: Type.Optional(Type.String()),
  newNotes: Type.Optional(Type.String()),
  newDependencies: Type.Optional(Type.Array(Type.Number())),
  /** For reorder: ordered list of IDs */
  order: Type.Optional(Type.Array(Type.Number(), { description: "New ordering as list of IDs" })),
  /** For batch operations */
  items: Type.Optional(
    Type.Array(BatchItem, { description: "Batch of operations to apply in order" }),
  ),
});

// ── Extension ───────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let widgetEnabled = true;

  // ── State reconstruction ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Primary: reconstruct from tool result entries on the branch
    reconstructState(ctx);

    // Fallback: if nothing found in tool results, try custom entries
    if (todos.length === 0) {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "todo-state") {
          const data = entry.data as { todos?: Todo[]; nextId?: number } | undefined;
          if (data?.todos) {
            todos = data.todos.map((t) => ({ ...t }));
            nextId = data.nextId ?? (todos.length > 0 ? Math.max(...todos.map((t) => t.id)) + 1 : 1);
          }
        }
      }
    }

    updateWidget(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reconstructState(ctx);
    updateWidget(ctx);
  });

  // ── Persist state after tool calls ────────────────────────────────────────

  pi.on("turn_end", () => {
    // Append a custom entry so state survives restarts independently
    // of tool results alone
    pi.appendEntry("todo-state", {
      todos: todos.map((t) => ({ ...t })),
      nextId,
    });
  });

  // ── System prompt injection ───────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    const todoSummary = formatTodosForPrompt();
    const base = event.systemPrompt ?? "";
    return {
      systemPrompt: `${base}

## Current TODO List

${todoSummary}

Use the \`todo\` tool to manage this list. Keep it updated as you work through tasks.`,
    };
  });

  // ── Register todo tool ────────────────────────────────────────────────────

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: [
      "Manage a persistent TODO list. Tasks survive restarts and branching.",
      "Actions:",
      "  list - Show all (or filter by status/assignee)",
      "  add - Create a new task (text, priority, assignee, dependencies, notes)",
      "  update - Modify an existing task by id",
      "  toggle - Toggle task done/undone",
      "  batch - Perform multiple operations atomically",
      "  clear_done - Remove all completed and cancelled tasks",
      "  reorder - Change task ordering",
      "",
      "Use this tool proactively: before starting work, list todos; during work, mark in-progress;",
      "after completing a step, mark it done; if blocked, mark blocked and note dependencies.",
    ].join("\n"),
    promptSnippet: "Manage persistent TODO list (list, add, update, toggle, batch)",
    promptGuidelines: [
      "Use the todo tool proactively. Before starting work, list todos. Mark tasks as in_progress when working on them, done when completed, blocked when waiting on dependencies.",
      "When assigning tasks to subagents, use the assignee field in the todo tool.",
      "Re-evaluate todos regularly - use todo list to review, then update priorities and statuses as needed.",
    ],
    parameters: TodoParams,

    async execute(_toolCallId, params) {
      switch (params.action) {
        case "list": {
          let filtered = [...todos];
          if (params.status) {
            filtered = filtered.filter((t) => t.status === params.status);
          }
          if (params.assignee) {
            filtered = filtered.filter((t) => t.assignee === params.assignee);
          }
          filtered = sortTodos(filtered);

          const md = todoToMarkdown(filtered);
          return {
            content: [
              {
                type: "text",
                text:
                  filtered.length === 0
                    ? "No todos match the filter."
                    : `## TODO List (${filtered.length} items)\n\n${md}\n\n---\nUse \`todo add\` to create tasks, \`todo update\` to modify, \`todo toggle\` to mark done/undone.`,
              },
            ],
            details: applyChanges("list"),
          };
        }

        case "add": {
          if (!params.text) {
            return {
              content: [{ type: "text", text: "Error: 'text' is required for add action." }],
              details: {
                action: "add",
                todos: todos.map((t) => ({ ...t })),
                nextId,
                error: "text required",
              } as TodoDetails,
            };
          }

          const newTodo: Todo = {
            id: nextId++,
            text: params.text,
            status: params.newStatus ?? "pending",
            priority: params.priority ?? "medium",
            dependencies: params.dependencies ?? [],
            assignee: params.assignee,
            notes: params.notes,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };

          todos.push(newTodo);
          return {
            content: [
              {
                type: "text",
                text: `✓ Added #${newTodo.id}: ${newTodo.text} [${newTodo.status}] priority=${newTodo.priority}${newTodo.assignee ? ` @${newTodo.assignee}` : ""}`,
              },
            ],
            details: applyChanges("add", `Added #${newTodo.id}`),
          };
        }

        case "update": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for update action." }],
              details: { action: "update", todos: todos.map((t) => ({ ...t })), nextId } as TodoDetails,
            };
          }

          const todo = todos.find((t) => t.id === params.id);
          if (!todo) {
            return {
              content: [{ type: "text", text: `Error: Todo #${params.id} not found.` }],
              details: { action: "update", todos: todos.map((t) => ({ ...t })), nextId,
                error: `#${params.id} not found` } as TodoDetails,
            };
          }

          const changes: string[] = [];

          if (params.newText !== undefined) {
            todo.text = params.newText;
            changes.push("text");
          }
          if (params.newStatus !== undefined) {
            todo.status = params.newStatus;
            changes.push(`status→${params.newStatus}`);
          }
          if (params.newPriority !== undefined) {
            todo.priority = params.newPriority;
            changes.push(`priority→${params.newPriority}`);
          }
          if (params.newAssignee !== undefined) {
            todo.assignee = params.newAssignee || undefined;
            changes.push(`assignee→${params.newAssignee || "(unassigned)"}`);
          }
          if (params.newNotes !== undefined) {
            todo.notes = params.newNotes || undefined;
            changes.push("notes");
          }
          if (params.newDependencies !== undefined) {
            todo.dependencies = params.newDependencies;
            changes.push(`deps→[${params.newDependencies.join(",")}]`);
          }

          todo.updatedAt = Date.now();

          return {
            content: [
              {
                type: "text",
                text: `✓ Updated #${todo.id}: ${todo.text}\nChanges: ${changes.join(", ") || "(none)"}`,
              },
            ],
            details: applyChanges("update", `Updated #${todo.id}`),
          };
        }

        case "toggle": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for toggle action." }],
              details: { action: "toggle", todos: todos.map((t) => ({ ...t })), nextId } as TodoDetails,
            };
          }

          const todo = todos.find((t) => t.id === params.id);
          if (!todo) {
            return {
              content: [{ type: "text", text: `Error: Todo #${params.id} not found.` }],
              details: { action: "toggle", todos: todos.map((t) => ({ ...t })), nextId,
                error: `#${params.id} not found` } as TodoDetails,
            };
          }

          // Cycle: pending/in_progress -> done, done -> pending, blocked -> pending, cancelled -> pending
          if (todo.status === "done") {
            todo.status = "pending";
          } else if (todo.status === "cancelled") {
            todo.status = "pending";
          } else {
            todo.status = "done";
          }
          todo.updatedAt = Date.now();

          return {
            content: [
              {
                type: "text",
                text: `✓ Todo #${todo.id} marked as ${todo.status}: ${todo.text}`,
              },
            ],
            details: applyChanges("toggle", `Toggled #${todo.id}`),
          };
        }

        case "clear_done": {
          const before = todos.length;
          todos = todos.filter((t) => t.status !== "done" && t.status !== "cancelled");
          const removed = before - todos.length;

          return {
            content: [
              {
                type: "text",
                text: removed === 0 ? "No completed todos to clear." : `✓ Cleared ${removed} completed/cancelled todos.`,
              },
            ],
            details: applyChanges("clear_done", removed > 0 ? `Cleared ${removed}` : undefined),
          };
        }

        case "reorder": {
          if (!params.order || params.order.length === 0) {
            return {
              content: [{ type: "text", text: "Error: 'order' array of IDs is required for reorder." }],
              details: { action: "reorder", todos: todos.map((t) => ({ ...t })), nextId } as TodoDetails,
            };
          }

          // Verify all IDs exist
          const missing = params.order.filter((id) => !todos.some((t) => t.id === id));
          if (missing.length > 0) {
            return {
              content: [{ type: "text", text: `Error: IDs not found: ${missing.join(", ")}` }],
              details: {
                action: "reorder",
                todos: todos.map((t) => ({ ...t })),
                nextId,
                error: `Missing IDs: ${missing.join(", ")}`,
              } as TodoDetails,
            };
          }

          // Reorder: place specified IDs first in given order, then append any unspecified
          const orderMap = new Map(params.order.map((id, i) => [id, i]));
          todos.sort((a, b) => {
            const ai = orderMap.get(a.id);
            const bi = orderMap.get(b.id);
            if (ai !== undefined && bi !== undefined) return ai - bi;
            if (ai !== undefined) return -1;
            if (bi !== undefined) return 1;
            return a.id - b.id;
          });
          todos.forEach((t) => (t.updatedAt = Date.now()));

          return {
            content: [{ type: "text", text: `✓ Reordered ${params.order.length} todos.` }],
            details: applyChanges("reorder", "Reordered"),
          };
        }

        case "batch": {
          if (!params.items || params.items.length === 0) {
            return {
              content: [{ type: "text", text: "Error: 'items' array is required for batch action." }],
              details: { action: "batch", todos: todos.map((t) => ({ ...t })), nextId } as TodoDetails,
            };
          }

          const results: string[] = [];
          for (const item of params.items) {
            switch (item.action) {
              case "add": {
                if (!item.text) {
                  results.push("✗ add: text required");
                  continue;
                }
                const t: Todo = {
                  id: nextId++,
                  text: item.text,
                  status: item.status ?? "pending",
                  priority: item.priority ?? "medium",
                  dependencies: [],
                  assignee: item.assignee,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                };
                todos.push(t);
                results.push(`✓ Added #${t.id}: ${t.text}`);
                break;
              }
              case "update": {
                if (item.id === undefined) {
                  results.push("✗ update: id required");
                  continue;
                }
                const t = todos.find((x) => x.id === item.id);
                if (!t) {
                  results.push(`✗ update: #${item.id} not found`);
                  continue;
                }
                if (item.text !== undefined) t.text = item.text;
                if (item.status !== undefined) t.status = item.status;
                if (item.priority !== undefined) t.priority = item.priority;
                if (item.assignee !== undefined) t.assignee = item.assignee || undefined;
                t.updatedAt = Date.now();
                results.push(`✓ Updated #${t.id}`);
                break;
              }
              case "toggle": {
                if (item.id === undefined) {
                  results.push("✗ toggle: id required");
                  continue;
                }
                const t = todos.find((x) => x.id === item.id);
                if (!t) {
                  results.push(`✗ toggle: #${item.id} not found`);
                  continue;
                }
                t.status = t.status === "done" ? "pending" : "done";
                t.updatedAt = Date.now();
                results.push(`✓ Toggled #${t.id}`);
                break;
              }
              case "delete": {
                if (item.id === undefined) {
                  results.push("✗ delete: id required");
                  continue;
                }
                const idx = todos.findIndex((x) => x.id === item.id);
                if (idx < 0) {
                  results.push(`✗ delete: #${item.id} not found`);
                  continue;
                }
                const removed = todos.splice(idx, 1)[0];
                results.push(`✓ Deleted #${item.id}: ${removed.text}`);
                break;
              }
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `Batch complete (${params.items.length} operations):\n${results.join("\n")}`,
              },
            ],
            details: applyChanges("batch", `${params.items.length} operations`),
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }],
            details: {
              action: "list",
              todos: todos.map((t) => ({ ...t })),
              nextId,
              error: `unknown action: ${(params as any).action}`,
            } as TodoDetails,
          };
      }
    },

    // ── Custom rendering ──────────────────────────────────────────────────

    renderCall(args, theme) {
      const action = args.action || "list";
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("accent", action);

      if (action === "add" && args.text) {
        text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      } else if (action === "update" && args.id !== undefined) {
        text += ` ${theme.fg("accent", `#${args.id}`)}`;
      } else if (action === "toggle" && args.id !== undefined) {
        text += ` ${theme.fg("accent", `#${args.id}`)}`;
      } else if (action === "batch" && args.items) {
        text += ` ${theme.fg("dim", `(${args.items.length} ops)`)}`;
      } else if (action === "list" && args.status) {
        text += ` ${theme.fg("muted", `status:${args.status}`)}`;
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as TodoDetails | undefined;
      if (!details || details.error) {
        const msg = details?.error || (result.content[0]?.type === "text" ? result.content[0].text : "");
        return new Text(theme.fg(details?.error ? "error" : "muted", msg), 0, 0);
      }

      const displayTodos = details.todos;
      const statusCounts = {
        in_progress: 0,
        pending: 0,
        blocked: 0,
        done: 0,
      };
      for (const t of displayTodos) {
        if (t.status in statusCounts) {
          (statusCounts as any)[t.status]++;
        }
      }

      if (!expanded) {
        // Collapsed: show summary
        const parts: string[] = [];
        if (statusCounts.in_progress > 0)
          parts.push(theme.fg("accent", `${statusCounts.in_progress} active`));
        if (statusCounts.pending > 0)
          parts.push(theme.fg("muted", `${statusCounts.pending} pending`));
        if (statusCounts.blocked > 0)
          parts.push(theme.fg("warning", `${statusCounts.blocked} blocked`));
        if (statusCounts.done > 0)
          parts.push(theme.fg("success", `${statusCounts.done} done`));

        const summary = parts.length > 0 ? parts.join(theme.fg("dim", " · ")) : "no todos";
        let text = theme.fg("success", "✓ ") + summary;
        if (details.message) text += ` ${theme.fg("dim", `(${details.message})`)}`;

        if (displayTodos.length > 0) {
          text += `\n${theme.fg("dim", "(Ctrl+O to expand)")}`;
        }

        return new Text(text, 0, 0);
      }

      // Expanded: show full list
      const container = new Container();

      // Status bar
      const parts: string[] = [];
      if (statusCounts.in_progress > 0) parts.push(theme.fg("accent", `◉ ${statusCounts.in_progress}`));
      if (statusCounts.pending > 0) parts.push(theme.fg("muted", `○ ${statusCounts.pending}`));
      if (statusCounts.blocked > 0) parts.push(theme.fg("warning", `⊘ ${statusCounts.blocked}`));
      if (statusCounts.done > 0) parts.push(theme.fg("success", `✓ ${statusCounts.done}`));
      const statusBar = parts.length > 0 ? parts.join("  ") : "no todos";
      container.addChild(new Text(statusBar, 0, 0));

      if (displayTodos.length === 0) {
        container.addChild(new Text(theme.fg("dim", "No todos yet."), 0, 0));
      } else {
        container.addChild(new Spacer(1));

        const visible = expanded ? displayTodos : sortTodos(displayTodos).slice(0, 10);

        for (const t of visible) {
          const icon = STATUS_LABELS[t.status];
          const sc = STATUS_COLORS[t.status];
          const pc = PRIORITY_COLORS[t.priority];
          const prioLabel = t.priority === "critical" ? "!!" : t.priority === "high" ? "!" : "";
          const tc = t.status === "done" ? "dim" : "text";

          let line = ` ${theme.fg(sc, icon)}`;
          if (prioLabel) line += ` ${theme.fg(pc, prioLabel)}`;
          line += ` ${theme.fg("accent", `#${t.id}`)} ${theme.fg(tc, t.text)}`;

          if (t.assignee) line += theme.fg("muted", ` [${t.assignee}]`);

          if (t.status === "blocked" && t.dependencies.length > 0) {
            line += ` ${theme.fg("warning", `(depends on: ${t.dependencies.map((d) => `#${d}`).join(", ")})`)}`;
          }

          if (t.notes) {
            line += `\n     ${theme.fg("dim", t.notes)}`;
          }

          container.addChild(new Text(line, 0, 0));
        }

        if (!expanded && displayTodos.length > 10) {
          container.addChild(
            new Text(theme.fg("dim", `... and ${displayTodos.length - 10} more (Ctrl+O to expand)`), 0, 0),
          );
        }
      }

      return container;
    },
  });

  // ── Register commands ─────────────────────────────────────────────────────

  pi.registerCommand("todos", {
    description: "Show current TODO list in an interactive view",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        const md = todoToMarkdown(todos);
        ctx.ui.notify(md || "No todos.", "info");
        return;
      }

      const display = sortTodos(todos.filter((t) => t.status !== "cancelled")).map((t) => ({
        todo: t,
        label: `${STATUS_LABELS[t.status]} #${t.id} ${t.text}${t.assignee ? ` [${t.assignee}]` : ""}`,
      }));

      if (display.length === 0) {
        ctx.ui.notify("No active todos. Use the todo tool to add tasks.", "info");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new TodoListComponent(display, theme, () => done());
      });
    },
  });

  pi.registerCommand("todos-full", {
    description: "Open a full-screen interactive TODO manager",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/todos-full requires interactive mode", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new TodoManagerComponent(theme, () => {
          updateWidget(ctx);
          done();
        });
      });
    },
  });

  pi.registerCommand("todos-reevaluate", {
    description: "Ask the agent to re-evaluate and update the TODO list",
    handler: async (_args, ctx) => {
      if (todos.length === 0) {
        ctx.ui.notify("No todos to re-evaluate.", "info");
        return;
      }

      const summary = formatTodosForPrompt();
      pi.sendUserMessage(
        `Please re-evaluate the current TODO list. Review each task's status, priority, and dependencies. Update any that are outdated, mark completed work as done, and adjust priorities as needed.\n\nCurrent TODOs:\n${summary}`,
        {},
      );
      ctx.ui.notify("Re-evaluation queued.", "info");
    },
  });

  pi.registerCommand("todos-toggle-widget", {
    description: "Toggle the persistent TODO widget on/off",
    handler: async (_args, ctx) => {
      widgetEnabled = !widgetEnabled;
      if (widgetEnabled) {
        updateWidget(ctx);
        ctx.ui.notify("TODO widget enabled.", "info");
      } else {
        ctx.ui.setWidget("todo", undefined);
        ctx.ui.setStatus("todo", undefined);
        ctx.ui.notify("TODO widget disabled.", "info");
      }
    },
  });
}
