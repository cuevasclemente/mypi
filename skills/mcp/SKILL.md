---
name: mcp
description: Create and install MCP (Model Context Protocol) servers for pi. Use when the user wants to add a new MCP server, configure API keys for MCP servers, troubleshoot MCP connections, or set up MCP tools. Covers the full workflow: finding, installing, configuring, and testing MCP servers with pi-mcp-adapter.
---

# MCP Servers in Pi

Pi uses the `pi-mcp-adapter` (installed as a pi package) to connect MCP servers. One proxy tool (`mcp`) instead of hundreds of individual tool definitions — servers are lazy-loaded, tools are discovered on-demand.

## Quick Reference

| What you need | How to do it |
|---------------|--------------|
| Find MCP servers | `npm search mcp server <topic>`, [Smithery](https://smithery.ai), GitHub search |
| Add a server | Add entry to `.mcp.json` (project) or `~/.pi/agent/mcp.json` (global) |
| Connect to a server | `mcp({ connect: "server-name" })` |
| List a server's tools | `mcp({ server: "server-name" })` |
| Search all tools | `mcp({ search: "query" })` |
| Call a tool | `mcp({ tool: "tool_name", args: '{"key": "value"}' })` |
| Open MCP panel | `/mcp` (interactive config UI) |
| Run setup wizard | `/mcp setup` |

## Configuration Files

| File | Purpose |
|------|---------|
| `.mcp.json` | Project config (preferred for project-specific servers) |
| `~/.pi/agent/mcp.json` | Global pi override |
| `.pi/mcp.json` | Pi project override |
| `~/.config/mcp/mcp.json` | Shared MCP config |

**Precedence** (later overrides earlier): `~/.config/mcp/mcp.json` → `~/.pi/agent/mcp.json` → `.mcp.json` → `.pi/mcp.json`

**Start with `.mcp.json` in the project root** — this is the simplest and most portable option.

### Server Schema

```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["./node_modules/some-mcp-server/dist/index.js"],
      "env": {
        "API_KEY": "${MY_API_KEY}"
      },
      "cwd": "/path/to/project",
      "lifecycle": "lazy"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `command` | Executable (node, python3, npx, etc.) |
| `args` | Command arguments |
| `env` | Environment variables — supports `${VAR}` interpolation from shell environment |
| `cwd` | Working directory — supports `~` expansion and `${VAR}` |
| `url` | HTTP endpoint (for StreamableHTTP servers instead of stdio) |
| `headers` | HTTP headers — supports `${VAR}` interpolation |
| `lifecycle` | `"lazy"` (default, start on first call), `"eager"` (start at launch, no reconnect), `"keep-alive"` (start at launch, auto-reconnect) |
| `idleTimeout` | Minutes before idle disconnect (default: 10, global setting) |
| `directTools` | `true`, `["tool_a", "tool_b"]`, or `false` — expose tools directly instead of through `mcp` proxy |
| `excludeTools` | `string[]` — hide specific tools |
| `debug` | Show server stderr (default: false) |

## Finding MCP Servers

### Search npm

```bash
npm search "mcp server" --long  # broad search
npm search "exa mcp"            # targeted search
npm info <package-name>         # check package details
```

### Browse Smithery

https://smithery.ai — directory of MCP servers with one-click install.

### GitHub Search

`mcp-server` + topic keywords.

### Common MCP servers

| Server | Package | Use |
|--------|---------|-----|
| ExaSearch | `exa-mcp-server` | Web search + page fetching |
| Chrome DevTools | `chrome-devtools-mcp` | Browser automation |
| GitHub | `@modelcontextprotocol/server-github` | GitHub API |
| Filesystem | `@modelcontextprotocol/server-filesystem` | File operations |
| PostgreSQL | `@modelcontextprotocol/server-postgres` | Database queries |
| Brave Search | `@anthropic/mcp-server-brave-search` | Web search |

## Installing an MCP Server

### Step 1: Install the package

For project-local (recommended):

```bash
npm install --save-dev <package-name>
# e.g., npm install --save-dev exa-mcp-server@3.2.1
```

Take note of the actual entry point. For npm packages, check the `bin` field:

```bash
grep '"bin"' node_modules/<package>/package.json
```

Or find the actual executable:

```bash
realpath node_modules/.bin/<binary-name>
# e.g., realpath node_modules/.bin/exa-mcp-server
```

### Step 2: Configure `.mcp.json`

Add the server entry. Use absolute paths for the executable:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/pkg/dist/index.js"],
      "lifecycle": "lazy"
    }
  }
}
```

**Alternative — use `npx` for one-off servers** (slower startup, re-downloads each time):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server@latest"],
      "lifecycle": "lazy"
    }
  }
}
```

## Handling API Keys and Secrets

**Critical rule: NEVER read API key files directly.** Key files (e.g., `exa_key`, `.env`, `credentials.json`) should only be referenced by path for configuration — never `cat`'d or `read` for their contents.

### Option A: Wrapper script (recommended for file-based keys)

Create a small shell script that reads the key file at runtime:

```bash
#!/bin/bash
# .pi/<server>-wrapper.sh
export API_KEY=$(cat "$HOME/path/to/key_file")
exec node /absolute/path/to/server.js
```

Then reference it in `.mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "/absolute/path/to/.pi/my-server-wrapper.sh",
      "args": [],
      "lifecycle": "lazy"
    }
  }
}
```

Make the script executable: `chmod +x .pi/<server>-wrapper.sh`

### Option B: Environment variable (for shell-exported keys)

Export the key in your shell and reference it in `.mcp.json`:

```bash
export MY_API_KEY=$(cat ~/path/to/key_file)
```

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": {
        "MY_API_KEY": "${MY_API_KEY}"
      }
    }
  }
}
```

