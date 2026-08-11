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
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
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
  /** Explicit display order, present only after a reorder */
  rank?: number;
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

interface TodoPreseedItem {
  text?: unknown;
  status?: unknown;
  priority?: unknown;
  dependencies?: unknown;
  assignee?: unknown;
  notes?: unknown;
}

interface TodoPreseedDetails {
  hook?: unknown;
  trigger?: unknown;
  todos?: unknown;
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

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && value in STATUS_ORDER;
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === "string" && value in PRIORITY_ORDER;
}

export const TODO_LIMITS = Object.freeze({
  maxTodos: 128,
  maxTextBytes: 4096,
  maxNotesBytes: 8192,
  maxAssigneeBytes: 512,
  maxDependencies: 64,
  maxBatchItems: 128,
  maxStateBytes: 40 * 1024,
  maxToolOutputBytes: 47 * 1024,
});

interface TodoSnapshot {
  todos: Todo[];
  nextId: number;
}

interface RestoredTodoSnapshot extends TodoSnapshot {
  entryIndex: number;
}

const utf8 = new TextEncoder();

function byteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

function boundedString(
  value: unknown,
  field: string,
  maxBytes: number,
  options: { optional?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") throw new Error(`todo: '${field}' must be a string`);

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (options.allowEmpty) return "";
    throw new Error(`todo: '${field}' must not be empty`);
  }
  if (byteLength(value) > maxBytes) {
    throw new Error(`todo: '${field}' exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function optionalStoredString(value: unknown, field: string, maxBytes: number): string | undefined {
  // Older snapshots could serialize cleared optionals as null or empty strings.
  // Normalize all absent forms to an omitted property in canonical snapshots.
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  return boundedString(value, field, maxBytes);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`todo: '${field}' must be a positive safe integer`);
  }
  return value;
}

function validateDependencies(value: unknown, field = "dependencies"): number[] {
  if (!Array.isArray(value)) throw new Error(`todo: '${field}' must be an array`);
  if (value.length > TODO_LIMITS.maxDependencies) {
    throw new Error(`todo: '${field}' exceeds ${TODO_LIMITS.maxDependencies} items`);
  }

  const dependencies = value.map((id, index) => positiveInteger(id, `${field}[${index}]`));
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error(`todo: '${field}' must not contain duplicate IDs`);
  }
  return dependencies;
}

function cloneTodo(todo: Todo): Todo {
  return { ...todo, dependencies: [...todo.dependencies] };
}

function cloneSnapshot(snapshot: TodoSnapshot): TodoSnapshot {
  return { todos: snapshot.todos.map(cloneTodo), nextId: snapshot.nextId };
}

function validateTodo(value: unknown, index: number): Todo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`todo: snapshot todo[${index}] must be an object`);
  }

  const raw = value as Record<string, unknown>;
  const id = positiveInteger(raw.id, `todos[${index}].id`);
  const text = boundedString(raw.text, `todos[${index}].text`, TODO_LIMITS.maxTextBytes)!;
  const status = raw.status;
  const priority = raw.priority;
  if (!isTodoStatus(status)) throw new Error(`todo: invalid status in todo #${id}`);
  if (!isTodoPriority(priority)) throw new Error(`todo: invalid priority in todo #${id}`);
  const dependencies = validateDependencies(raw.dependencies, `todos[${index}].dependencies`);
  const assignee = optionalStoredString(raw.assignee, `todos[${index}].assignee`, TODO_LIMITS.maxAssigneeBytes);
  const notes = optionalStoredString(raw.notes, `todos[${index}].notes`, TODO_LIMITS.maxNotesBytes);
  let rank: number | undefined;
  if (raw.rank !== undefined && raw.rank !== null) {
    if (
      typeof raw.rank !== "number" ||
      !Number.isSafeInteger(raw.rank) ||
      raw.rank < 0 ||
      raw.rank >= TODO_LIMITS.maxTodos
    ) {
      throw new Error(`todo: invalid rank in todo #${id}`);
    }
    rank = raw.rank;
  }
  if (typeof raw.createdAt !== "number" || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0) {
    throw new Error(`todo: invalid createdAt in todo #${id}`);
  }
  if (typeof raw.updatedAt !== "number" || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0) {
    throw new Error(`todo: invalid updatedAt in todo #${id}`);
  }

  const todo: Todo = {
    id,
    text,
    status,
    priority,
    dependencies,
    createdAt: raw.createdAt as number,
    updatedAt: raw.updatedAt as number,
  };
  if (assignee !== undefined) todo.assignee = assignee;
  if (notes !== undefined) todo.notes = notes;
  if (rank !== undefined) todo.rank = rank;
  return todo;
}

function validateSnapshot(value: unknown): TodoSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("todo: snapshot must be an object");
  }

  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.todos)) throw new Error("todo: snapshot todos must be an array");
  if (raw.todos.length > TODO_LIMITS.maxTodos) {
    throw new Error(`todo: snapshot exceeds ${TODO_LIMITS.maxTodos} todos`);
  }

  const todos = raw.todos.map(validateTodo);
  const ids = todos.map((todo) => todo.id);
  if (new Set(ids).size !== ids.length) throw new Error("todo: snapshot contains duplicate todo IDs");
  const ranks = todos.flatMap((todo) => (todo.rank === undefined ? [] : [todo.rank]));
  if (new Set(ranks).size !== ranks.length) throw new Error("todo: snapshot contains duplicate todo ranks");

  const maxId = ids.length > 0 ? Math.max(...ids) : 0;
  const derivedNextId = maxId + 1;
  const nextId =
    raw.nextId === undefined || raw.nextId === null
      ? positiveInteger(derivedNextId, "nextId")
      : positiveInteger(raw.nextId, "nextId");
  if (nextId <= maxId) throw new Error("todo: snapshot nextId must be greater than every todo ID");

  const snapshot = { todos, nextId };
  if (byteLength(JSON.stringify(snapshot)) > TODO_LIMITS.maxStateBytes) {
    throw new Error(`todo: snapshot exceeds ${TODO_LIMITS.maxStateBytes} UTF-8 bytes`);
  }
  return cloneSnapshot(snapshot);
}

