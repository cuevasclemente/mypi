# Agent Teams Extension for Pi

Agent teams and subagent orchestration for pi. The main pi agent IS the orchestrator — it spawns, communicates with, coordinates, and stops specialized subagents.

## Architecture

```
Main Pi Agent (Orchestrator)
   │
   ├── subagent_spawn ──► Frontend Agent (RPC subprocess)
   │                           │
   │                           ├── Receives tasks via subagent_send
   │                           ├── Reports progress via subagent_poll
   │                           └── Stopped via subagent_stop
   │
   ├── subagent_spawn ──► Backend Agent (RPC subprocess)
   │
   ├── subagent_dispatch ──► One-shot parallel/chain agents
   │
   └── goals_* ──► Goal tracking system
```

## Tools

### Subagent Management (long-lived, RPC-based)
| Tool | Description |
|------|-------------|
| `subagent_spawn` | Create a subagent with system prompt + initial task |
| `subagent_send` | Send a follow-up message to a subagent, wait for response |
| `subagent_poll` | Check subagent status and retrieve new messages |
| `subagent_stop` | Stop a subagent (cascading: stops children too) |
| `subagent_list` | List all active subagents with tree structure |

### One-Shot Dispatch (stateless)
| Tool | Description |
|------|-------------|
| `subagent_dispatch` | Dispatch tasks to agents (single, parallel, or chain mode) |

### Goals
| Tool | Description |
|------|-------------|
| `goals_list` | List active goals |
| `goals_add` | Add a goal (programmatic or qualitative) |
| `goals_check` | Check programmatic goals by running their check commands |
| `goals_update` | Update goal progress or mark complete |
| `goals_remove` | Remove a goal |

## Commands

| Command | Description |
|---------|-------------|
| `/goals` | List active goals |
| `/goals:add <desc> [\| <check cmd>]` | Add a goal |
| `/goals:done <index>` | Mark a goal complete |
| `/agents:list` | List available agent definitions |
| `/teams:list` | List available team definitions |
| `/subagents` | List active subagents (tree view) |

## Agent Definitions

Agents are defined in `.pi/agents/*.md` with YAML frontmatter:

```markdown
---
name: frontend
description: Frontend/UI specialist
tools: read, bash, edit, write, grep, find, ls
model: claude-sonnet-4-5
---

System prompt body here...
```

### Included Agents
- **frontend** — UI components, styling, client-side logic
- **backend** — APIs, business logic, authentication
- **database** — Schema design, migrations, queries
- **infra** — Docker, CI/CD, cloud config
- **deployment** — Release management, production operations
- **architect** — System design and team orchestration

## Team Definitions

Teams are defined in `.pi/teams/*.md` with YAML frontmatter:

```markdown
---
name: full-stack
description: Full-stack development team
agents: frontend, backend, database
orchestrator: architect
---

Optional team-level context...
```

### Included Teams
- **full-stack** — Frontend + Backend + Database
- **infra-deploy** — Infrastructure + Deployment

## Goals

Goals are long-horizon objectives that guide agent team workflows.

### Programmatic Goals
Have a check command that exits 0 when the goal is met:
```
/goals:add All tests passing | npm test
```

### Qualitative Goals
Described in text, manually updated:
```
/goals:add Ensure consistent error handling across all API routes
```

Goals are automatically checked via `goals_check` and appear in the orchestrator's system prompt context.

## Cascading Stop

When `subagent_stop` is called on a parent subagent, ALL descendants are stopped recursively. This ensures clean teardown of agent trees.

```
Orchestrator
  └─ backend-1         ← stopping this...
       └─ db-helper-1   ← also stops this
       └─ db-helper-2   ← also stops this
```

## Usage

### Parallel Dispatch
```
Use subagent_dispatch to run the frontend and backend agents in parallel:
- frontend: Build the login page component
- backend: Add the /api/auth/login endpoint
```

### Coordinated Team Work
```
Spawn a backend agent, send it the API spec, poll for progress,
send follow-up with review feedback, then stop it.
```

### Goal-Driven Workflow
```
/goals:add All API endpoints have tests | npm test -- --coverage --testPathPattern=api
/goals:add Consistent error response format

Then use the full-stack team to implement API changes.
The orchestrator will check goals after dispatching work.
```

## File Structure

```
.pi/
├── extensions/
│   └── agent-teams/
│       ├── index.ts              # Entry point — registers all tools + commands
│       ├── agents.ts             # Agent discovery from .md files
│       ├── teams.ts              # Team discovery from .md files
│       ├── goals.ts              # Goal management utilities
│       ├── subagent-manager.ts   # RPC subprocess lifecycle manager
│       └── subagent-runner.ts    # One-shot dispatch runner
├── agents/
│   ├── frontend.md
│   ├── backend.md
│   ├── database.md
│   ├── infra.md
│   ├── deployment.md
│   └── architect.md
└── teams/
    ├── full-stack.md
    └── infra-deploy.md
```

## Subagents with Subagents

Subagents can be nested: a parent subagent can have child subagents. All children are automatically stopped when the parent is stopped. The main orchestrator (your pi session) is the root of all agent trees.

For subagents to spawn their own children autonomously, pass the extension to subprocesses (future enhancement).