---
name: session-coordinator-extension
description: Operate the session-coordinator pi extension that lets independent pi sessions in the same project coordinate via filesystem-backed presence, messages, and claims. Use when multiple pi sessions need to coordinate work without being subagents.
---

# Session Coordinator Extension

The `session-coordinator` pi extension enables independent pi sessions running in the same project to coordinate work through filesystem-backed presence leases, broadcast messages, and advisory resource claims — without requiring subagent/parent relationships.

## Installation

The extension is distributed via `~/src/mypi` and installed to `~/.pi/agent/extensions/`:

```bash
# Install from mypi source repo
cd ~/src/mypi
make install-plugin PLUGIN=session-coordinator

# Verify installation
ls -la ~/.pi/agent/extensions/session-coordinator/
# Should contain: index.ts, README.md
```

Pi automatically loads extensions from `~/.pi/agent/extensions/` on startup.

## Concepts

### Coordination Room

A **coordination room** is a project-local directory `.pi/coordination/` that acts as a shared coordination area for all pi sessions operating under that directory tree.

- **Opt-in**: rooms are created explicitly via `/coord enable` or by starting pi in a tree that already contains `.pi/coordination/`.
- **Discovery**: on `session_start`, pi walks upward from `ctx.cwd` looking for `.pi/coordination/` and auto-joins if found.
- **Scope**: all sessions under the same coordination root share the same room.

### Session Presence Lease

Each active session writes a **presence lease** file to `.pi/coordination/sessions/<session-token>.json`:

```json
{
  "version": 1,
  "token": "host-pid-sessionId-random",
  "pid": 12345,
  "host": "narwhal",
  "cwd": "/path/to/project/subdir",
  "piSessionId": "session-abc123",
  "piSessionFile": "/home/user/.pi/sessions/session-abc123.jsonl",
  "surface": "tui|wayang|rpc|unknown",
  "label": "optional session name",
  "status": "active|inactive",
  "summary": "working on feature X refactor",
  "heartbeatAt": "2026-05-14T12:34:56.789Z",
  "createdAt": "2026-05-14T12:00:00.000Z",
  "updatedAt": "2026-05-14T12:34:56.789Z"
}
```

**Lifecycle:**
- Written on `session_start` with `status: active`.
- Updated every ~15 seconds with fresh `heartbeatAt` timestamp.
- Marked `status: inactive` on clean `session_shutdown`.
- Treated as **stale** by other sessions if no heartbeat for >90 seconds (indicates crash or hang).

### Messages

**Room messages** are broadcast coordination notes stored in `.pi/coordination/messages.jsonl`:

```jsonl
{"version":1,"id":"msg-uuid","type":"message","sessionToken":"token","sessionLabel":"Session A","text":"Starting API refactor","createdAt":"2026-05-14T...Z"}
```

Messages are append-only and visible to all active sessions in the room.

### Claims

**Claims** are advisory declarations of intent to work on a resource (path, glob, task, or other). Stored in `.pi/coordination/claims.jsonl`:

```jsonl
{"version":1,"id":"claim-uuid","type":"claim","sessionToken":"token","sessionLabel":"Session A","resource":"src/api","resourceKey":"/abs/path/to/src/api","kind":"path","intent":"refactoring API handlers","createdAt":"2026-05-14T...Z","expiresAt":"2026-05-14T...Z"}
{"version":1,"id":"release-uuid","type":"release","sessionToken":"token","claimId":"claim-uuid","createdAt":"2026-05-14T...Z"}
```

**Claim kinds:**
- `path` — file or directory (absolute path normalized for overlap detection)
- `glob` — pattern like `*.test.ts`
- `task` — logical task like "database migration"
- `other` — arbitrary string resource

**Semantics:**
- Claims are **advisory only** in v1; the extension warns about overlaps but does not block file operations.
- Overlap detection for `path` claims checks parent/child relationships (e.g., claiming `/src` overlaps `/src/api/routes.ts`).
- Claims can have optional TTL (`expiresAt`); expired claims are filtered from active list.
- Release by `claimId` or by `resource` (releases all claims for that resource from the releasing session).

