# mypi

Pi extensions, skills, and hooks development workspace.

## Development Workflow

**Always develop in this repo, then install to the global area — never the other way around.**

- Extensions, skills, hooks, agents, and teams live in this repo first
- Work on them here, test with `pi --extension ./plugins/foo.ts` (or `--skill ./skills/foo/`)
- When ready, copy/install to `~/.pi/agent/` for global use
- This keeps a versioned, portable source of truth that can be shared or restored

## Structure

```
~/src/mypi/
├── .pi/
│   ├── extensions/        # Project-local extensions (auto-loaded by pi).
│   │                       #   These are specific to this workspace and
│   │                       #   versioned here. Global tools go in
│   │                       #   ~/.pi/agent/extensions/ instead.
│   └── exa-mcp-wrapper.sh # MCP wrapper (reads keys from files)
├── plugins/               # Dev copies of extensions for working on
│   ├── agent-monitor.ts   #   Monitors agent output for milestone detection
│   ├── agent-teams/       #   Subagent orchestration & goals system
│   ├── hooks.ts           #   Lifecycle hook infrastructure
│   └── todo/              #   Persistent TODO management
└── skills/                # Skills for this project (developed here)
    └── mcp/               #   MCP server creation & installation
```

## How it works

- **Runtime:** Pi loads extensions from `~/.pi/agent/extensions/`, skills from `~/.pi/agent/skills/`
- **Development:** Work on extensions in `plugins/`, skills in `skills/`, then deploy to `~/.pi/agent/` when ready
- **Deployment:** Use the Makefile to copy or symlink repo plugins into the pi extension discovery directories
- **Testing locally:** Use `--extension` / `--skill` flags to load directly from this repo without installing globally

```bash
# Test an extension without installing globally
pi --extension ./plugins/my-ext.ts "test it"

# Test a skill
pi --skill ./skills/mcp/ "use the mcp skill"
```

## Extension placement

- **Project-local** (`.pi/extensions/`): Tools specific to this project/workspace. Versioned in this repo, auto-discovered by pi.
- **Global** (`~/.pi/agent/extensions/`): Tools needed across all projects. Symlinked or copied from `plugins/` when ready.

## Deploying extensions

List deployable plugins:

```bash
make list-plugins
```

Install all plugins globally for the current user:

```bash
make install
```

Install selected plugins globally:

```bash
make user-install PLUGINS="todo agent-teams"
```

Install selected plugins into another project's local pi extension directory:

```bash
make project-install PROJECT_DIR=/path/to/project PLUGINS="todo agent-teams"
# alias:
make make-project-install PROJECT_DIR=/path/to/project PLUGINS="todo agent-teams"
```

By default deployment copies files. Use `MODE=symlink` if you want installed extensions to track this checkout directly:

```bash
make install MODE=symlink
```

## Secrets

`secure_data/` is git-ignored. After cloning, populate the files the active plugins need (all mode `0600`):

| File                              | Used by                  |
|-----------------------------------|--------------------------|
| `secure_data/openrouter_key`      | `plugins/key-switcher`   |
| `secure_data/zdr_openrouter_key`  | `plugins/key-switcher`   |
| `secure_data/narwhal_horn_key`    | `plugins/narwhal-horn`   |

The `narwhal_horn_key` value must match `LLAMA_API_KEY` in `/etc/llama-server/env` on the host running the llama.cpp server.

## Plugins

| Plugin            | What it does                                                                 |
|-------------------|------------------------------------------------------------------------------|
| `narwhal-horn`    | Registers the local Qwen3.6-Heretic llama.cpp server as a pi provider. Hostname-aware (`127.0.0.1` on narwhal-horn; set `NARWHAL_HORN_BASE_URL` elsewhere). |
| `claude-code`     | Wraps `claude -p --output-format json` so the user's Claude Code subscription is callable as pi models `claude-code/{haiku,sonnet,opus}`. No API key needed. |
| `key-switcher`    | Swap OpenRouter API keys (default ↔ ZDR) via `/or-key` slash command.        |
| `agent-teams`     | Subagent orchestration + goals.                                              |
| `agent-monitor`   | Detect milestones in agent output.                                           |
| `dreamer`         | Reflect on session history; suggest new skills.                              |
| `hooks`           | Lifecycle hook infrastructure.                                               |
| `todo`            | Persistent TODO management.                                                  |