function snapshotFromEntry(entry: any): TodoSnapshot | undefined {
  if (entry?.type === "message") {
    const message = entry.message;
    if (message?.role !== "toolResult" || message.toolName !== "todo") return undefined;
    return validateSnapshot(message.details);
  }
  if (entry?.type === "custom" && entry.customType === "todo-state") {
    return validateSnapshot(entry.data);
  }
  return undefined;
}

function newestBranchSnapshot(branch: readonly any[]): RestoredTodoSnapshot | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    try {
      const snapshot = snapshotFromEntry(branch[index]);
      if (snapshot) return { ...snapshot, entryIndex: index };
    } catch {
      // Session data is untrusted. Ignore malformed/oversized snapshots and
      // continue toward the newest earlier snapshot that is fully valid.
    }
  }
  return undefined;
}

function capToolText(text: string): string {
  if (byteLength(text) < TODO_LIMITS.maxToolOutputBytes) return text;

  const suffix = "\n\n[TODO output truncated]";
  const budget = TODO_LIMITS.maxToolOutputBytes - byteLength(suffix) - 1;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  let prefix = text.slice(0, low);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

// ── Sorting ─────────────────────────────────────────────────────────────────────

function compareDefaultTodoOrder(a: Todo, b: Todo): number {
  const statusDiff = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
  if (statusDiff !== 0) return statusDiff;
  const priorityDiff = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
  if (priorityDiff !== 0) return priorityDiff;
  return a.id - b.id;
}

function sortTodos(todos: Todo[]): Todo[] {
  const hasExplicitOrder = todos.some((todo) => todo.rank !== undefined);
  return [...todos].sort((a, b) => {
    if (hasExplicitOrder) {
      const rankDiff = (a.rank ?? TODO_LIMITS.maxTodos) - (b.rank ?? TODO_LIMITS.maxTodos);
      if (rankDiff !== 0) return rankDiff;
    }
    // Rankless snapshots preserve the long-standing status/priority/id sort.
    // Unranked tasks added after an explicit reorder use that same fallback.
    return compareDefaultTodoOrder(a, b);
  });
}

// ── Widget ──────────────────────────────────────────────────────────────────────

function renderWidgetLine(todo: Todo, allTodos: readonly Todo[], theme: Theme, width: number): string {
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
        const dep = allTodos.find((t) => t.id === did);
        return dep ? `#${did}(${dep.status})` : `#${did}`;
      })
      .join(", ");
    line += ` ${theme.fg("warning", `[blocked by: ${deps}]`)}`;
  }

  return truncateToWidth(line, width);
}

