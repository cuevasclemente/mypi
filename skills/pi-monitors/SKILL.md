---
name: pi-monitors
description: Create agent monitors and lifecycle hooks for pi. Monitors watch agent output via a cheap model and inject reminders when milestones are reached. Hooks inject reminders at lifecycle points (after tools, every N turns, session start). Use when the user wants automated reminders, journaling nudges, or extension auto-installation.
---

# Pi Monitors & Hooks

Pi has two complementary systems for injecting reminders and automation based on agent behavior:

1. **Monitors** (`agent-monitor.ts`) — Use a cheap/fast model to evaluate agent output at the end of each turn. When significant work is detected, inject a custom message into the chat.

2. **Hooks** (`hooks.ts`) — Inject reminders at specific lifecycle points (after tool calls, every N turns, session start) without needing an LLM call.

Both read their configuration from JSON files.

## Configuration Files

| Priority | Path | Scope |
|----------|------|-------|
| 1 (loaded first, lower priority) | `~/.pi/agent/hooks.json` | Global (all projects) |
| 2 (loaded second, overrides) | `.pi/hooks.json` | Project-local |

Both files merge — global hooks run alongside project hooks. The same file configures both monitors and hooks.

## Prerequisites

Both extensions must be in `~/.pi/agent/extensions/`:

```bash
# From your extension repo:
cp .pi/extensions/agent-monitor.ts ~/.pi/agent/extensions/
cp .pi/extensions/hooks.ts ~/.pi/agent/extensions/
```

---

## Monitors

Monitors use a cheap model (default: DeepSeek V4 Flash) to read the assistant's recent output and decide whether to inject a reminder. They fire after `agent_end` (when the agent finishes all tool calls for a prompt).

### Monitor Definition Schema

