# Pi CLI protected-identity scope — 2026-09-01

## Decision

Clemente clarified the runtime boundary after a Pi CLI session on Frost-Walrus rejected this ordinary DNS diagnostic with a protected-identity error:

```sh
resolvectl query -4 --cache=no archlinux.org; echo "rc=$?"
```

Protected-identity/PIN tool preflight belongs to Wayang's browser-mediated agent runtime. A standalone Pi CLI is operated directly by the host user and must not inherit that Wayang-specific restriction. The ordinary command-risk guard remains independently controlled by its existing `off`, `audit`, `balanced`, and `strict` modes.

## Root cause

The globally installed `command-authorization-monitor` ran `protectedToolAccessFinding` and `protectedShellCommandFinding` unconditionally before mode, local allow, or model routing. Its conservative unresolved-expansion handling therefore applied to every Pi process, including standalone TUI sessions.

Wayang already installs an exact process-local `WeakSet` witness under `Symbol.for("wayang.owned-session-managers.v1")` before `bindExtensions()`. The session-title extension already consumes the same witness to distinguish Wayang-owned managers without relying on cwd or generic UI/mode heuristics.

## Implementation

- Added an exact `isWayangOwnedSession` check using the existing SessionManager ownership witness.
- Scoped deterministic protected-identity and unresolved-operational-expansion preflight in `tool_call` and `user_bash` to exact Wayang-owned managers.
- Kept raw-sudo enforcement and the ordinary model/local command-risk guard unchanged for standalone Pi.
- Added regression coverage proving:
  - the reported DNS command, protected paths, and environment inspection do not enter Wayang protected preflight in standalone CLI mode when the ordinary guard is off;
  - the same DNS command still fails closed before execution for an exact Wayang-owned manager;
  - all prior PIN/path/environment protections remain mode-independent within Wayang.
- Updated older security fixtures to explicitly mark their synthetic managers as Wayang-owned instead of relying on a global implicit scope.
- Documented the runtime distinction in `README.md`.

## Validation

Passed:

- focused scope/invariant suites: 32/32;
- all `tests/*.test.ts`: 102/102;
- `npm test`: 37/37;
- esbuild bundle validation for `plugins/command-authorization-monitor.ts`.

A direct ad hoc `tsc` command reports the same pre-existing implicit-`any`, nullable PIN option, and `.ts` import-option errors on unchanged `origin/main`; it is not a regression gate for this extension. The aggregate extension validator retains its known `@earendil-works/pi-ai/compat` temporary-bundle resolution failure documented in the Frost rollout plan. Focused runtime tests and esbuild bundling are authoritative for this change.

## Deployment and live verification

Clemente explicitly approved publishing and deploying both hosts through a Wayang questionnaire.

- Commit `3f70d1d` was fast-forwarded to canonical `mypi/main` and pushed to GitHub.
- The-Sceptre source and installed extension are byte-identical at SHA-256 `ea384250ab59bf0bed77d8ea7d64803baa10b0ba381c45b468bb4a7f1525a8e8`.
- The-Sceptre rollback copy: `~/.pi/agent/extensions/.backups/command-guard-pi-cli-scope-20260901T225637Z/command-authorization-monitor.ts` (directory `0700`, file `0600`).
- Frost-Walrus was reached using a separate temporary known-hosts file after its ED25519 fingerprint matched the previously approved Frost rollout plan. The shared dual-boot host-key entry was not changed.
- Frost-Walrus rollback copy: `~/.pi/agent/extensions/.backups/command-guard-pi-cli-scope-20260901T225637Z-frost/command-authorization-monitor.ts` (directory `0700`, file `0600`).
- Frost-Walrus installed extension is mode `0644` and matches the source hash above.
- A synthetic Frost smoke loaded the installed extension through Pi's real extension loader, confirmed the exact DNS command passed standalone `tool_call` and `user_bash` hooks, and ran the actual `resolvectl` query successfully with exit code 0.

Existing Pi processes retain their already loaded extension code until `/reload` or restart. Wayang itself requires no code change because it already publishes the exact ownership witness before extension lifecycle binding.

## Rollback

Restore the exact host-local backup over `~/.pi/agent/extensions/command-authorization-monitor.ts`, then `/reload` or restart the affected Pi process. Revert `3f70d1d` rather than rewriting published history if source rollback is required.
