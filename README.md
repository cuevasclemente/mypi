# mypi

A personal workspace of extensions, skills, and hooks for [**pi**](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — a hackable CLI coding agent.

If you use pi and want ideas (or working code) for new providers, subagent orchestration, persistent TODOs, or lifecycle hooks, poke around. Everything here is MIT-licensed; copy what's useful.

## What's in the box

### Providers — plug new model backends into pi

| Plugin          | What it does |
|-----------------|--------------|
| `claude-code`   | Wraps `claude -p` so your Claude Code subscription is callable as pi models `claude-code/{haiku,sonnet,opus}`. No API key needed — cost flows through your subscription. |
| `narwhal-horn`  | Registers a local llama.cpp server as a pi provider. Hostname-aware: loopback when run on the host; set `NARWHAL_HORN_BASE_URL` elsewhere. Useful as a template for adding any OpenAI-compatible local server. |
| `key-switcher`  | Hot-swap OpenRouter API keys (default ↔ zero-data-retention) via a `/or-key` slash command. |

### Agent orchestration

| Plugin          | What it does |
|-----------------|--------------|
| `agent-teams`   | Long-lived, stateful subagents. The main pi agent designs each subagent's identity (name + system prompt) at spawn time, then messages and polls it as work progresses. Also supports one-shot dispatch (single / parallel / chain) and a goal-tracking system. See [`plugins/agent-teams/README.md`](plugins/agent-teams/README.md). |
| `agent-monitor` | A cheap, fast watcher model that reviews each agent turn and flags meaningful milestones — useful for prompting journaling, memory updates, or other end-of-turn rituals. |
| `dreamer`       | Scheduled systemd user timer that reflects on recent sessions and proposes new skills to extract. |

### Workflow utilities

| Plugin           | What it does |
|------------------|--------------|
| `todo`           | Persistent TODO management — survives across pi sessions. |
| `hooks`          | Lifecycle-hook infrastructure. Define reminders in `hooks.json` that fire at specific events (session start/end, tool use, etc.). See `hooks.json.example`. |
| `interview` / `questionnaire` | Ask the user one or more structured questions and get back typed answers. Single-question and tab-bar multi-question modes. |
| `sudo-hook`      | Example hook extension that feeds a sudo password to pi when prompted. |

### Skills

Skills are markdown documents pi can pull into its context on demand.

| Skill          | What it covers |
|----------------|----------------|
| `mcp`          | Creating, installing, and configuring MCP servers with the `pi-mcp-adapter`. |
| `pi-monitors`  | Patterns for writing monitor-style extensions. |
| `memoriki`     | Personal memory system (specific to my setup — included as an example of a skill that wires together MCP tools and a static wiki). |

## Quick start

```bash
git clone git@github.com:cuevasclemente/mypi.git
cd mypi
npm install

# See what's available
make list-plugins
make list-skills

# Try a plugin without installing it globally
pi --extension ./plugins/todo "what's on my list?"

# Install plugins to ~/.pi/agent/extensions (copies by default)
make install

# Install plugins, skills, hooks config, global AGENTS.md, and dreamer timer
make install-all

# Or symlink plugins, so edits in this repo are live
make install MODE=symlink

# Install a subset
make user-install PLUGINS="todo agent-teams"

# Install into another project's local .pi/extensions
make project-install PROJECT_DIR=/path/to/other-repo PLUGINS="todo"
```

## Layout

```
mypi/
├── plugins/              # Source of truth for extensions (developed here)
│   ├── agent-teams/      #   Subagent orchestration + goals
│   ├── claude-code/      #   Claude Code subscription as a pi provider
│   ├── narwhal-horn/     #   Local llama.cpp as a pi provider
│   ├── key-switcher/     #   OpenRouter key hot-swap
│   ├── todo/             #   Persistent TODOs
│   ├── agent-monitor.ts  #   End-of-turn milestone detector
│   ├── hooks.ts          #   Lifecycle hook runner
│   ├── dreamer.ts        #   Session reflection → new skills
│   └── ...
├── skills/               # Skills (markdown docs pi can load)
├── .pi/extensions/       # Project-local pi extensions (auto-loaded)
├── secure_data/          # git-ignored; holds API keys for plugins that need them
├── Makefile              # Deployment to ~/.pi/agent/ or another project
└── hooks.json.example    # Template for the hooks extension
```

### Two deployment targets

- **Global** (`~/.pi/agent/extensions/`) — tools you want available everywhere.
- **Project-local** (`<project>/.pi/extensions/`) — tools scoped to one workspace, versioned alongside that project's code.

`make` handles both. `MODE=symlink` is handy during development so edits here are immediately reflected.

## Working on a plugin

Develop in this repo, then install — never edit installed copies directly.

```bash
# Iterate fast: load straight from the repo, no install step
pi --extension ./plugins/my-ext.ts "test it"
pi --skill ./skills/mcp/ "use the mcp skill"
```

When it's working, `make install` (or symlink it) and it's live globally.

## Secrets

Some plugins need API keys. `secure_data/` is git-ignored; create the files with `0600` permissions:

| File                              | Used by                |
|-----------------------------------|------------------------|
| `secure_data/exa_key`             | Exa MCP wrapper        |
| `secure_data/openrouter_key`      | `key-switcher`         |
| `secure_data/zdr_openrouter_key`  | `key-switcher`         |
| `secure_data/narwhal_horn_key`    | `narwhal-horn`         |

For `narwhal-horn`, the key must match the llama.cpp server's API key.

## Status

This is a personal workspace, not a curated product — interfaces may shift as pi evolves. That said, the pieces here have been working reliably day-to-day, and most are small enough to fork and trim to taste. PRs and issues welcome; suggestions and ideas even more so.

## License

[MIT](LICENSE).
