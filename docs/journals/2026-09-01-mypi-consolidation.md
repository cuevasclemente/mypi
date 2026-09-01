# mypi consolidation release — 2026-09-01

## Outcome

Consolidated the divergent mypi lines into one clean integrated branch,
`ops/mypi-consolidation-20260901`, ready to fast-forward `main`. Built for the
Tribe-Mac alignment handoff (Wayang `cd98b00`, combined Pi artifact
`0.84.1-wayang.4f7d03ce`, and a clean mypi release replacing the deferred M4
blocker).

## Consolidated sources

| Source | State before | Integrated as |
|---|---|---|
| `feature/runtime-extensions` dirty tree (126 entries) | staged/unstaged recovery + parity snapshot, conflict markers carried in README/package-lock | WIP snapshot commit `34cdd5b`, merged |
| `recovery/reviewed-integration` (Aug 10, 3 commits) | clean, unmerged | cherry-picked `cac67b8` (coordination rooms), `2cf9df8` (goals authority); `e61f751` (PIN path guard) deliberately held back |
| `feat/session-coordination-tool-enable` (960f9b1) | clean, unmerged | merged |
| `fix/session-coordinator-empty-widget` (d18ecf3, Aug 18) | clean, unmerged | merged |
| runtime-extension-parity worktree (uncommitted, base 1031afa) | partial copy of recovery work + runtime | unique runtime-matching files copied; agent-teams content redundant with recovery line |
| neutral-parity-installer worktree (uncommitted, base 1031afa) | installer tooling | `deploy/`, `scripts/neutral-parity.mjs`, `tests/neutral-parity.test.mjs` copied; Makefile/README merged manually |
| The-Sceptre installed runtime `~/.pi/agent/extensions` + `skills` | live truth | final byte-parity source for divergent files |

## Governing rule

The installed runtime is authoritative for extension code; reviewed branches
are authoritative where the runtime matches them. The dirty tree mixed fresh
recoveries (hooks, interview, questionnaire, sudo-hook, dreamer, wayang-apps —
all matching installed) with stale ones (agent-monitor Jul 9, todo May 20,
command-authorization-monitor Aug 4) that predate the Aug 10 recover commits
already on main.

## Deliberate hold-backs and parks

- **`e61f751` PIN path guard** (command-authorization-monitor upgrade +1120
  lines, 2 test files): reviewed Aug 10 but never deployed; the runtime runs
  the pre-guard version. Held back; lives on `recovery/reviewed-integration`
  for a future review-and-deploy pass.
- **`tests/browser-control.auth.test.ts.pending-baseline`**: asserts the WIP
  browser-control variant (source-session-auth, never deployed; runtime mtime
  Jul 15 predates the Aug 6 WIP). Runtime version kept as truth; WIP variant
  preserved in snapshot `34cdd5b`. Test passes 4/0 against the WIP variant.
- **`tests/command-authorization-questionnaire.test.ts.pending-esm-smoke`**:
  drives `scripts/validate-extensions.cjs`, whose CJS `Module._load`
  interception predates the ESM-only pi runtime (`@earendil-works/pi-ai/compat`
  exports ESM only). Adaptation pending; not release-gating.
- **Runtime cruft not recovered**: `narwhal-horn/narwhal-horn/` nested stray
  copy inside the installed runtime.
- package-lock.json restored from main (dirty copy held stale 0.80.6 pins and
  unresolved conflict markers); package.json equals main's (devDep pin stays
  `0.84.1-wayang.29fcca05`; bumping to `4f7d03ce` is an optional follow-up).

## Validation (all green)

- `npm ci --include=dev` against the pinned `file:` artifact (note: global npm
  `omit=dev` requires the flag).
- `npm test`: session-auto-title 29 pass, memory-first-compaction 8 pass.
- tests/ active suites: companion-policy 8, durable-reports 9,
  goals-authority 7, command-authorization-context-isolation 5,
  command-authorization-hard-invariants 5, interview-sync-provenance 3,
  questionnaire-sync-provenance 3, session-coordinator 24,
  wayang-apps-source-session-auth 1 — 65 pass, 0 fail.