### Heartbeat and Stale Detection

- Active sessions update their lease every 15 seconds.
- Other sessions consider a lease **stale** if `heartbeatAt` is older than 90 seconds.
- Stale leases are excluded from active peer lists but remain in the room for audit/debugging.

### Privacy

- Presence files contain **metadata only**: working directory, session identifier, surface (TUI/Wayang/RPC), summary, heartbeat timestamp.
- **No conversation transcripts** are copied to coordination files.
- `piSessionFile` path is recorded for debugging/navigation but the JSONL content is not read or copied.
- Never store secrets or API keys in coordination files.

## Commands

Session-coordinator registers `/coord` slash commands:

### `/coord enable [project-root]`

Create or join a coordination room at `.pi/coordination/`.

- If `project-root` is provided, creates/joins under that path.
- If omitted, uses git root (via `.git` discovery) or current working directory.
- Creates `.pi/coordination/` structure and writes active presence lease.
- Starts heartbeat timer.

**Example:**
```
/coord enable
/coord enable ~/src/myproject
```

### `/coord disable`

Mark this session's presence as inactive and stop heartbeating.

- Sets `status: inactive` in the session lease file.
- Stops the heartbeat timer.
- Clears UI status/widget.
- Does **not** delete the presence file (leaves audit trail).

### `/coord status`

Show current room state: active peers, recent messages, and active claims.

Opens a temporary UI view (TUI/Wayang) or returns formatted text output (RPC).

**Output includes:**
- Room directory
- This session's token and label
- Active peer sessions with cwd and summary
- Active claims (who, what, intent)
- Recent room messages

### `/coord announce <summary>`

Update this session's working summary.

**Example:**
```
/coord announce refactoring API handlers in src/api
```

Equivalent to `session_coordination announce` tool action.

### `/coord note <message>`

Post a broadcast room message.

**Example:**
```
/coord note Found blocker: database schema migration needed before API work
```

Equivalent to `session_coordination post` tool action.

## Agent Tool: `session_coordination`

The extension registers a `session_coordination` tool with these actions:

### `status`

List active peers, recent messages, and active claims.

**Parameters:**
- `action: "status"` (required)
- `limit?: number` — max messages/claims to return (default 20)

**Returns:**
```
Coordination room: /path/to/project/.pi/coordination
This session: Session A (host-1234-abc)

Active peers (2):
- Session B [wayang] cwd=src/frontend summary=building new UI component
- Session C [tui] cwd=tests summary=writing integration tests

Active claims (1):
- claim-abc: Session B claims path:src/api/routes.ts — refactoring route handlers

Recent messages (3):
- [2026-05-14T12:00:00.000Z] Session B: starting API work
- [2026-05-14T12:05:00.000Z] Session C: tests passing after DB change
- [2026-05-14T12:10:00.000Z] Session B: refactor complete, running tests
```

### `announce`

Update this session's current-work summary.

**Parameters:**
- `action: "announce"` (required)
- `summary: string` — short description of current work
- `message?: string` — fallback if `summary` not provided

**Example:**
```typescript
session_coordination({
  action: "announce",
  summary: "refactoring authentication middleware"
})
```

### `post`

Post a broadcast coordination message to the room.

**Parameters:**
- `action: "post"` (required)
- `message: string` — message text

**Example:**
```typescript
session_coordination({
  action: "post",
  message: "Database migration ready for review"
})
```

### `claim`

Claim a resource (path, glob, task, other) with intent.

**Parameters:**
- `action: "claim"` (required)
- `resource: string` — the resource to claim
- `kind?: "path"|"glob"|"task"|"other"` — resource type (default: `path`)
- `intent?: string` — why you're claiming this (default: `"working here"`)
- `message?: string` — fallback for intent
- `ttlSeconds?: number` — optional expiration time in seconds

**Returns:**
- Claim ID
- Conflict warnings if overlapping claims exist

