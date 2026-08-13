# session-coordinator

Filesystem-backed coordination for independent pi sessions.

When a project contains `.pi/coordination/`, every active pi session that starts under that project joins the same room. Each session writes a heartbeat lease file under `.pi/coordination/sessions/`; on clean shutdown the lease is marked inactive, and crashed sessions become stale after the heartbeat timeout.

## Commands

```text
/coord enable [project-root]   Create/join .pi/coordination/ (defaults to git root or cwd)
/coord disable                 Mark this session inactive in the room
/coord status                  Show peers, messages, and claims
/coord announce <summary>      Update this session's working summary
/coord note <message>          Post a room message
```

## Agent tool

The extension registers `session_coordination` with actions:

- `status` — list active peers, recent messages, and active claims.
- `announce` — update this session's current-work summary.
- `post` — append a broadcast coordination message.
- `claim` — claim a path/glob/task/other resource with an intent and optional TTL.
- `release` — release a claim by id or resource.
- `history` — show recent room history.

Claims are advisory in v1. The tool reports overlaps but does not block edits or writes.

## Git worktree guidance

For concurrent implementation work, agents should strongly prefer separate git worktrees and branches per pi session rather than sharing one checkout. Coordination claims are still useful for intent/handoff, but worktrees are the primary protection against working tree, index, and branch conflicts.

Suggested pattern:

```bash
git worktree add ../<repo>-<task-slug> -b <task-branch>
```

Then launch the additional pi/Wayang session from that worktree and run `/coord enable` (or rely on an existing `.pi/coordination/` room if shared intentionally).

## Runtime files

```text
.pi/coordination/
  room.json
  sessions/<session-token>.json
  messages.jsonl
  claims.jsonl
```

Presence files include session metadata and heartbeat timestamps, not transcript contents. `piSessionFile` is recorded for debugging/navigation; the session JSONL itself is not copied.

## Suggested agent behavior

- Check `session_coordination status` before broad edits or refactors.
- If another active session may edit the same repo, prefer creating/using a separate git worktree and branch before implementation work.
- `announce` the scope you are taking on.
- `claim` files/directories/tasks before modifying shared areas.
- `post` blockers, discoveries, or handoff notes that could help another session.
- `release` claims when work is complete or abandoned.