- `make neutral-parity-test` (installer): 0 fail.
- `scripts/test-identity-neutral-distribution.sh`: PASS.
- `make neutral-parity-plan ROLE=sceptre COMPONENT=capabilities` runs against
  the consolidated tree.
- Extension byte-parity vs installed runtime: 63/64 match; the one mismatch is
  the intentionally unrecovered `narwhal-horn/narwhal-horn/` stray. Consolidated-only
  files are intentional (`plugins/hooks.example.json`,
  `plugins/privileged-exec-protocol.test.ts`, `plugins/session-auto-title.test.mts`).
- Skills: 94 byte-identical files; repo `mcp/SKILL.md` keeps the portable
  placeholder (installed copy has a host-specific absolute path);
  `public-api-trading` took the newer installed revision; runtime-only
  `narwhal-horn-model-migration` and `server-expansion-drive-recovery`
  recovered. `skills/agent-teams` maps from `plugins/agent-teams/SKILL.md` at
  install time (Makefile install-skills already handles this).

## Behavioral smoke note

`scripts/validate-extensions.cjs` (from the dirty tree) is parked as
non-gating: its CJS `Module._load` interception model predates the ESM-only pi
packages (`@earendil-works/pi-ai/compat` has no CJS export). Adaptation to an
ESM mock strategy is a follow-up. main's
`scripts/check-extensions-build.js` (structure + esbuild compile + installed
drift check) remains the current validator.

## Known behavior notes

- npm global config `omit=dev` silently skips devDependencies; always use
  `npm ci --include=dev` for this repo.
- Node's native strip-only TS mode cannot run plugin sources that use parameter
  properties; run tests with `node --import tsx --test`.

## Branch state

- `feature/runtime-extensions`: now carries WIP snapshot `34cdd5b` (the exact
  pre-consolidation tree, preserved verbatim).
- `ops/mypi-consolidation-20260901`: release branch; fast-forward target for
  `main`.
- Worktrees left intact: `runtime-extension-parity` and
  `neutral-parity-installer` (their content is integrated; worktrees remain as
  evidence until cleanup is explicitly approved).

## Rollback

All integration is additive on top of `main` (`5b1e8f4`); `main` fast-forward
is the only mutation of an existing ref. No history was rewritten. Restore by
pointing `main` back at `5b1e8f4` if needed.

## Remote integration (same session, later)

Clemente authorized accepting GitHub's host key. The three host keys fetched
from `api.github.com` over TLS were fingerprint-verified locally against the
published values and installed into `~/.ssh/known_hosts` (backup first:
`known_hosts.bak-20260901T100918Z`). SSH key auth remains unavailable
noninteractively (`id_ed25519` and `frost_key_lightsail` are
passphrase-protected with no agent; only `frost-walrus-training-key` is
unencrypted and is not registered with GitHub), so the release traveled over
HTTPS with the existing credential helper.

The push surfaced a non-fast-forward: remote `main` held a PR #2 merge
(`fa32130`, guarded SSH control-socket support in
`plugins/command-authorization-monitor.ts`, 2026-08-19) plus two README
license-wording edits; the remote line had none of the August work (divergence
point `649321b`). Resolution: merged remote into the release line at
`10d9f93` — the plugin conflict resolved to the runtime-authoritative variant
(the remote PR version still fed assistant dialogue/thinking into the
authorization request; the deployed version excludes assistant-authored
context by construction and pins Together with no cross-provider fallback),
and the README adopted Clemente's final Mozilla license wording from
`02bf845`. PR #2's two test files pass fully against the deployed variant
(19/0 and 6/0).

Validation after the merge: npm suites 37/0, tests/ 89/0 including the PR
files, tribe parity plan 147 entries with unchanged policy SHA
`207a3c880720f39261ed9e12d97c2eccc1f87fd45ee89550876170dc1d71c86e` (byte
identical at `f68e4b7` and `10d9f93`; the earlier noted `8536b062…` value was
a different artifact's hash). `main` fast-forwarded to `10d9f93` in its
checking-out worktree (`.worktrees/terra-main-update`, clean) and pushed:
`origin/main` = `10d9f93`. Force-push and history rewrite were never
considered for the remote PR merge; rebase was rejected to preserve recorded
release hashes.