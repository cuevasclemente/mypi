---
name: pi-agent-teams-extension-debugging
description: "Debug and repair pi/mypi agent-teams subagent spawning failures, especially in Wayang-hosted sessions: reproduce subagent smoke failures, diagnose Node unhandled errors/EADDRINUSE from wrong entrypoints, patch source and installed extension copies, validate direct pi JSON-mode execution, and document reload requirements."
---

# Pi Agent Teams Extension Debugging

Use this skill when `subagent_spawn`, `subagent_dispatch`, or agent-team workflows fail locally, return no output, or emit Node process errors. It is especially relevant when failures occur inside Wayang sessions but not in a direct terminal pi run.

## Setup

Relevant locations:

- Source extension repo: `~/src/mypi/plugins/agent-teams/`
- Active installed extension: `~/.pi/agent/extensions/agent-teams/`
- Pi package/runtime docs: `/usr/lib/node_modules/pi/packages/coding-agent/`
- Wayang backend, if involved: `~/src/wayang/backend/`
- Journals for mypi work: `~/src/mypi/docs/journals/`

When changing personal pi extensions, keep runtime surfaces aligned in the same session:

1. Update `~/src/mypi` source.
2. Update/install `~/.pi/agent/extensions/` active runtime copy.
3. If behavior depends on Wayang bridge/session mapping, update `~/src/wayang` too.
4. Validate syntax/bundling and note that live sessions may require `/reload` or restart.

Do not read command-guard PIN files, OAuth tokens, or other secrets.

## Workflow

### 1. Reproduce with a tiny subagent smoke

Start with the smallest possible request:

```text
subagent_dispatch({
  name: "SubagentSmoke",
  system_prompt: "You are a minimal smoke-test worker. Reply with exactly: smoke-ok. Do not use tools.",
  task: "Return the required smoke string.",
  tools: ""
})
```

If dispatch/spawn returns no output, check whether the failure is session-local or runtime-wide:

```bash
pi --mode json <<'EOF'
{"messages":[{"role":"user","content":"Reply exactly smoke-ok"}]}
EOF
```

A direct `pi --mode json` success plus Wayang subagent failure points to extension invocation/embedding, not the model itself.

### 2. Look for wrong entrypoint symptoms

A known failure mode in Wayang-hosted sessions:

- The extension reuses `process.argv[1]` as the subagent executable entrypoint.
- In Wayang, `process.argv[1]` can be backend `dist/index.js`, not the pi CLI.
- Subagent spawn accidentally runs a second Wayang backend, producing `EADDRINUSE` on the Wayang port (for example `127.0.0.1:8787`).

Confirm the port owner without killing anything:

```bash
ss -ltnp | grep ':8787'
```

Search source for entrypoint selection:

```bash
rg -n "process\.argv\[1\]|subagent|spawn|--mode json|EADDRINUSE|8787" \
  ~/src/mypi/plugins/agent-teams ~/.pi/agent/extensions/agent-teams ~/src/wayang/backend \
  -g '!**/node_modules/**'
```

### 3. Patch entrypoint selection defensively

The robust rule is:

- Reuse `process.argv[1]` only when it clearly looks like a pi entrypoint.
- Otherwise invoke `pi` from `PATH` or a configured pi binary.
- Do not assume embedded hosts such as Wayang have the same argv as direct pi.

Pseudo-pattern:

```ts
function looksLikePiEntrypoint(argv1: string | undefined): boolean {
  if (!argv1) return false;
  return /(^|[/\\])(pi|pi\.js|cli\.js|index\.js)$/.test(argv1) && !argv1.includes("wayang");
}

const command = looksLikePiEntrypoint(process.argv[1]) ? process.execPath : "pi";
const args = looksLikePiEntrypoint(process.argv[1])
  ? [process.argv[1], "--mode", "json"]
  : ["--mode", "json"];
```

Adapt to the actual codebase. Keep the patch narrow and explain the embedding assumption in comments.

### 4. Sync source and active installed copies

After editing `~/src/mypi/plugins/agent-teams/...`, mirror the same change to `~/.pi/agent/extensions/agent-teams/...` unless using an installer that does so.

Validate equality for the touched files:

```bash
cmp -s ~/src/mypi/plugins/agent-teams/subagent-runner.ts \
  ~/.pi/agent/extensions/agent-teams/subagent-runner.ts && echo runner-synced
cmp -s ~/src/mypi/plugins/agent-teams/subagent-manager.ts \
  ~/.pi/agent/extensions/agent-teams/subagent-manager.ts && echo manager-synced
```

### 5. Validate without relying on the broken live session

Use direct pi and build checks first:

```bash
pi --mode json <<'EOF'
{"messages":[{"role":"user","content":"Reply exactly smoke-ok"}]}
EOF

cd ~/src/mypi
npm run build  # or the project-specific extension build/check command
```

If the extension is TypeScript-only and loaded by pi directly, run the repo's extension validation/bundling command or add a temporary smoke script. Keep temporary files only if they are useful; otherwise remove with `safe-delete` after explicit/clear authorization.

If Wayang was touched or the extension behavior depends on Wayang session mapping:

```bash
cd ~/src/wayang/backend && npm run build
cd ~/src/wayang/frontend && npm run build
```

### 6. Reload caveat

Active Wayang/pi sessions may keep the old extension code loaded. After patching installed files:

- Tell Clemente to use `/reload`, start a fresh pi session, or restart Wayang backend as appropriate.
- Do not claim in-session `subagent_dispatch` is fixed until tested in a process that loaded the new extension.

### 7. Journal the fix

For meaningful extension repairs, record:

- Symptom and reproduction command.
- Root cause, including actual wrong entrypoint/port if found.
- Files changed in source and installed runtime.
- Validation commands and results.
- Reload/restart requirement.

Example summary:

> Root cause: agent-teams reused Wayang backend `process.argv[1]` (`dist/index.js`), spawning a second backend and hitting `127.0.0.1:8787 EADDRINUSE`. Patched source and installed extension to reuse argv only for pi entrypoints; otherwise call `pi` from PATH. Direct `pi --mode json` smoke passed; current live session needs reload.

## Common decisions

- **Direct pi smoke fails too:** debug model/provider/auth/pi runtime first, not Wayang embedding.
- **Direct pi smoke passes, subagent fails only in Wayang:** inspect extension argv/env/cwd/session mapping.
- **Installed copy differs from mypi:** sync before testing; pi loads installed extensions, not necessarily source.
- **Smoke passes in new terminal but fails in current chat:** likely live extension cache; reload/restart.
