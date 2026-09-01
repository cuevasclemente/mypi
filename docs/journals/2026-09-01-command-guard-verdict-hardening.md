# Command guard verdict hardening — 2026-09-01

## Scope and decisions

Clemente approved hardening the command-authorization monitor after repeated model failures blocked otherwise valid shell commands. The agreed behavior was:

- keep model reasoning, but cap it at a low level;
- raise the verdict token budget;
- when the verdict model fails, ask the owning human for permission instead of using a deterministic allowlist;
- add a consecutive-failure circuit breaker;
- keep audit mode warn-only and headless execution fail-closed;
- do not add durable maintenance mode or change the identity-PIN path;
- retain Wayang's existing guard reactivation on live-session attach.

## Root cause

The verdict call used `maxTokens: 512`. `together/zai-org/GLM-5.3-Flash` could consume the entire budget in thinking and stop with `stopReason=length` before returning parseable verdict text.

## Implementation

Commit `1078847` (`feat(guard): capped reasoning, raised verdict budget, breaker, human approval fallback`) adds:

- a 4096-token default verdict budget (`PI_COMMAND_GUARD_MAX_TOKENS`);
- low reasoning by default (`PI_COMMAND_GUARD_REASONING`), passed through pi-ai's provider options;
- a per-process consecutive-failure breaker (default threshold 3, cooldown 10 minutes);
- human approval through `__pi_command_guard_approval_bridge`, with a TUI fallback and headless denial;
- health status in `/command-guard`;
- test-only model completion injection gated by `PI_COMMAND_GUARD_TEST_COMPLETER=1`.

The matching Wayang bridge/UI is commit `b318304` in `cuevasclemente/wayang`.

## Validation

Before integration:

- guard-hardening suite: 11/11;
- existing synthetic + extension suites: 25/25;
- all `tests/`: 100/100;
- npm suite: 37/37;
- extension build validator: pass.

A later test attempt in the clean main worktree could not load `tsx` because that worktree has no development dependencies. This was checkout state, not a test regression; the exact feature commit had already passed the complete gates in this task worktree.

## Integration and deployment

- `main` fast-forwarded from `a3433eb` to `1078847` and was pushed to GitHub over HTTPS.
- The installed extension matched prior main byte-for-byte before replacement (SHA-256 `042bc0de0817c8de555165e7f7a91213ab93ab81098a75599bd4414a2b2ecaa6`).
- Owner-private rollback copy: `~/.pi/agent/extensions/.backups/command-guard-hardening-20260901T191849Z/command-authorization-monitor.ts`.
- Installed extension SHA-256: `d2bd99336a20eba537aff256af1d986eeca0111c16e8b5ac0bba253874646295`.
- The installed file is owner-owned mode 0644; the rollback directory is mode 0700 and its file mode 0600.

The extension is loaded by new pi sessions. Restarting Wayang will replace the current live session and re-enable balanced guard mode by design.

## Rollback

Restore the owner-private backup atomically to `~/.pi/agent/extensions/command-authorization-monitor.ts`, then restart `wayang.service`. Prefer reverting the Git commits rather than rewriting published history.

## Remaining verification

After the Wayang restart: confirm the service is healthy, a new session loads the hardened extension, and an induced/observed model failure produces a selection-bound approval prompt rather than an indefinite block.
