# Journal — 2026-05-10: Robust TODO Extension for pi

## What was built

A comprehensive TODO extension for the pi coding harness at `.pi/extensions/todo/index.ts` (1228 lines).

## Motivation

pi's philosophy is "no built-in to-dos" but the harness needed sticky, persistent task tracking that agents could manage — especially in multi-agent team workflows with subagent delegation.

## Architecture

### State model (TypeScript interfaces)

```typescript
interface Todo {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "blocked" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
  dependencies: number[];  // IDs of blocking tasks
  assignee?: string;        // Subagent or role
  notes?: string;
  createdAt: number;
  updatedAt: number;
}
```

### Tool actions (`todo` tool)

| Action | Purpose |
|--------|---------|
| `list` | Show all (optional filter by status/assignee) |
| `add` | Create task with text, priority, assignee, dependencies, notes |
| `update` | Modify any field of existing task by ID |
| `toggle` | Toggle done/undone |
| `batch` | Multiple add/update/toggle/delete operations atomically |
| `clear_done` | Remove completed and cancelled tasks |
| `reorder` | Pass ordered array of IDs |

### State persistence strategy

1. **Primary**: Tool result entries on session branch — `reconstructState()` scans `ctx.sessionManager.getBranch()` for `toolResult` entries of the `todo` tool and replays them in order. This means branching via `/tree` produces the correct todo state at that point in history.

2. **Fallback**: Custom `todo-state` entries appended after each turn via `pi.appendEntry()`. These survive restarts when tool results might get compacted away.

3. **System prompt**: Current TODO list injected into the system prompt before each agent turn, with guidance to use the tool proactively.

### UI components

- **Persistent widget** above the editor — shows up to 8 active tasks, color-coded by status
- **Footer status line** — `📋 2 active · 1 blocked · 3 done`
- **`/todos` command** — interactive `SelectList` with search/filter
- **`/todos-full` command** — full-screen keyboard-driven manager (toggle, block, in-progress, delete with single keys)
- **`/todos-reevaluate` command** — sends current list to the agent asking it to re-evaluate
- **`/todos-toggle-widget` command** — toggle persistent widget on/off

### Custom rendering

- **renderCall**: Shows tool action + key args (add shows text preview, update/toggle shows `#id`, batch shows op count)
- **renderResult**: Collapsed shows summary (`✓ 2 active · 3 pending · 1 done`), expanded shows full task list with color-coded status icons, priority markers, assignee, dependencies, notes

### Sorting

Tasks sorted by status (in_progress → pending → blocked → done → cancelled), then priority (critical → high → medium → low), then creation order.

## Key design decisions

1. **Session-entry-based state** rather than external files — proper branching, no stale state
2. **Double persistence** (tool results + custom entries) — robustness against compaction
3. **Widget + status line** for ambient awareness without opening anything
4. **Single-character keys in `/todos-full`** (space/toggle, i/in-progress, b/block, d/delete) for fast keyboard-driven management
5. **No external dependencies** — pure pi extension API, nothing from npm

## Files changed

| File | Change |
|------|--------|
| `.pi/extensions/todo/index.ts` | Created (1228 lines) |

## Testing

Verified all actions (list, add, update, toggle, batch, clear_done, reorder) via print mode in ephemeral sessions. Extension auto-discovered from project-local `.pi/extensions/todo/` directory.

## Related concepts

- **pi agent-monitor hooks** — previously built journal-reminder system
- **agent-teams extension** — existing subagent orchestration (`.pi/extensions/agent-teams/`)
- **pi subagent example** — reference implementation in pi's examples/extensions/subagent/