function updateWidget(ctx: ExtensionContext, todos: readonly Todo[]): void {
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

    return {
      render: (width: number) => {
        if (width <= 0) return [];

        const lines: string[] = [];
        lines.push(
          truncateToWidth(
            theme.fg("borderMuted", "───") + theme.fg("accent", " TODO ") + theme.fg("borderMuted", "─".repeat(width)),
            width,
          ),
        );

        for (const todo of visible) {
          lines.push(renderWidgetLine(todo, todos, theme, width));
        }

        if (more > 0) {
          lines.push(truncateToWidth(theme.fg("dim", `  ... and ${more} more (use /todos to see all)`), width));
        }

        lines.push(truncateToWidth(theme.fg("muted", "  /todos · /todos-reevaluate · /todos-full"), width));
        return lines;
      },
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
  private summaryTodos: Todo[];

  constructor(todoDisplay: { todo: Todo; label: string }[], theme: Theme, onClose: () => void) {
    this.theme = theme;
    this.onClose = onClose;
    this.summaryTodos = todoDisplay.map(({ todo }) => cloneTodo(todo));

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
    const active = this.summaryTodos.filter((t) => t.status !== "cancelled");
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
  private getTodos: () => Todo[];
  private onMutate: () => void;
  private selectedIndex = 0;
  private actionMode: ManagerAction | null = null;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme, getTodos: () => Todo[], onMutate: () => void, onClose: () => void) {
    this.theme = theme;
    this.getTodos = getTodos;
    this.onMutate = onMutate;
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

    const todos = this.getTodos();
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
        this.onMutate();
        this.invalidate();
      }
    } else if (data === "d") {
      this.actionMode = "delete";
      if (list[this.selectedIndex]) {
        const t = list[this.selectedIndex];
        const idx = todos.findIndex((x) => x.id === t.id);
        if (idx >= 0) {
          todos.splice(idx, 1);
          this.onMutate();
        }
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
        this.onMutate();
        this.invalidate();
      }
    } else if (data === "i") {
      // Toggle in_progress
      if (list[this.selectedIndex]) {
        const todo = list[this.selectedIndex];
        todo.status = todo.status === "in_progress" ? "pending" : "in_progress";
        todo.updatedAt = Date.now();
        this.onMutate();
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
    const todos = this.getTodos();
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

function formatTodosForPrompt(exported: readonly Todo[]): string {
  const list = sortTodos([...exported]);
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

const TodoText = Type.String({ minLength: 1, maxLength: TODO_LIMITS.maxTextBytes });
const TodoNotes = Type.String({ maxLength: TODO_LIMITS.maxNotesBytes });
const TodoAssignee = Type.String({ maxLength: TODO_LIMITS.maxAssigneeBytes });
const TodoId = Type.Integer({ minimum: 1 });
const TodoDependencies = Type.Array(TodoId, { maxItems: TODO_LIMITS.maxDependencies });

const BatchItem = Type.Object(
  {
    action: StringEnum(["add", "update", "toggle", "delete"] as const),
    /** For add/update */
    text: Type.Optional(TodoText),
    priority: Type.Optional(TodoPriorityEnum),
    assignee: Type.Optional(TodoAssignee),
    /** For update/toggle/delete */
    id: Type.Optional(TodoId),
    status: Type.Optional(TodoStatusEnum),
  },
  { additionalProperties: false },
);

const TodoParams = Type.Object(
  {
    action: TodoAction,
    /** For list/add/update: status */
    status: Type.Optional(TodoStatusEnum),
    assignee: Type.Optional(TodoAssignee),
    /** For add */
    text: Type.Optional(TodoText),
    priority: Type.Optional(TodoPriorityEnum),
    notes: Type.Optional(TodoNotes),
    dependencies: Type.Optional(TodoDependencies),
    /** For update/toggle/reorder */
    id: Type.Optional(TodoId),
    newStatus: Type.Optional(TodoStatusEnum),
    newPriority: Type.Optional(TodoPriorityEnum),
    newAssignee: Type.Optional(TodoAssignee),
    newText: Type.Optional(TodoText),
    newNotes: Type.Optional(TodoNotes),
    newDependencies: Type.Optional(TodoDependencies),
    /** For reorder: ordered list of IDs */
    order: Type.Optional(
      Type.Array(TodoId, { maxItems: TODO_LIMITS.maxTodos, description: "New ordering as list of IDs" }),
    ),
    /** For batch operations */
    items: Type.Optional(
      Type.Array(BatchItem, {
        minItems: 1,
        maxItems: TODO_LIMITS.maxBatchItems,
        description: "Batch of operations to apply in order",
      }),
    ),
  },
  { additionalProperties: false },
);

// ── Extension ───────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // State is deliberately owned by this factory invocation. Wayang can host
  // multiple Pi sessions in one process, so module-level mutable state would
  // leak todos between independent extension instances.
  let todos: Todo[] = [];
  let nextId = 1;
  let widgetEnabled = true;
  let restoredEntryIndex = -1;

  const commitSnapshot = (snapshot: TodoSnapshot): void => {
    const copy = cloneSnapshot(snapshot);
    todos = copy.todos;
    nextId = copy.nextId;
  };

  const currentSnapshot = (): TodoSnapshot => validateSnapshot({ todos, nextId });

  const reconstructState = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();
    const restored = newestBranchSnapshot(branch);
    if (restored) {
      commitSnapshot(restored);
      restoredEntryIndex = restored.entryIndex;
    } else {
      todos = [];
      nextId = 1;
      restoredEntryIndex = -1;
    }
  };

  const applyChanges = (action: string, message?: string): TodoDetails => {
    todos = sortTodos(todos);
    const snapshot = currentSnapshot();
    return { action, todos: snapshot.todos, nextId: snapshot.nextId, message };
  };

  const finishTodoAction = (action: string, message: string | undefined, ctx?: ExtensionContext): TodoDetails => {
    const details = applyChanges(action, message);
    if (ctx) updateWidget(ctx, todos);
    return details;
  };

  const persistTodoState = (): void => {
    // Canonical persistence sorts through the same rank-aware path used by
    // returns and renderers, and never exposes live arrays to appendEntry.
    const canonical = currentSnapshot();
    canonical.todos = sortTodos(canonical.todos);
    commitSnapshot(canonical);
    pi.appendEntry("todo-state", cloneSnapshot(canonical));
  };

  const applyPreseedEntries = (ctx: ExtensionContext): number => {
    const branch = ctx.sessionManager.getBranch();
    const branchSnapshot = newestBranchSnapshot(branch);
    const preseedStart = (branchSnapshot?.entryIndex ?? restoredEntryIndex) + 1;
    let working = cloneSnapshot({ todos, nextId });
    let added = 0;

    // A snapshot already reflects all earlier preseeds (including deliberate
    // deletion). Only consume current-branch preseeds appended after it.
    for (let index = preseedStart; index < branch.length; index++) {
      const entry = branch[index] as any;
      if (entry?.type !== "custom" || entry.customType !== "todo-preseed") continue;
      const data = entry.data as TodoPreseedDetails | undefined;
      if (!data || !Array.isArray(data.todos)) continue;

      let source: string;
      try {
        source = boundedString(data.hook ?? "hook", "preseed hook", TODO_LIMITS.maxAssigneeBytes)!;
      } catch {
        continue;
      }

      for (const raw of data.todos as TodoPreseedItem[]) {
        try {
          if (working.todos.length >= TODO_LIMITS.maxTodos) break;
          const text = boundedString(raw?.text, "preseed text", TODO_LIMITS.maxTextBytes)!;
          if (working.todos.some((todo) => todo.text === text)) continue;

          const status = raw.status === undefined ? "pending" : raw.status;
          const priority = raw.priority === undefined ? "medium" : raw.priority;
          if (!isTodoStatus(status) || !isTodoPriority(priority)) continue;
          const dependencies = raw.dependencies === undefined ? [] : validateDependencies(raw.dependencies);
          const assignee =
            raw.assignee === undefined
              ? source
              : boundedString(raw.assignee, "preseed assignee", TODO_LIMITS.maxAssigneeBytes)!;
          const notes = optionalStoredString(raw.notes, "preseed notes", TODO_LIMITS.maxNotesBytes);
          const now = Date.now() + added;
          const candidate = cloneSnapshot(working);
          candidate.todos.push({
            id: candidate.nextId++,
            text,
            status,
            priority,
            dependencies,
            assignee,
            notes,
            createdAt: now,
            updatedAt: now,
          });
          working = validateSnapshot(candidate);
          added++;
        } catch {
          // A malformed or over-budget hook item cannot poison session restore.
        }
      }
    }

    if (added > 0) {
      working.todos = sortTodos(working.todos);
      commitSnapshot(working);
    }
    return added;
  };

  const restoreBranch = (ctx: ExtensionContext): void => {
    reconstructState(ctx);
    if (applyPreseedEntries(ctx) > 0) persistTodoState();
    updateWidget(ctx, todos);
  };

  // Restore both when the extension instance starts and whenever /tree changes
  // the active leaf within that same instance.
  pi.on("session_start", async (_event, ctx) => restoreBranch(ctx));
  pi.on("session_tree", async (_event, ctx) => restoreBranch(ctx));

  pi.on("turn_end", () => persistTodoState());

  // ── System prompt injection ───────────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    // Hooks may append preseeds after our session_start handler. Re-check the
    // current branch immediately before constructing the prompt.
    if (applyPreseedEntries(ctx) > 0) {
      persistTodoState();
      updateWidget(ctx, todos);
    }

    const todoSummary = capToolText(formatTodosForPrompt(todos));
    const base = event.systemPrompt ?? "";
    return {
      systemPrompt: `${base}

## Current TODO List

${todoSummary}

Use the \`todo\` tool to manage this list. Keep it updated as you work through tasks.`,
    };
  });

  const executeTodo = async (params: any, ctx: ExtensionContext) => {
    const action = params?.action;
    const knownActions = new Set(["list", "add", "update", "toggle", "batch", "clear_done", "reorder"]);
    if (!knownActions.has(action)) throw new Error(`todo: unknown action '${String(action)}'`);

    const result = (text: string, details: TodoDetails) => ({
      content: [{ type: "text" as const, text: capToolText(text) }],
      details,
    });
    const requireId = (value: unknown, operation: string): number =>
      positiveInteger(value, `${operation} id`);
    const checkedStatus = (value: unknown, field: string): TodoStatus | undefined => {
      if (value === undefined) return undefined;
      if (!isTodoStatus(value)) throw new Error(`todo: '${field}' has an invalid status`);
      return value;
    };
    const checkedPriority = (value: unknown, field: string): TodoPriority | undefined => {
      if (value === undefined) return undefined;
      if (!isTodoPriority(value)) throw new Error(`todo: '${field}' has an invalid priority`);
      return value;
    };

    switch (action) {
      case "list": {
        const status = checkedStatus(params.status, "status");
        const assignee =
          params.assignee === undefined
            ? undefined
            : boundedString(params.assignee, "assignee", TODO_LIMITS.maxAssigneeBytes)!;
        let filtered = todos.map(cloneTodo);
        if (status) filtered = filtered.filter((todo) => todo.status === status);
        if (assignee) filtered = filtered.filter((todo) => todo.assignee === assignee);
        filtered = sortTodos(filtered);
        const text =
          filtered.length === 0
            ? "No todos match the filter."
            : `## TODO List (${filtered.length} items)\n\n${todoToMarkdown(filtered)}\n\n---\nUse \`todo add\` to create tasks, \`todo update\` to modify, \`todo toggle\` to mark done/undone.`;
        return result(text, finishTodoAction("list", undefined, ctx));
      }

      case "add": {
        if (todos.length >= TODO_LIMITS.maxTodos) {
          throw new Error(`todo: cannot exceed ${TODO_LIMITS.maxTodos} todos`);
        }
        const text = boundedString(params.text, "text", TODO_LIMITS.maxTextBytes)!;
        const status = checkedStatus(params.newStatus ?? params.status, "status") ?? "pending";
        const priority = checkedPriority(params.priority, "priority") ?? "medium";
        const dependencies = params.dependencies === undefined ? [] : validateDependencies(params.dependencies);
        const assignee = optionalStoredString(params.assignee, "assignee", TODO_LIMITS.maxAssigneeBytes);
        const notes = optionalStoredString(params.notes, "notes", TODO_LIMITS.maxNotesBytes);
        const now = Date.now();
        const candidate = cloneSnapshot(currentSnapshot());
        const newTodo: Todo = {
          id: candidate.nextId++,
          text,
          status,
          priority,
          dependencies,
          assignee,
          notes,
          createdAt: now,
          updatedAt: now,
        };
        candidate.todos.push(newTodo);
        commitSnapshot(validateSnapshot(candidate));
        return result(
          `✓ Added #${newTodo.id}: ${newTodo.text} [${newTodo.status}] priority=${newTodo.priority}${newTodo.assignee ? ` @${newTodo.assignee}` : ""}`,
          finishTodoAction("add", `Added #${newTodo.id}`, ctx),
        );
      }

      case "update": {
        const id = requireId(params.id, "update");
        const candidate = cloneSnapshot(currentSnapshot());
        const todo = candidate.todos.find((item) => item.id === id);
        if (!todo) throw new Error(`todo: Todo #${id} not found`);
        const changes: string[] = [];

        if (params.newText !== undefined) {
          todo.text = boundedString(params.newText, "newText", TODO_LIMITS.maxTextBytes)!;
          changes.push("text");
        }
        const status = checkedStatus(params.newStatus ?? params.status, "newStatus");
        if (status !== undefined) {
          todo.status = status;
          changes.push(`status→${status}`);
        }
        const priority = checkedPriority(params.newPriority, "newPriority");
        if (priority !== undefined) {
          todo.priority = priority;
          changes.push(`priority→${priority}`);
        }
        if (params.newAssignee !== undefined) {
          const value = boundedString(params.newAssignee, "newAssignee", TODO_LIMITS.maxAssigneeBytes, {
            allowEmpty: true,
          })!;
          todo.assignee = value || undefined;
          changes.push(`assignee→${value || "(unassigned)"}`);
        }
        if (params.newNotes !== undefined) {
          const value = boundedString(params.newNotes, "newNotes", TODO_LIMITS.maxNotesBytes, { allowEmpty: true })!;
          todo.notes = value || undefined;
          changes.push("notes");
        }
        if (params.newDependencies !== undefined) {
          todo.dependencies = validateDependencies(params.newDependencies, "newDependencies");
          changes.push(`deps→[${todo.dependencies.join(",")}]`);
        }
        todo.updatedAt = Date.now();
        commitSnapshot(validateSnapshot(candidate));
        return result(
          `✓ Updated #${todo.id}: ${todo.text}\nChanges: ${changes.join(", ") || "(none)"}`,
          finishTodoAction("update", `Updated #${todo.id}`, ctx),
        );
      }

      case "toggle": {
        const id = requireId(params.id, "toggle");
        const candidate = cloneSnapshot(currentSnapshot());
        const todo = candidate.todos.find((item) => item.id === id);
        if (!todo) throw new Error(`todo: Todo #${id} not found`);
        todo.status = todo.status === "done" ? "pending" : todo.status === "cancelled" ? "pending" : "done";
        todo.updatedAt = Date.now();
        commitSnapshot(validateSnapshot(candidate));
        return result(
          `✓ Todo #${todo.id} marked as ${todo.status}: ${todo.text}`,
          finishTodoAction("toggle", `Toggled #${todo.id}`, ctx),
        );
      }

      case "clear_done": {
        const candidate = cloneSnapshot(currentSnapshot());
        const before = candidate.todos.length;
        candidate.todos = candidate.todos.filter((todo) => todo.status !== "done" && todo.status !== "cancelled");
        const removed = before - candidate.todos.length;
        commitSnapshot(validateSnapshot(candidate));
        return result(
          removed === 0 ? "No completed todos to clear." : `✓ Cleared ${removed} completed/cancelled todos.`,
          finishTodoAction("clear_done", removed > 0 ? `Cleared ${removed}` : undefined, ctx),
        );
      }

      case "reorder": {
        if (!Array.isArray(params.order) || params.order.length === 0) {
          throw new Error("todo: 'order' must be a non-empty array of IDs");
        }
        if (params.order.length > TODO_LIMITS.maxTodos) {
          throw new Error(`todo: 'order' exceeds ${TODO_LIMITS.maxTodos} IDs`);
        }
        const order = params.order.map((id: unknown, index: number) => positiveInteger(id, `order[${index}]`));
        if (new Set(order).size !== order.length) throw new Error("todo: 'order' contains duplicate IDs");
        const missing = order.filter((id: number) => !todos.some((todo) => todo.id === id));
        if (missing.length > 0) throw new Error(`todo: IDs not found: ${missing.join(", ")}`);

        const candidate = cloneSnapshot(currentSnapshot());
        candidate.todos = sortTodos(candidate.todos);
        const orderMap = new Map(order.map((id: number, index: number) => [id, index]));
        candidate.todos.sort((a, b) => {
          const ai = orderMap.get(a.id);
          const bi = orderMap.get(b.id);
          if (ai !== undefined && bi !== undefined) return ai - bi;
          if (ai !== undefined) return -1;
          if (bi !== undefined) return 1;
          return 0;
        });
        const now = Date.now();
        candidate.todos.forEach((todo, rank) => {
          todo.rank = rank;
          todo.updatedAt = now;
        });
        commitSnapshot(validateSnapshot(candidate));
        return result(
          `✓ Reordered ${order.length} todos.`,
          finishTodoAction("reorder", "Reordered", ctx),
        );
      }

      case "batch": {
        if (!Array.isArray(params.items) || params.items.length === 0) {
          throw new Error("todo: 'items' must be a non-empty array");
        }
        if (params.items.length > TODO_LIMITS.maxBatchItems) {
          throw new Error(`todo: 'items' exceeds ${TODO_LIMITS.maxBatchItems} operations`);
        }

        // Stage every operation against a detached snapshot. Any invalid item
        // throws before the live instance state is replaced.
        const candidate = cloneSnapshot(currentSnapshot());
        const results: string[] = [];
        for (let index = 0; index < params.items.length; index++) {
          const item = params.items[index];
          if (!item || typeof item !== "object") throw new Error(`todo: items[${index}] must be an object`);
          switch (item.action) {
            case "add": {
              if (candidate.todos.length >= TODO_LIMITS.maxTodos) {
                throw new Error(`todo: cannot exceed ${TODO_LIMITS.maxTodos} todos`);
              }
              const text = boundedString(item.text, `items[${index}].text`, TODO_LIMITS.maxTextBytes)!;
              const status = checkedStatus(item.status, `items[${index}].status`) ?? "pending";
              const priority = checkedPriority(item.priority, `items[${index}].priority`) ?? "medium";
              const assignee = optionalStoredString(
                item.assignee,
                `items[${index}].assignee`,
                TODO_LIMITS.maxAssigneeBytes,
              );
              const now = Date.now() + index;
              const todo: Todo = {
                id: candidate.nextId++,
                text,
                status,
                priority,
                dependencies: [],
                assignee,
                createdAt: now,
                updatedAt: now,
              };
              candidate.todos.push(todo);
              results.push(`✓ Added #${todo.id}: ${todo.text}`);
              break;
            }
            case "update": {
              const id = requireId(item.id, `items[${index}].update`);
              const todo = candidate.todos.find((entry) => entry.id === id);
              if (!todo) throw new Error(`todo: items[${index}] Todo #${id} not found`);
              if (item.text !== undefined) {
                todo.text = boundedString(item.text, `items[${index}].text`, TODO_LIMITS.maxTextBytes)!;
              }
              const status = checkedStatus(item.status, `items[${index}].status`);
              if (status !== undefined) todo.status = status;
              const priority = checkedPriority(item.priority, `items[${index}].priority`);
              if (priority !== undefined) todo.priority = priority;
              if (item.assignee !== undefined) {
                const value = boundedString(
                  item.assignee,
                  `items[${index}].assignee`,
                  TODO_LIMITS.maxAssigneeBytes,
                  { allowEmpty: true },
                )!;
                todo.assignee = value || undefined;
              }
              todo.updatedAt = Date.now() + index;
              results.push(`✓ Updated #${todo.id}`);
              break;
            }
            case "toggle": {
              const id = requireId(item.id, `items[${index}].toggle`);
              const todo = candidate.todos.find((entry) => entry.id === id);
              if (!todo) throw new Error(`todo: items[${index}] Todo #${id} not found`);
              todo.status = todo.status === "done" ? "pending" : "done";
              todo.updatedAt = Date.now() + index;
              results.push(`✓ Toggled #${todo.id}`);
              break;
            }
            case "delete": {
              const id = requireId(item.id, `items[${index}].delete`);
              const todoIndex = candidate.todos.findIndex((entry) => entry.id === id);
              if (todoIndex < 0) throw new Error(`todo: items[${index}] Todo #${id} not found`);
              const [removed] = candidate.todos.splice(todoIndex, 1);
              results.push(`✓ Deleted #${id}: ${removed.text}`);
              break;
            }
            default:
              throw new Error(`todo: unknown batch action '${String(item.action)}' at items[${index}]`);
          }
          // Bound transient staged state too, not only the final batch result.
          validateSnapshot(candidate);
        }
        commitSnapshot(validateSnapshot(candidate));
        return result(
          `Batch complete (${params.items.length} operations):\n${results.join("\n")}`,
          finishTodoAction("batch", `${params.items.length} operations`, ctx),
        );
      }
    }

    // The known-action guard above makes this unreachable, but retaining an
    // explicit throw keeps the tool result type total under strict checking.
    throw new Error(`todo: unknown action '${String(action)}'`);
  };

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
      `Limits: ${TODO_LIMITS.maxTodos} todos; tool output is truncated below 48 KiB.`,
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

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeTodo(params, ctx);

      // All calls return through the validated implementation above. The
      // legacy switch is unreachable and retained only to keep this focused
      // state-correctness change independent of renderer/TUI source churn.
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
            details: finishTodoAction("list", undefined, ctx),
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
            status: params.newStatus ?? params.status ?? "pending",
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
            details: finishTodoAction("add", `Added #${newTodo.id}`, ctx),
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
          const statusUpdate = params.newStatus ?? params.status;
          if (statusUpdate !== undefined) {
            todo.status = statusUpdate;
            changes.push(`status→${statusUpdate}`);
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
            details: finishTodoAction("update", `Updated #${todo.id}`, ctx),
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
            details: finishTodoAction("toggle", `Toggled #${todo.id}`, ctx),
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
            details: finishTodoAction("clear_done", removed > 0 ? `Cleared ${removed}` : undefined, ctx),
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
            details: finishTodoAction("reorder", "Reordered", ctx),
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
            details: finishTodoAction("batch", `${params.items.length} operations`, ctx),
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

      let mutated = false;
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new TodoManagerComponent(
          theme,
          () => todos,
          () => {
            mutated = true;
          },
          () => {
            // Manager edits do not produce a toolResult, so close is their
            // durability boundary rather than the next eventual agent turn.
            if (mutated) persistTodoState();
            updateWidget(ctx, todos);
            done();
          },
        );
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

      const summary = capToolText(formatTodosForPrompt(todos));
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
        updateWidget(ctx, todos);
        ctx.ui.notify("TODO widget enabled.", "info");
      } else {
        ctx.ui.setWidget("todo", undefined);
        ctx.ui.setStatus("todo", undefined);
        ctx.ui.notify("TODO widget disabled.", "info");
      }
    },
  });
}