**Examples:**
```typescript
// Claim a directory
session_coordination({
  action: "claim",
  resource: "src/api",
  kind: "path",
  intent: "refactoring route handlers"
})

// Claim with relative path (resolved from current cwd)
session_coordination({
  action: "claim",
  resource: "./components/Auth.tsx",
  kind: "path",
  intent: "fixing auth bug"
})

// Claim a logical task
session_coordination({
  action: "claim",
  resource: "database-migration-v2",
  kind: "task",
  intent: "running schema migration",
  ttlSeconds: 3600  // 1 hour
})
```

**Path overlap detection:**
- Claiming `/src` while another session claims `/src/api/routes.ts` → overlap warning
- Claiming `/src/api/routes.ts` while another session claims `/src` → overlap warning
- Claiming `/src/api` and `/tests` → no overlap

### `release`

Release a claim by ID or resource.

**Parameters:**
- `action: "release"` (required)
- `claimId?: string` — specific claim ID to release
- `resource?: string` — release all claims for this resource (by this session)
- `kind?: "path"|"glob"|"task"|"other"` — resource type if releasing by resource

**Examples:**
```typescript
// Release by claim ID
session_coordination({
  action: "release",
  claimId: "claim-abc123"
})

// Release all claims for a resource
session_coordination({
  action: "release",
  resource: "src/api",
  kind: "path"
})
```

### `history`

Show recent room history (messages and claims).

**Parameters:**
- `action: "history"` (required)
- `limit?: number` — max records to return (default 20)

**Returns:**
- Formatted room history with messages and claims

## Runtime Files

```
.pi/coordination/
├── room.json                          # room metadata
├── sessions/
│   ├── <session-token-1>.json        # active/inactive session presence
│   ├── <session-token-2>.json
│   └── ...
├── messages.jsonl                     # append-only message log
└── claims.jsonl                       # append-only claim/release log
```

### `room.json`

Created when room is initialized:
```json
{
  "version": 1,
  "id": "room-uuid",
  "createdAt": "2026-05-14T..."
}
```

### Session lease files

One per active/inactive session in `sessions/<token>.json`. See **Session Presence Lease** concept above.

### `messages.jsonl`

Append-only log of broadcast messages. Each line is a JSON record:
```json
{"version":1,"id":"msg-uuid","type":"message","sessionToken":"token","sessionLabel":"Session A","text":"message content","createdAt":"2026-05-14T...Z"}
```

### `claims.jsonl`

Append-only log of claims and releases:
```json
{"version":1,"id":"claim-uuid","type":"claim","sessionToken":"token","sessionLabel":"Session A","resource":"src/api","resourceKey":"/abs/path","kind":"path","intent":"refactoring","createdAt":"2026-05-14T...Z"}
{"version":1,"id":"release-uuid","type":"release","sessionToken":"token","claimId":"claim-uuid","createdAt":"2026-05-14T...Z"}
```

Active claims are computed by:
1. Reading all claim/release records
2. Building a map of active claims
3. Removing claims that have been released or expired
4. Filtering out claims from stale sessions

## Workflow Examples

### Starting coordinated work

```bash
# Session A (TUI)
cd ~/src/myproject
pi
/coord enable

# Session opens and auto-joins coordination room
```

Agent in Session A:
```typescript
// Check for other active sessions before starting broad refactor
session_coordination({ action: "status" })

// Announce scope
session_coordination({
  action: "announce",
  summary: "refactoring authentication middleware in src/auth"
})

// Claim the directory
session_coordination({
  action: "claim",
  resource: "src/auth",
  kind: "path",
  intent: "refactoring authentication flow"
})

// ... do the work ...

// Release claim when done
session_coordination({
  action: "release",
  resource: "src/auth",
  kind: "path"
})
```

### Coordinating overlapping work

Session B starts while Session A is working:

```typescript
// Session B agent checks status
session_coordination({ action: "status" })

// Returns:
// Active peers (1):
// - Session A [tui] cwd=src summary=refactoring authentication middleware
// Active claims (1):
// - claim-abc: Session A claims path:src/auth — refactoring authentication flow

// Session B claims a different area
session_coordination({
  action: "claim",
  resource: "src/api",
  kind: "path",
  intent: "adding new API endpoints"
})
// No overlap warning, proceeds safely
```