```json
{
  "monitors": [
    {
      "name": "unique-monitor-name",
      "model": "openrouter/deepseek/deepseek-v4-flash",
      "prompt": "Instructions for the monitor model...",
      "message": "Message injected into chat when triggered. Use {reason} placeholder.",
      "minInterval": 3,
      "maxContextTokens": 2000
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier for this monitor |
| `model` | Yes | Model spec. 2-part: `provider/model-id` (e.g., `openai/gpt-4o-mini`). 3-part for OpenRouter: `openrouter/deepseek/deepseek-v4-flash`. The `resolveModel` function handles both. |
| `prompt` | Yes | Prompt sent to the monitor model. **Must** instruct it to output JSON: `{"triggered": bool, "reason": "..."}` |
| `message` | Yes | Message injected when triggered. `{reason}` is replaced with the reason from the model. |
| `minInterval` | No | Minimum assistant messages between evaluations (default: 3). Prevents spam. |
| `maxContextTokens` | No | Max tokens of assistant output sent to monitor (default: 1500). Controls cost. |

### How Monitors Work

1. The `agent-monitor` extension collects assistant message text during turns.
2. When `agent_end` fires, it checks if enough messages have accumulated (`minInterval`).
3. It sends the collected text + your `prompt` to the monitor model.
4. The model returns JSON with `triggered` (boolean) and `reason` (string).
5. If triggered, the extension injects your `message` (with `{reason}` substituted) as a styled custom message.

### Monitor Prompt Guidelines

The prompt is the most important part. It must:

- **Instruct the model to output ONLY JSON** — no markdown, no explanation
- **Define what "triggered" means** — be specific about what constitutes significant work
- **Define what NOT to trigger on** — minor edits, routine changes, non-relevant code
- **Ask for a brief reason** — this appears in the injected message

### Example: Journaling Reminder

```json
{
  "monitors": [
    {
      "name": "journal-reminder",
      "model": "openrouter/deepseek/deepseek-v4-flash",
      "prompt": "You are monitoring a coding agent's output. Read the assistant's messages below and determine if the work completed represents a meaningful milestone. Look for: completing a significant chunk of work, discovering and fixing a tricky bug, making an important architectural decision, landing a non-trivial feature, or resolving a complex problem. If the work is routine, minor edits, or simple refactoring, do NOT trigger.\n\nRespond with ONLY a JSON object: {\"triggered\": true|false, \"reason\": \"one sentence explaining what milestone was reached\"}.",
      "message": "This looks like a meaningful milestone was reached. Consider:\n1. Journaling this work in ./docs/journals/\n2. Updating memoriki at ~/src/memoriki with any new knowledge, patterns, or decisions",
      "minInterval": 3,
      "maxContextTokens": 2000
    }
  ]
}
```

### Example: Extension Auto-Install Reminder

```json
{
  "monitors": [
    {
      "name": "install-extension",
      "model": "openrouter/deepseek/deepseek-v4-flash",
      "prompt": "You are monitoring a coding agent's output. Your only job is to detect when the agent has created, written, or substantially modified files that look like new pi extensions. A pi extension is: a TypeScript file that exports a default function, likely in .pi/extensions/ or ~/.pi/agent/extensions/. Look for: registering tools (pi.registerTool), commands (pi.registerCommand), event handlers (pi.on), or custom UI components. Also watch for new agent definition .md files in .pi/agents/ or team definitions in .pi/teams/.\n\nIf the agent has created a meaningful new extension that wasn't there before, trigger. Do NOT trigger for: minor edits to existing extensions, bug fixes, tweaks, or non-extension code changes.\n\nRespond with ONLY a JSON object: {\"triggered\": true|false, \"reason\": \"what extension/agent/team was created\"}.",
      "message": "A new pi extension may have been created. If so, install it to the user context:\n- Copy .ts extension files to ~/.pi/agent/extensions/\n- Copy agent .md files to ~/.pi/agent/agents/\n- Copy team .md files to ~/.pi/agent/teams/\n\nThen verify with: `find ~/.pi/agent/extensions -name '*.ts' | sort`",
      "minInterval": 2,
      "maxContextTokens": 2000
    }
  ]
}
```

### Choosing a Monitor Model

Monitors should use cheap, fast models since they run after every agent turn:

| Provider | Model | Good for |
|----------|-------|----------|
| Provider | Model Spec | Notes |
|----------|-----------|-------|
| DeepSeek (via OpenRouter) | `openrouter/deepseek/deepseek-v4-flash` | Default — fast, cheap, good enough. Use 3-part spec with OpenRouter. |
| DeepSeek (direct API) | `deepseek/deepseek-v4-flash` | Use only with a direct DeepSeek API key |
| OpenAI | `openai/gpt-4o-mini` | More reliable JSON output |
| Anthropic | `anthropic/claude-haiku-4-5` | Best reasoning, more expensive |

The model only needs to read a small amount of text and return a yes/no decision, so flash/mini models are ideal.

### Testing a Monitor

After adding a monitor, you can test it by:

1. Run `/reload` (or restart pi) to load the new config
2. Do some work that should trigger the monitor
3. Watch for the styled monitor message to appear in chat
4. Run `/monitors` to see which monitors are active
5. If it doesn't trigger, lower `minInterval` temporarily and try again

---

## Hooks

Hooks are simpler than monitors — they inject reminders at specific lifecycle points without requiring an LLM call. They're defined in the same `hooks.json` file.

### Hook Definition Schema

```json
{
  "hooks": [
    {
      "name": "hook-name",
      "trigger": "after_tool",
      "message": "Reminder text injected into the agent's system prompt",
      "tools": ["write", "edit"],
      "every": 5,
      "match": "deploy",
      "regex": false,
      "once": false
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique name for this hook |
| `trigger` | Yes | When to fire: `session_start`, `new_session`, `every_turn`, `every_n_turns`, `after_tool`, `on_command` |
| `message` | Yes | Text injected (appended to system prompt or sent as message) |
| `tools` | For `after_tool` | Tool name(s) that trigger this hook (string or array) |
| `every` | For `every_n_turns` | Fire every N turns (default: 5) |
| `match` | For `on_command` | Prefix or pattern to match user input |
| `regex` | For `on_command` | If true, `match` is treated as regex instead of substring |
| `once` | For `on_command` | If true, fire only once per session |

### Trigger Types

| Trigger | Behavior | Injection Method |
|---------|----------|-----------------|
| `session_start` | Fires once when session starts (any reason) | Custom message in chat |
| `new_session` | Fires only for brand-new sessions (not resume/fork/reload) | Custom message in chat |
| `every_turn` | Fires before every agent turn | Appended to system prompt |
| `every_n_turns` | Fires every N turns (use `every` field) | Appended to system prompt |
| `after_tool` | Fires on the next turn after a matching tool runs | Appended to system prompt |
| `on_command` | Fires when user input matches `match` | Appended to system prompt |

### Example: Guard Against Uninstalled Extensions

```json
{
  "hooks": [
    {
      "name": "install-extension-guard",
      "trigger": "after_tool",
      "tools": ["write", "edit"],
      "message": "If you just created or modified a pi extension (a .ts file exporting a default function with pi hooks, or agent/team .md files), make sure it's also installed to ~/.pi/agent/ for global use. Check ~/.pi/agent/extensions/, ~/.pi/agent/agents/, and ~/.pi/agent/teams/."
    }
  ]
}
```

### Example: Venv Reminder Every Session

```json
{
  "hooks": [
    {
      "name": "activate-venv",
      "trigger": "session_start",
      "message": "Remember to activate the Python virtual environment: `source .venv/bin/activate`"
    }
  ]
}
```

### Example: Test Runner Reminder Every 5 Turns

```json
{
  "hooks": [
    {
      "name": "run-tests",
      "trigger": "every_n_turns",
      "every": 5,
      "message": "Have you run the tests recently? Consider running `npm test` to catch regressions."
    }
  ]
}
```

---

## Monitors vs Hooks — When to Use Which

| Use a Monitor when... | Use a Hook when... |
|-----------------------|-------------------|
| You need semantic understanding ("was this significant?") | You need simple trigger-based reminders |
| The condition is nuanced and requires judgment | The condition is mechanical (after a tool, every N turns) |
| You're OK with ~1-2 seconds of latency and a small API cost | You want zero latency and zero cost |
| You want a styled message in chat | You want text appended to the system prompt |

They complement each other. For extension auto-installation, use both:
- Hook triggers immediately after `write`/`edit` tools → immediate reminder
- Monitor evaluates at end of turn → catches things the hook might miss

---

## Installation Checklist

When creating a new monitor or hook:

1. **Write the config** — add to `~/.pi/agent/hooks.json` (global) or `.pi/hooks.json` (project)
2. **Ensure extensions are installed** — `agent-monitor.ts` and `hooks.ts` must be in `~/.pi/agent/extensions/`
3. **Verify model access** — the monitor model must have an API key configured
4. **Run `/reload`** — or restart pi to load new config
5. **Test it** — do work that should trigger it, verify the reminder appears

### Commands

| Command | Description |
|---------|-------------|
| `/monitors` | List active monitors (from agent-monitor extension) |
| `/hooks` | List active hooks (from hooks extension) |
| `/hooks-reload` | Reload hooks config without restarting |

### Verifying Full Installation

```bash
# Check extensions are present
find ~/.pi/agent/extensions -name '*.ts' | sort

# Check config exists
cat ~/.pi/agent/hooks.json

# Check agents and teams
ls ~/.pi/agent/agents/
ls ~/.pi/agent/teams/
```