### Option C: User sets it

Tell the user to set the environment variable. The MCP server inherits the shell environment automatically — no `env` field needed in the config.

## Testing the Server

After adding to `.mcp.json`:

1. **Reload pi** — `/reload` or restart
2. **Check it appears** — `mcp({ })` to see server list
3. **Connect** — `mcp({ connect: "server-name" })`
4. **List tools** — `mcp({ server: "server-name" })`
5. **Test a tool** — call a simple tool like a search or status check

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| Server not appearing | Check `.mcp.json` syntax (valid JSON?), absolute paths, `/reload` |
| Server won't connect | Try `command` directly in terminal, check paths, permissions (`chmod +x`) |
| API key not found | Verify key file exists, wrapper script reads correct path, env var is set |
| Tools not loading | Enable `debug: true` in server config, check stderr output |
| Stale tools after update | Delete `~/.pi/agent/mcp-cache.json` and reload |

## Direct Tools

By default, all MCP tools go through the `mcp` proxy. For frequently-used tools, promote them to direct pi tools:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "directTools": ["tool_a", "tool_b"]
    }
  }
}
```

Use `directTools: true` to register ALL tools directly, or `["tool_a"]` for specific ones. Each direct tool costs ~150-300 tokens in context.

## Example: Full Installation Walkthrough

Here's exactly how exasearch was set up for this project:

**1. Found the package:**
```bash
npm search exa mcp  # found exa-mcp-server@3.2.1
```

**2. Installed locally:**
```bash
npm install --save-dev exa-mcp-server@3.2.1
```

**3. Checked entry point:**
```bash
realpath node_modules/.bin/exa-mcp-server
# → $HOME/src/mypi/node_modules/exa-mcp-server/smithery/stdio/index.cjs
```

**4. Created wrapper script** (`.pi/exa-mcp-wrapper.sh`) to read key from file:
```bash
#!/bin/bash
export EXA_API_KEY=$(cat "$HOME/src/mypi/secure_data/exa_key")
exec node $HOME/src/mypi/node_modules/exa-mcp-server/smithery/stdio/index.cjs
```

**5. Made it executable:**
```bash
chmod +x .pi/exa-mcp-wrapper.sh
```

**6. Added to `.mcp.json`:**
```json
{
  "mcpServers": {
    "exasearch": {
      "command": "/home/clemente/src/mypi/.pi/exa-mcp-wrapper.sh",
      "args": [],
      "lifecycle": "lazy"
    }
  }
}
```

**7. Tested:**
```
mcp({ })                          # confirmed exasearch appeared
mcp({ connect: "exasearch" })     # connected, listed tools
mcp({ tool: "exasearch_web_search_exa", args: '{"query": "test"}' })  # works
```

## Python MCP Servers

For Python-based MCP servers (like mempalace):

```json
{
  "mcpServers": {
    "my-python-server": {
      "command": "/path/to/.venv/bin/python3",
      "args": ["-m", "my_package.mcp_server"],
      "cwd": "/path/to/project",
      "lifecycle": "lazy"
    }
  }
}
```

Make sure the virtual environment has the package installed (`pip install my-package`).

## When to Use Each Approach

| Approach | Best for |
|----------|----------|
| Local npm install + absolute path | Project-specific servers, reproducible builds |
| `npx -y <pkg>` | One-off servers, quick experiments |
| Python venv + `-m` module | Python-based servers (databases, tools) |
| HTTP URL (`url` field) | Remote/background MCP servers |
| Wrapper script | Servers needing API keys from files (keeps secrets out of `.mcp.json`) |