If Session B tries to claim overlapping path:

```typescript
session_coordination({
  action: "claim",
  resource: "src/auth/middleware.ts",  // inside claimed src/auth
  kind: "path",
  intent: "fixing middleware bug"
})

// Returns:
// Claimed path:src/auth/middleware.ts — fixing middleware bug
// Claim id: claim-xyz
//
// Potential overlap with other active claims:
// - Session A claims path:src/auth — refactoring authentication flow
```

Session B should coordinate:
```typescript
session_coordination({
  action: "post",
  message: "Need to fix middleware bug in src/auth/middleware.ts — Session A, can you coordinate?"
})
```

### Multi-project usage

Each project can have its own coordination room:

```
~/src/project-a/.pi/coordination/    # Room A
~/src/project-b/.pi/coordination/    # Room B
```

Sessions under `project-a/` join Room A, sessions under `project-b/` join Room B.

## Agent Prompt Injection

When coordination is active and there are active peers, claims, or unread messages, the extension injects a compact block into the agent's system prompt via `before_agent_start`:

```markdown
## Cross-session coordination
You are in coordination room /path/to/project/.pi/coordination.
Other active pi sessions:
- Session B (wayang, cwd=src/frontend): building new UI component
- Session C (tui, cwd=tests): writing integration tests
Active claims by other sessions:
- Session B claims path:src/api/routes.ts — refactoring route handlers
Recent coordination messages from other sessions:
- [2026-05-14T12:00:00.000Z] Session B: starting API work
Guideline: use the session_coordination tool before broad edits, claim files/tasks you intend to modify, and post updates when your work may overlap or help another session.
```

This keeps the agent aware of other active work without excessive token cost.

## UI Surface

### TUI / Wayang Status Bar

When coordination is active:
```
🤝 2 peers · 1 unread · 3 claims
```

### Widget

Compact view of active peers and their summaries:
```
🤝 Coordination  2 peers · 1 unread · 3 claims
  Session B: refactoring authentication middleware
  Session C: writing integration tests
  claim Session B → src/auth
```

### Notifications

- New peer joins the room
- New message posted
- Overlapping claim detected

## Best Practices

### Before broad edits or refactors

Always check coordination status first:

```typescript
session_coordination({ action: "status" })
```

Look for:
- Active peers working in related areas
- Claims on files/directories you plan to modify
- Recent messages about blockers or ongoing work

### Announce your scope

When starting significant work:

```typescript
session_coordination({
  action: "announce",
  summary: "refactoring authentication system in src/auth"
})
```

This helps other sessions understand what you're doing before they start overlapping work.

### Claim before modifying

Claim paths/tasks before making changes:

```typescript
// Before editing src/api/routes.ts
session_coordination({
  action: "claim",
  resource: "src/api",
  kind: "path",
  intent: "refactoring route handlers"
})
```

If you get overlap warnings, coordinate via messages.

### Post discoveries and blockers

Share findings that might help or block other sessions:

```typescript
session_coordination({
  action: "post",
  message: "Found bug in authentication middleware — fixing now before continuing API work"
})
```

### Release claims when done

Clean up claims after completing work:

```typescript
session_coordination({
  action: "release",
  resource: "src/api",
  kind: "path"
})
```

Or release by claim ID if you have it.

### On session end

If you're finishing a coordinated session, announce completion or hand off:

```typescript
session_coordination({
  action: "announce",
  summary: "authentication refactor complete, all tests passing"
})

session_coordination({
  action: "post",
  message: "Refactor complete — safe to merge auth-refactor branch"
})
```

Then either `/coord disable` or let normal shutdown mark your presence inactive.

## Troubleshooting

### Stale session cleanup

**Symptom:** Old sessions appear in `status` output even though they're not running.

**Cause:** Process crashed or was killed without clean shutdown.

