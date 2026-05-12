# Agent Teams Extension for Pi

Long-lived, stateful subagents for pi. The main pi agent IS the orchestrator — it designs, spawns, messages, polls, and stops subagents on demand.

## Core Idea: Identity Is Designed, Not Selected

There is **no registry of predefined agent identities**. Every subagent is brought into existence with a freshly-authored identity — a name and a system prompt — designed by the orchestrator for the specific task at hand.

This is the central pattern of the extension. The orchestrator:

1. **Names** the subagent for its role (`pdf-scout-downloads`, `route-auditor`, `migration-reviewer`).
2. **Writes** a system prompt declaring the subagent's role, scope, constraints, and reporting format.
3. **Spawns** the subagent with that identity and an initial task.
4. (For long-lived work) **Messages** the subagent iteratively via `subagent_send`, **polls** with `subagent_poll`, and **stops** with `subagent_stop` when done.

There are no `agent: "backend"` shortcuts. The orchestrator owns the identity design every time.

> **New to agent teams?** The orchestrator's system prompt includes a skill (`agent-teams`) that teaches it how to use these tools effectively. See [SKILL.md](./SKILL.md) for the full guide.

## Architecture

```
Main Pi Agent (Orchestrator)
   │
   │  ──► designs identity at spawn time
   │       (name + system_prompt tailored to task)
   │
   ├── subagent_spawn  ──► PdfScout-Downloads  (long-lived RPC subprocess)
   │                        │
   │                        ├── receives messages   via subagent_send
   │                        ├── reports progress    via subagent_poll
   │                        ├── sees active goals   (auto-injected into prompt)
   │                        └── terminated          via subagent_stop
   │
   ├── subagent_spawn  ──► RouteAuditor          (long-lived RPC subprocess)
   │
   ├── subagent_dispatch ──► one-shot stateless subagents (single / parallel / chain)
   │                          each with its own designed identity
   │
   └── goals_*            ──► goal tracking system
                               (injected into subagent prompts)
```

## Tools

### Long-Lived, Stateful Subagents (RPC-based)

| Tool             | Description                                                              |
|------------------|--------------------------------------------------------------------------|
| `subagent_spawn` | Spawn a long-lived subagent with a designed identity + initial task. Active goals and orchestrator model are auto-inherited. |
| `subagent_send`  | Send a follow-up message to a subagent; wait for response                |
| `subagent_poll`  | Check a subagent's status and retrieve new messages                      |
| `subagent_stop`  | Stop a subagent (cascading: descendants stop too)                        |
| `subagent_list`  | List all active subagents in tree form                                   |

### One-Shot Dispatch (Stateless)

| Tool                | Description                                                                |
|---------------------|----------------------------------------------------------------------------|
| `subagent_dispatch` | Run designed-identity subagents in single / parallel / chain mode. Model defaults to orchestrator's model. |

### Goals

| Tool           | Description                                |
|----------------|--------------------------------------------|
| `goals_list`   | List active goals                          |
| `goals_add`    | Add a goal (programmatic or qualitative)   |
| `goals_check`  | Check programmatic goals by running checks |
| `goals_update` | Update goal progress or mark complete      |
| `goals_remove` | Remove a goal                              |

## Commands

| Command              | Description                              |
|----------------------|------------------------------------------|
| `/goals`             | List active goals                        |
| `/goals:add`         | Add a goal (`desc` or `desc \| check`)   |
| `/goals:done <n>`    | Mark goal #n complete                    |
| `/subagents`         | List active subagents (tree view)        |

## Key Behaviors

### Shared Goals

Active goals (created with `goals_add`) are automatically injected into subagent system prompts when spawned. Each subagent sees the current goals and can work towards them. The orchestrator should:

1. Define goals before spawning subagents
2. Poll subagents and check responses for progress indicators
3. Run `goals_check` after subagents complete to verify programmatic goals
4. Use `goals_update` to record progress on qualitative goals

### Model Inheritance

Subagents and dispatched agents inherit the orchestrator's current model by default. Only override the model when:

- The user explicitly asks for a specific model
- A task needs a cheaper/faster model (simple searches, grep work)
- A task needs special capabilities (vision, etc.)

Model overrides use the same format as pi's `--model` flag: `provider/model-id` (e.g., `openrouter/deepseek/deepseek-v4-flash`).

### Tool Restrictions

Subagents can be restricted to specific tools via the `tools` parameter. This is a comma-separated list of tool names:

- `"read, bash"` — read-only access
- `"read, bash, edit, write, grep, find, ls"` — full coding access
- Omit for the default tool set

## Designing an Identity

A subagent's identity is a contract. The orchestrator writes it; the subagent inherits it.

A well-designed identity answers four questions:

1. **Who is this subagent?** (a one-line role)
2. **What does it own?** (the scope of its work)
3. **What must it not do?** (constraints — usually narrower than the orchestrator's defaults)
4. **How does it report back?** (the shape of the response the orchestrator expects)

### Example: a single stateful subagent

```
subagent_spawn(
  id: "PdfScout-Downloads",
  system_prompt: |
    You are PdfScout-Downloads. You inventory PDF files under ~/Downloads.

    Scope:
      - Search ~/Downloads recursively for files ending in .pdf (case-insensitive).
      - Capture the path, size, and modification time for each.

    Constraints:
      - Do NOT modify, move, or delete any files.
      - Do NOT follow symlinks outside ~/Downloads.
      - Do NOT search other directories.

    Report:
      - A bullet list of PDF paths, one per line, with size and mtime.
      - If 0 PDFs, say "no PDFs in ~/Downloads".

  task: "Inventory all PDFs under ~/Downloads."
)
```

### Example: a parallel team

The orchestrator splits a large search across multiple subagents, designing a distinct identity for each region:

```
subagent_dispatch(tasks=[
  { name: "PdfScout-Documents",
    system_prompt: "You inventory PDFs under ~/Documents. ...",
    task: "Inventory PDFs in ~/Documents." },
  { name: "PdfScout-Downloads",
    system_prompt: "You inventory PDFs under ~/Downloads. ...",
    task: "Inventory PDFs in ~/Downloads." },
  { name: "PdfScout-Projects",
    system_prompt: "You inventory PDFs under ~/projects. ...",
    task: "Inventory PDFs in ~/projects." },
])
```

The names are descriptive so the orchestrator can disambiguate results. The system prompts are tailored — for instance, `PdfScout-Projects` might be told to skip `node_modules` and `.git`, while `PdfScout-Documents` would not need that constraint.

## Usage Patterns

See [SKILL.md](./SKILL.md) for detailed patterns including:
- Parallel Reconnaissance
- Iterative Refinement
- One-Shot Parallel/Chain
- Goal-Driven Workflows

## Cascading Stop

When `subagent_stop` is called on a parent subagent, ALL descendants stop recursively:

```
Orchestrator
  └─ backend-reviewer     ← stop this...
       └─ migration-checker  ← also stops
       └─ test-runner        ← also stops
```

## File Structure

```
plugins/agent-teams/
├── SKILL.md              # Orchestrator skill — teaches the LLM how to use agent teams
├── README.md             # This file — technical reference for developers
├── index.ts              # Entry point — registers all tools + commands
├── goals.ts              # Goal management utilities
├── subagent-manager.ts   # RPC subprocess lifecycle (long-lived agents)
└── subagent-runner.ts    # One-shot dispatch runner
```

## Nesting

Subagents can spawn their own children. The orchestrator (your main pi session) is the root of every tree. When a parent stops, its children stop too. For a subagent to spawn its own children, the extension must be available in its subprocess (configured separately).
