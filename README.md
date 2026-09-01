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
<<<<<<< HEAD
| `session-auto-title` | Disabled-by-default, identity-neutral one-time Terra titles for ordinary interactive TUI sessions after three completed exchanges. |
| `memory-first-compaction` | Independently opt-in persisted-memory guidance, 96K review/128K ordinary compaction sequencing, and a separate metadata-only HMAC ledger. See [`plugins/memory-first-compaction/README.md`](plugins/memory-first-compaction/README.md). |
=======
| `session-coordinator` | Filesystem-backed room/presence tooling so independent TUI/Wayang pi sessions in the same project can see peers, post notes, and claim work without being an agent team. |
>>>>>>> feature/runtime-extensions
| `dreamer`       | Scheduled systemd user timer that reflects on recent sessions and proposes new skills to extract. |

#### Automatic session-title disclosure

`session-auto-title` is inert unless `PI_AUTO_SESSION_TITLE=on`. When enabled, it sends deterministically bounded prose from the first three marked interactive TUI exchanges to the fixed `openai-codex/gpt-5.6-terra` model. It excludes RPC/JSON/print/headless inputs, extension-origin turns, unmarked historical sessions, tool calls/results, reasoning, images, system prompts, later turns, and Wayang-owned session managers. Human names use the same pinned Pi lock and win races.

Conversation prose can itself contain private facts, paths, or credentials authored by the human or repeated by the assistant. Enabling the flag authorizes that disclosure. Failures retry only after another completed marked exchange; setting the flag to any value other than `on` disables new attempts. The repository pins `@earendil-works/pi-coding-agent` to the vendored `0.84.1-wayang.29fcca05` artifact (SHA-256 `fc09c52ec79888b30b10e63a985b3ba1c23a96e6ee37b5cf0f3ab1fdfbfb2007`) for the shared physical-file transaction, session-name CAS APIs, optional fixed compaction threshold, and optional complete-turn retention.

### Workflow utilities

| Plugin           | What it does |
|------------------|--------------|
| `todo`           | Persistent TODO management — survives across pi sessions. |
| `hooks`          | Lifecycle-hook infrastructure. Define reminders or TODO preseeds in `hooks.json` that fire at specific events (session start/end, tool use, etc.). See `hooks.json.example`. |
| `interview` / `questionnaire` | Ask the user one or more structured questions and get back typed answers. Single-question and tab-bar multi-question modes. |
| `ssh-clipboard-images` | In SSH/Mosh pi sessions, Ctrl+V (or `/paste-image`) reads an image from the local Kitty clipboard via OSC 5522 and attaches it to the next message. |
| `sudo-hook`      | Example hook extension that feeds a sudo password to pi when prompted. |
| `command-authorization-monitor` | Optional bash command guard. Defaults to balanced mode: local allow for safe read-only inspection, model review for everything else. The guard routes to a cheap/fast model for the active provider (for example DeepSeek V4 Flash for OpenRouter DeepSeek Pro, GPT-5.6 Luna for openai-codex GPT-5.6 Terra/Sol). Use `/command-guard off` at runtime, or set `PI_COMMAND_GUARD=off` before launch. |

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

# Install plugins, skills, hooks config, and dreamer timer
# (global identity/context remains an explicit separate install)
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
├── agent-context/        # Identity-neutral user context for optional global Pi installation
│   └── AGENTS.md         #   Canonical generic source; contains no named agent identity
├── AGENTS.md             # Instructions for working in this repository only
├── plugins/              # Source of truth for extensions (developed here)
│   ├── agent-teams/      #   Subagent orchestration + goals
│   ├── claude-code/      #   Claude Code subscription as a pi provider
│   ├── narwhal-horn/     #   Local llama.cpp as a pi provider
│   ├── key-switcher/     #   OpenRouter key hot-swap
│   ├── todo/             #   Persistent TODOs
│   ├── session-coordinator/ # Cross-session peer presence, messages, and claims
│   ├── agent-monitor.ts  #   End-of-turn milestone detector
│   ├── session-auto-title.ts # Opt-in interactive Terra titles
│   ├── memory-first-compaction/ # Opt-in memory review/compaction + metadata ledger
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

`make` handles both. `MODE=symlink` is handy during development so edits in this repo are immediately reflected.

The generic global user context has a separate source from this repository's own instructions. `make install-neutral-context` backs up both runtime context layers, installs `agent-context/AGENTS.md`, and removes any existing `APPEND_SYSTEM.md` into the recoverable backup so the resulting deployment is actually neutral. `make install-agent-context` is a compatibility alias. The root `AGENTS.md` remains project-local.

`make install-all` intentionally excludes global context. Installing or synchronizing `mypi` deploys capabilities only: it must not install a named identity, identity anchor, autobiographical memory, or identity-specific capsule.

The designated active Wren runtime is owned separately by `~/src/wren`. That repository composes this generic context with its private activation overlay and installs both runtime context layers through a guarded, rollback-capable flow. Copying or installing `mypi` elsewhere therefore produces a neutral agent by default.

## Working on a plugin

Develop in this repo, then install — never edit installed copies directly.

```bash
# Iterate fast: load straight from the repo, no install step
pi --extension ./plugins/my-ext.ts "test it"
pi --skill ./skills/mcp/ "use the mcp skill"
```

When it's working, `make install` (or symlink it) and it's live globally.

## Command guard controls

If `command-authorization-monitor` is installed, toggle it at runtime with slash commands (works in the terminal UI and wayang):

```text
/command-guard off       # disable for this pi session
/command-guard balanced  # default: preallow safe read-only inspection
/command-guard audit     # warn, never block
/command-guard strict    # model verdict required for every bash command
/command-guard status    # show current mode
/command-guard history   # show recent decisions
```

`/cmd-guard` is a shorter alias. Slash-command changes last until `/reload` or pi restarts. The status output includes the model route the guard will try; by default it tracks the active provider and falls back to `openrouter/deepseek/deepseek-v4-flash` / `deepseek/deepseek-v4-flash` when no provider-specific cheap model is known.

You can also configure it before starting `pi`:

```bash
PI_COMMAND_GUARD=off pi
PI_COMMAND_GUARD_MODE=audit pi
PI_COMMAND_GUARD_MODE=balanced pi
PI_COMMAND_GUARD_MODE=strict pi
```

For a persistent disable, remove/rename `~/.pi/agent/extensions/command-authorization-monitor.ts` or set `PI_COMMAND_GUARD=off` in the environment that launches pi.

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