**Detection:** Sessions with `heartbeatAt` older than 90 seconds are automatically filtered from active peer lists.

**Manual cleanup:**
```bash
# Remove old inactive lease files
cd .pi/coordination/sessions
rm <stale-token>.json
```

Or wait — stale leases are excluded from active views but preserved for audit.

### Room not auto-joining

**Symptom:** New session doesn't join existing coordination room.

**Check:**
1. Does `.pi/coordination/` exist in the project tree?
   ```bash
   find . -name coordination -type d
   ```
2. Is the session starting under the coordination root?
   ```bash
   # From session
   /coord status
   # Should show room or "not active"
   ```

**Fix:**
```bash
/coord enable
```

### Overlapping claims not detected

**Symptom:** Claiming a path doesn't show overlap warning.

**Check claim kinds:** Path overlap detection only works for `kind: "path"`. Verify:
```typescript
session_coordination({ action: "status" })
// Look at claim kinds in output
```

**Check absolute vs relative paths:** Path normalization resolves relative paths from current `ctx.cwd`. If two sessions are in different directories, the absolute paths might differ:

Session A at `/home/user/project`:
```typescript
session_coordination({ action: "claim", resource: "src/api", kind: "path" })
// Normalized to /home/user/project/src/api
```

Session B at `/home/user/project/src`:
```typescript
session_coordination({ action: "claim", resource: "api", kind: "path" })
// Normalized to /home/user/project/src/api — overlap detected
```

### Multi-project coordination conflicts

**Symptom:** Sessions from different projects showing up in the same room.

**Cause:** Both projects share a parent directory with `.pi/coordination/`.

**Fix:** Each project should have its own coordination root:
```bash
# Project A
cd ~/src/project-a
/coord enable

# Project B
cd ~/src/project-b
/coord enable
```

This creates:
- `~/src/project-a/.pi/coordination/`
- `~/src/project-b/.pi/coordination/`

Sessions will auto-join the nearest coordination root when walking upward from `ctx.cwd`.

### Room reset

**Symptom:** Room state is corrupted or full of old messages/claims.

**Nuclear option:**
```bash
# Stop all active sessions in this project first
# Then remove coordination directory
rm -rf .pi/coordination

# Re-enable
/coord enable
```

**Surgical cleanup:**
```bash
# Clear old messages (keeps room structure)
> .pi/coordination/messages.jsonl

# Clear old claims
> .pi/coordination/claims.jsonl

# Remove inactive session leases
rm .pi/coordination/sessions/*.json
# (active sessions will recreate on next heartbeat)
```

### Extension not loading

**Check installation:**
```bash
ls -la ~/.pi/agent/extensions/session-coordinator/
# Should show: index.ts, README.md
```

**Reinstall:**
```bash
cd ~/src/mypi
make install-plugin PLUGIN=session-coordinator
```

**Check pi extension logs:**
Pi prints extension load messages on startup. Look for:
```
Loaded extension: session-coordinator
```

If not present, check for TypeScript errors or missing dependencies.

## Source and Documentation

- **Source:** `~/src/mypi/plugins/session-coordinator/`
- **Installation:** `~/src/mypi/Makefile` (target: `install-plugin`)
- **Plan:** `~/src/mypi/docs/plans/cross-session-coordination.md`
- **Build journal:** `~/src/mypi/docs/journals/2026-05-14-cross-session-coordination.md`
- **Installed location:** `~/.pi/agent/extensions/session-coordinator/`
- **README:** `~/src/mypi/plugins/session-coordinator/README.md`

## Future Enhancements

Likely v2 features based on real-world usage:

- **Direct messages:** Target a specific session instead of broadcast
- **Mentions:** Notify a session when mentioned in a message
- **Write-tool hooks:** Optional warnings/blocks when writing to claimed paths
- **Garbage collection:** Auto-remove old inactive leases and trim JSONL logs
- **Web UI:** Wayang-native coordination dashboard
- **Claim escalation:** Convert advisory claims to advisory+notify or blocking modes
