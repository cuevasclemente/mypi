---
name: agent-teams
description: Orchestrate teams of stateful subagents to split work, coordinate on complex tasks, and track progress with shared goals. Use when the user asks to split work across multiple agents, delegate subtasks, or coordinate parallel work. Covers spawning, messaging, polling, stopping subagents, and managing shared goals.
---

# Agent Teams

Agent teams let you split complex work across multiple stateful subagents that communicate with you (the orchestrator). Each subagent runs as a long-lived pi subprocess, retains its message history between turns, and can be messaged, polled, and stopped on demand.

## When to Use Agent Teams

| Scenario | Approach |
|----------|----------|
| Task spans multiple independent areas (e.g., search multiple directories) | Spawn parallel subagents, one per area |
| Task needs iterative refinement (e.g., review-then-fix-then-review) | Spawn one subagent, send follow-ups |
| Task has sequential dependencies (step B needs step A's output) | Use one-shot chain via `subagent_dispatch` |
| Simple one-shot work | Use `subagent_dispatch` (single or parallel) |
| Complex multi-step coordination | Spawn multiple stateful subagents, coordinate via send/poll |

## Core Tools

### Stateful (Long-Lived) Subagents

These are the heart of agent teams. Each subagent is a pi RPC subprocess that stays alive, retains context, and can be messaged iteratively.

| Tool | Purpose |
|------|---------|
| `subagent_spawn` | Create a subagent with a designed identity + initial task |
| `subagent_send` | Send a follow-up message, wait for response |
| `subagent_poll` | Check status and retrieve new messages |
| `subagent_stop` | Stop a subagent (cascades to descendants) |
| `subagent_list` | List all active subagents |

### One-Shot (Stateless) Dispatch

For stateless work that doesn't need follow-up:

| Tool | Purpose |
|------|---------|
| `subagent_dispatch` | Single / parallel / chain dispatch with custom identities |

### Goals

| Tool | Purpose |
|------|---------|
| `goals_add` | Define a goal (optionally with a check command) |
| `goals_list` | List active goals |
| `goals_check` | Run check commands against programmatic goals |
| `goals_update` | Update progress or mark complete |
| `goals_remove` | Remove a goal |

## Designing Subagent Identities

There are NO predefined identities. You design every subagent's identity at creation time. A good identity answers four questions:

1. **WHO is this subagent?** — a one-line role description
2. **WHAT does it own?** — the scope of its work and what tools it needs
3. **WHAT must it NOT do?** — constraints and boundaries
4. **HOW does it report back?** — the shape and format of its response

### Identity Template

```
You are [ROLE NAME]. [ONE-LINE DESCRIPTION OF PURPOSE].

## Scope
- [Specific responsibility 1]
- [Specific responsibility 2]

## Constraints
- Do NOT [boundary 1]
- Do NOT [boundary 2]
- Stay within [directory/area]

## Output Format
- Report findings as [format: bullet list, JSON, table, etc.]
- Include [specific fields: paths, sizes, counts, etc.]
- If nothing found, say "[clear empty-state message]"
```

### Model Selection

By default, subagents inherit the same model you (the orchestrator) are using. Only specify a different model when:
- The user explicitly asks for a specific model
- The task is simple enough for a cheaper/faster model
- The task needs a model with specific capabilities (e.g., vision)

You can also specify which tools the subagent has access to via the `tools` parameter (comma-separated tool names like `"read, bash, grep, find, ls"`).

## Sharing Goals with Subagents

Goals you create with `goals_add` are automatically injected into subagent system prompts. Each subagent sees the active goals and can work towards them. When you poll or receive responses from subagents, check for progress indicators and update goals accordingly.

To create goals for a team task:

```
goals_add("Find all PDF files in ~/Documents", check_command: "find ~/Documents -name '*.pdf' | head -1")
goals_add("Find all PDF files in ~/Downloads")
```

After subagents complete work, run `goals_check` to verify programmatic goals, and `goals_update` to record progress on qualitative ones.

## Two Styles of Stateful Subagent

Stateful subagents come in two distinct shapes. Pick the right one via the `style` parameter on `subagent_spawn`.

### Style: `team-member` (default)

The subagent owns a substantial task. It decomposes the task into its own goals, executes them, and reports goal-shaped status at end of turn.

When to pick this:
- The task is open-ended and requires planning.
- You handed off real ownership of a chunk of work.
- A goal-shaped report (`✓ done / ✗ blocked / … in progress`) is what you want back.

Examples: `pdf-indexer` building an index of all PDFs in `~/`, `migration-agent` upgrading a codebase, `auditor` reviewing a directory of contracts.

Auto-injected guidance covers: end-of-turn message routing, `goals_add`/`check`/`update` usage, expected report shape.

### Style: `worker`

The subagent has a narrow role and serves one request at a time. The orchestrator owns the decomposition; the worker just handles whatever request lands in its inbox.

When to pick this:
- The role is service-shaped: "answer X-type questions," "transform Y-type input."
- You'll be sending many small independent requests, not one big task.
- Goals don't fit — there's no project to plan, just a queue.
- You want terse per-request replies, not status reports.

Examples: `dictionary-worker` defining individual words, `thesaurus-worker` returning synonyms, `formatter-worker` reformatting snippets, `validator-worker` checking individual records.

Auto-injected guidance covers: end-of-turn message routing, idle-then-respond loop, terse per-request replies, no goal-setting, no spawning children.

### Style: `minimal`

Only the universal rule ("your final assistant message at end-of-turn IS your reply") is injected. Use this when your `system_prompt` already says everything needed and you don't want any auto-injected coaching to compete with your own framing.

## Patterns

### Pattern 1: Parallel Reconnaissance

Split a large search or investigation across multiple stateful subagents, then synthesize results.

```
1. Define goals for each area
2. Spawn one subagent per area with area-specific identity
3. Poll each subagent until idle
4. Stop subagents
5. Synthesize results
```

Example — searching for PDFs across multiple directories:

```
goals_add("Find all PDFs in ~/Documents")
goals_add("Find all PDFs in ~/Downloads")
goals_add("Find all PDFs in ~/projects")

subagent_spawn(
  id: "pdf-documents",
  system_prompt: "You are PdfScout-Documents. Search ~/Documents recursively for PDF files. Report paths, sizes, and modification times as a bullet list. Do NOT modify or move files.",
  task: "Find all PDF files under ~/Documents. Report each with path, size, and modification time."
)

subagent_spawn(
  id: "pdf-downloads", 
  system_prompt: "You are PdfScout-Downloads. Search ~/Downloads recursively for PDF files. Report paths, sizes, and modification times as a bullet list. Do NOT modify or move files.",
  task: "Find all PDF files under ~/Downloads. Report each with path, size, and modification time."
)

// Poll both
subagent_poll() // polls all

// When done
subagent_stop(id: "pdf-documents")
subagent_stop(id: "pdf-downloads")

goals_check()
```

### Pattern 2: Worker Pool

Spawn one or more narrow-role workers and feed them a stream of small requests. Best when you have many small tasks of the same kind and want to handle them concurrently or keep concerns cleanly separated.

```
subagent_spawn(
  id: "dictionary-worker",
  style: "worker",
  system_prompt: "You are DictionaryWorker. For each word sent to you, write a 1–3 sentence definition to ~/dict/<word>.txt and reply with the path and definition. Do not include synonyms.",
  task: "Stand by."
)

subagent_spawn(
  id: "thesaurus-worker",
  style: "worker",
  system_prompt: "You are ThesaurusWorker. For each word sent to you, write 5–8 synonyms to ~/thes/<word>.txt and reply with the path and synonyms.",
  task: "Stand by."
)

// Feed both with the same words concurrently
subagent_send(id: "dictionary-worker", message: "serendipity")
subagent_send(id: "thesaurus-worker", message: "serendipity")
// ... etc.

subagent_stop(id: "all")
```

Key differences from team-member: workers don't plan, don't set goals, don't decompose. They wait for requests and reply tersely. The orchestrator does the planning.

### Pattern 3: Iterative Refinement

Spawn a single subagent and refine its work through follow-up messages.

```
1. Spawn with initial task
2. Review initial response
3. Send follow-ups with corrections or additional context
4. Poll for results
5. Stop when satisfied
```

### Pattern 4: One-Shot Parallel

For stateless independent tasks, use `subagent_dispatch` with `tasks[].`

```
subagent_dispatch(
  tasks: [
    { name: "Scout-Docs", system_prompt: "...", task: "..." },
    { name: "Scout-Downloads", system_prompt: "...", task: "..." },
  ]
)
```

### Pattern 5: One-Shot Chain

For sequential dependencies, use `subagent_dispatch` with `chain[].` Use `{previous}` in later tasks to reference the prior step's output.

```
subagent_dispatch(
  chain: [
    { name: "Collector", system_prompt: "...", task: "Collect all X." },
    { name: "Analyzer", system_prompt: "...", task: "Analyze this collection: {previous}" },
  ]
)
```

## Subagent Lifecycle

```
spawn ──► running (processing initial task)
  │
  ├──► idle (waiting for next message)
  │      │
  │      ├──► send ──► running ──► idle
  │      │
  │      └──► stop ──► stopped (terminated, descendants also stopped)
  │
  └──► error ──► stopped
```

- **Poll** subagents periodically to check progress (especially when coordinating multiple)
- **Stop** subagents when their work is complete — idle subagents still consume resources
- **Stopping cascades** — stopping a parent subagent stops all its descendants
- No session is persisted for subagents (they run with `--no-session`)

## Coordination Tips

1. **Start with goals** — define goals before spawning subagents so they're injected into each subagent's context
2. **Design identities carefully** — a well-scoped identity prevents subagents from wandering into work they shouldn't do
3. **Poll frequently** — don't leave subagents idle without checking their progress
4. **Clean up** — always stop subagents when done; they survive across your orchestrator turns until stopped
5. **Narrow tools** — restrict subagent tools via the `tools` parameter when they don't need write/edit access
6. **Descriptive IDs** — use descriptive IDs like `"pdf-scout-downloads"`, not `"agent-1"`, so you can track which subagent produced which result
7. **Synthesize** — after subagents finish, summarize findings and update goals

## Subagent-Initiated Notifications

Every subagent's final assistant message at end-of-turn is automatically delivered to whoever is listening:

- If you (the orchestrator) called `subagent_send` and are awaiting a reply, you get it as the tool result.
- If the subagent ran unsupervised (e.g., it just finished its initial task from `subagent_spawn`, or it kicked off its own turn), the final message is surfaced in your chat as a styled notification.

This means the orchestrator naturally sees what subagents are doing without polling. Subagents don't need to use any special prefix or marker — they just end each turn with a clear, useful final message and the plumbing handles delivery.

The semantics are deliberately the same in both single-subagent and team scenarios. The difference between them is purely the topology: in a team scenario, multiple subagents are alive simultaneously, the orchestrator can address any of them, and (eventually) subagents will be able to address each other. The end-of-turn-message-as-reply rule applies uniformly.

## Subagents Track Their Own Goals

Subagents spawned with `style: "team-member"` (the default) are instructed at spawn time to use `goals_add`/`goals_check`/`goals_update` to track their own work. Their goal list is independent from yours — it's their personal task breakdown.

Why: when a team-member subagent ends a turn, its natural report is "here are the goals I set, here's the status of each." This makes their messages back to you well-structured without you having to ask for it. Expect to see reports like:

```
✓ Indexed all PDFs in ~/Downloads (verified by ls count = 42)
✓ Computed sizes for each
✗ Cross-reference with ~/Documents — blocked, permission denied on ~/Documents/private
```

This pattern reduces the need for you to ask follow-up questions. If a team-member subagent's report is vague, that often means they didn't set goals — a follow-up `subagent_send` asking them to break the work into goals is usually the right move.

Worker-style subagents (`style: "worker"`) are explicitly told NOT to set goals — there is no project, just a stream of independent requests. Their reports are per-request, not per-goal.
