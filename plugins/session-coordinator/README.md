# session-coordinator

Filesystem-backed, advisory coordination for independent Pi and Wayang sessions.

The extension is **tool-first**: an agent can activate coordination with the
`session_coordination` tool, without requiring a user to type a slash command.
Each loaded extension factory owns its own lease, heartbeat timer, and discovery
state, so multiple Wayang sessions in one process do not overwrite one another.

## Activation

The tool exposes two activation actions:

- `ensure` — idempotently keep the current lease active; otherwise join an
  existing room or create the canonical room for the current project. This is
  the normal agent-callable action.
- `enable` — create or join using an explicit absolute, normalized, real
  `projectRoot` supplied or confirmed by the user. In a Git checkout, a path
  inside either the main or a linked worktree resolves to the repository's
  common/main root.

Examples:

```typescript
session_coordination({ action: "ensure" })
session_coordination({ action: "enable", projectRoot: "/absolute/canonical/project/path" })
```

Activation returns structured details containing `active`, `outcome`,
`created`, `joined`, `projectRoot`, `roomDir`, and `leaseId`. Repeated `ensure`
calls preserve the same lease and heartbeat rather than creating duplicates.
Invalid, relative, non-existent, or symbolic-link-aliased explicit roots are
rejected.

### Automatic discovery

Discovery runs at session startup and again immediately before each agent run.
The second check matters for long-lived Wayang sessions: if another session
creates the room after this session started, this session joins before its next
model call and receives current peer/claim/message context. Discovery only
joins a room with a valid `room.json` marker and existing `sessions/` directory;
it does not create or repair room structure.

`/coord disable` marks the lease inactive, stops its heartbeat, clears its UI,
and suppresses automatic re-joining for the rest of that extension runtime.
`/coord ensure` or `/coord enable` opts in again.

## Git worktrees

A Git repository has one coordination room at its **common/main checkout root**:

```text
/path/to/main-checkout/.pi/coordination/
```

Synthetic `.git` directory and `.git` file/`commondir` discovery lets the main
checkout and linked worktrees converge on that room even when worktrees are
siblings. Linked metadata is accepted only when the private git directory is a
direct child of the common `.git/worktrees/` directory and its `gitdir` backlink
names the discovering worktree's exact `.git` marker; crafted pointers otherwise
fail closed to the local checkout. A common-root room takes precedence over a
legacy room found in one linked worktree. Path claims inside a worktree are
keyed by their equivalent common-root-relative repository path, so `src/a.ts`
overlaps across sibling
worktrees; paths outside a worktree retain their physical absolute key.

Coordination claims remain advisory. Concurrent implementation sessions should
still use separate Git worktrees and branches; sharing a room does not make it
safe to share a working tree, index, or branch.

## Agent tool

`session_coordination` actions:

- `ensure` — discover or create the canonical project room; idempotent.
- `enable` — activate with explicit `projectRoot` approval.
- `status` — list active peers, recent messages, and active claims.
- `announce` — update this lease's short current-work `summary`.
- `post` — append a bounded broadcast `message`.
- `claim` — claim a `path`, `glob`, `task`, or `other` resource with an intent
  and optional TTL.
- `release` — release one of this session's claims by id or resource.
- `history` — show bounded recent room history.

History requests return at most 50 messages and 50 active claims. Every tool
result independently keeps both its text content and serialized details below
48 KiB (and therefore below both decimal 50 KB and Pi's 50 KiB tool-output
ceiling), truncating aggregate
history/conflict data when necessary.

Recommended flow:

```typescript
session_coordination({ action: "ensure" })
session_coordination({ action: "status" })
session_coordination({ action: "announce", summary: "repairing auth tests" })
session_coordination({ action: "claim", resource: "tests/auth", kind: "path", intent: "repairing auth tests" })
// work
session_coordination({ action: "release", resource: "tests/auth", kind: "path" })
```

Never place secrets, credentials, transcript contents, or sensitive user data in
coordination summaries, messages, claims, or resource names.

## Commands

Slash commands remain as user-facing conveniences:

```text
/coord ensure                  Discover/create the canonical project room
/coord enable [project-root]   User-approved create/join (defaults to Git common root or cwd)
/coord disable                 Leave and suppress auto-discovery for this runtime
/coord status                  Show peers, messages, and claims
/coord announce <summary>      Update this session's working summary
/coord note <message>          Post a room message
```

## Lifecycle and stale leases

- A successful join writes one active lease and starts one heartbeat timer.
- Repeated activation refreshes that lease without adding timers.
- Switching rooms first stages and atomically publishes a writable destination
  lease. Only then is the old lease marked inactive; a destination write failure
  leaves the old lease and its existing heartbeat timer untouched.
- Concurrent first activations publish `room.json` with a non-overwriting atomic
  link, so every contender joins the single winning room identity.
- Reload, session replacement, and process shutdown run `session_shutdown`,
  stop the timer, and best-effort mark the lease inactive.
- Each activation records the room ID from `room.json`. Steady-state lease and
  log writes validate that ID and refuse to write if the room is missing,
  malformed, or replaced.
- Heartbeat, touch, log append, and shutdown paths never recreate missing room
  parents. Only explicit `ensure` or `enable` activation may create missing room
  structure; an existing invalid or non-regular `room.json` is never overwritten.
- If the room disappears or becomes unwritable, timer/shutdown cleanup does not
  crash the Pi host; peers age the last lease out after the stale timeout.
- Crashed processes cannot mark their lease inactive, so peers exclude leases
  whose heartbeat is older than 90 seconds.

## Runtime files

```text
.pi/coordination/
  room.json
  sessions/<lease-id>.json
  messages.jsonl
  claims.jsonl
```

Presence contains bounded metadata such as host, process id, working directory,
surface, label, summary, status, and timestamps. When Pi's session manager safely
provides them, the lease also records a bounded `piSessionId` and an absolute,
normalized, bounded `piSessionFile`; these fields are omitted for ephemeral,
unavailable, malformed, or oversized values. Conversation transcripts are not
read or copied. Append logs must be regular files: symbolic links, directories,
devices, and other non-regular targets are rejected.

## Prompt and UI behavior

Before an agent run, an active room with relevant peer activity contributes a
compact system-prompt block containing active peers, other sessions' claims,
and recent messages. The prompt reminds the agent that claims are advisory and
that concurrent Git work should use separate worktrees/branches.

Interactive surfaces also show a compact status/widget. RPC/JSON/print modes do
not depend on UI methods; tool results contain both readable text and structured
details.

## Focused validation

From the `mypi` repository:

```bash
node /usr/lib/node_modules/pi/node_modules/tsx/dist/cli.mjs --test tests/session-coordinator.test.ts
pi -e ./plugins/session-coordinator/index.ts
```

The synthetic test suite uses temporary repositories/worktrees and fake clocks
and schedulers; it does not mutate a real checkout or require `git` execution.
