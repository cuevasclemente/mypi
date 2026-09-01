---
name: session-coordinator-extension
description: Operate the session-coordinator Pi extension that lets independent sessions in the same Git project coordinate through presence, messages, and advisory claims. Use when multiple Pi or Wayang sessions need to coordinate without a parent/subagent relationship.
---

# Session Coordinator Extension

The `session-coordinator` extension provides repository-local coordination without copying conversation transcripts. It records bounded session metadata, short messages, and advisory claims under the canonical Git project's `.pi/coordination/` directory.

## Install or update

From the canonical `mypi` source checkout:

```bash
make user-install PLUGINS=session-coordinator MODE=copy
```

Restart Pi or reload extensions after installation. The installed directory must contain at least `index.ts`, `core.ts`, and `README.md`.

Run the focused source test before distribution:

```bash
node /path/to/tsx/dist/cli.mjs --test tests/session-coordinator.test.ts
```

Use the repository's installed `tsx` executable; do not download tooling implicitly.

## Activation model

Coordination is tool-first. `/coord enable` remains a human convenience, not an authority requirement.

- `session_coordination({action: "ensure"})` idempotently joins or creates the canonical project room.
- `session_coordination({action: "enable", projectRoot: "/absolute/canonical/path"})` explicitly creates or joins at a validated project root.
- On `session_start` and before later agent turns, an inactive session performs non-creating discovery and joins an already-existing room.
- Linked Git worktrees resolve to the common main Git project root, so sibling sessions share one room and logical relative-path claims overlap correctly.
- Explicit `/coord disable` stops automatic rejoin for that extension instance until it is deliberately enabled again.

Activation is per extension instance. Independent Wayang/Pi sessions must never share an in-memory lease, heartbeat timer, or disable state.

## Agent tool

The `session_coordination` tool supports:

- `enable` — requires an absolute canonical `projectRoot`; explicitly create/join.
- `ensure` — return the current activation, join an existing room, or explicitly create at the canonical project root.
- `status` — show bounded active peers, messages, and claims.
- `announce` — set this session's short work summary.
- `post` — send a short room message.
- `claim` — claim a path, glob, task, or other resource with intent and optional TTL.
- `release` — release one of the caller's claims by claim ID.
- `history` — read bounded recent coordination history.

Examples:

```typescript
session_coordination({ action: "ensure" })
session_coordination({ action: "announce", summary: "reviewing the API migration" })
session_coordination({
  action: "claim",
  resource: "src/api",
  kind: "path",
  intent: "refactoring route handlers",
  ttlSeconds: 1800,
})
session_coordination({ action: "post", message: "API migration is ready for review" })
session_coordination({ action: "release", claimId: "claim-id-from-tool-result" })
```

Returned activation details are structured and bounded: whether the room is active/created/joined, canonical project and room paths, and an opaque lease identity. Tool output is capped below Pi's response-size ceiling.

## Human commands

- `/coord enable [absolute-project-root]`
- `/coord disable`
- `/coord status`
- `/coord announce <summary>`
- `/coord note <message>`

Prefer the tool for agent workflows.

## Claims and coordination etiquette

Claims are advisory, not filesystem locks.

1. Call `status` or `ensure` before broad overlapping work.
2. Announce a concise scope.
3. Claim only the bounded path/task you intend to modify.
4. If another active claim overlaps, coordinate rather than assuming exclusion.
5. Post material blockers or integration handoffs, not narration.
6. Release completed or abandoned claims.

Path claims inside linked worktrees use common-root logical keys. Resources outside the checkout retain canonical physical paths.

## Privacy and security boundaries

- Never put secrets, credentials, transcript excerpts, or sensitive personal data in summaries, messages, claims, or labels.
- Coordination files contain bounded metadata only; the extension does not read or copy transcript contents.
- `piSessionFile` may identify a session file for local navigation, but its contents are never copied.
- Room markers and leases are validated. Missing/replaced rooms deactivate old writers; steady-state heartbeats and log writes must not recreate deleted rooms.
- Log files must be regular, non-symlink files. Claims cannot be released by another lease.
- `.git` pointers are accepted only when they form a structurally valid linked-worktree relationship; crafted pointers must not redirect coordination writes.
- Messages and claims are append-only audit records. Deactivation marks a lease inactive rather than erasing history.

## Troubleshooting

### Tool says coordination is inactive

Call:

```typescript
session_coordination({ action: "ensure" })
```

If a room was created by another session after this session started, the next agent turn should also discover and join it automatically.

### Sessions in linked worktrees do not see each other

Verify both installed copies contain the same reviewed `index.ts` and `core.ts`, then reload both sessions. Each should report the same canonical project root and room ID.

### Room was deliberately removed

Old heartbeat writers must remain inactive and must not recreate it. A new room appears only after an explicit `ensure`, `enable`, or `/coord enable`.

### An installed runtime behaves differently from source

Compare file hashes without printing contents, reinstall with `make user-install PLUGINS=session-coordinator MODE=copy`, then reload. Keep a backup of the previous installed directory before replacement.
