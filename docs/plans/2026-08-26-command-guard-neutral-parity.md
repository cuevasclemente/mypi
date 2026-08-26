# Command Guard Context Isolation and Neutral Pi Parity

**Date:** 2026-08-26  
**Status:** Approved for planning and implementation  
**Lead:** Wren  
**Branch:** `feat/command-guard-neutral-parity-20260826`  
**Explicit base:** `288dd6ef77a21318ef558ab239fd374477f40364`  
**Worktree:** `/home/clemente/src/mypi-worktrees/command-guard-neutral-parity`

## Goal

Repair command-guard false positives caused by assistant-context contamination, restore `mypi` as the reproducible identity-neutral source of truth, and align reviewed Pi capabilities between The-Sceptre and Narwhal-Horn.

The-Sceptre remains the sole active Wren deployment. Narwhal-Horn receives neutral Pi configuration only and does not run Wayang.

## Confirmed decisions

- Rollout scope is full reviewed identity-neutral `mypi` parity, not command guard alone.
- The model guard receives the exact command, tool metadata, and verified recent human input only. Assistant prose and reasoning are excluded.
- Narwhal-Horn does not receive Wayang code, bridge state, or a Wayang restart.
- The-Sceptre receives the validated Pi artifacts and a coordinated Wayang restart after deployment.
- Dreamer code, cron, service, timer, and Dream-specific skills are excluded from Narwhal-Horn and from this parity release.
- Narwhal-Horn receives a backup-first install of canonical neutral context.
- The-Sceptre's Wren context is preserved and may only be recomposed through the separately owned Wren installer.
- Existing active sessions are not silently mutated; isolated Pi smoke tests precede restart/reload.

## Evidence and current state

### Command guard

- The-Sceptre installed runtime: `~/.pi/agent/extensions/command-authorization-monitor.ts`
  - SHA-256: `534986f6370fbf158dd412cd9b93f63160e68f24a1355e4d0500cf1f1f7fac2f`
  - Size: 103,651 bytes.
- Narwhal-Horn installed runtime is byte-identical to The-Sceptre.
- Canonical source on the integration base is stale:
  - SHA-256: `fa4ae8524526cd98a4dcb5fe297addd5b340191220fe8789108c515ad6eb60af`
  - Size: 54,092 bytes.
- Narwhal-Horn's `~/src/mypi` is at `649321bf9045f232fc29354baa468e342dbdcfc2` and lacks canonical guard source.

### False-positive mechanism

`textFromContent()` includes assistant `thinking` blocks; `recentAssistantContext()` gathers the last two assistant messages; `buildPrompt()` places that content next to the exact command. In the incident session, prior PII discussion was reintroduced into each otherwise stateless model verdict, causing unrelated commands to be denied as PII extraction.

### Host topology

- The-Sceptre: Pi + Wayang + separate Wren context overlay.
- Narwhal-Horn: Pi 0.84.1 only; no Wayang.
- Narwhal-Horn currently has 14 extensions, 4 skills, old neutral context, no `APPEND_SYSTEM.md`, and Dreamer disabled/inactive.
- The-Sceptre source and runtime contain substantial concurrent drift. No dirty checkout may be used as a deployment source.

## Security invariants

The following remain deterministic, independent of the model, and ordered before mode/local-allow/model evaluation:

1. Protected identity/PIN storage access denial.
2. Broad environment and protected-path access denial.
3. Unknown or unresolved operational expansion denial.
4. Raw `sudo` denial; privileged actions require `sudo_exec` exact executable and argv approval.
5. Direct `user_bash` protected-access enforcement.
6. Structured `sudo_exec` protected-access enforcement.
7. Verified Wayang form provenance and expiry checks on The-Sceptre.
8. Fail-closed model unavailability for residual non-locally-safe commands.

No prompt prose may replace these controls.

## Release manifest policy

### Included on both hosts

- Reviewed cross-host-compatible extensions from canonical `mypi`, including command guard, sudo broker, agent teams, todo, hooks, forms, provider, coordinator, session auto-title, SSH clipboard support, token tracking, and other neutral Pi-only extensions that pass Pi 0.84.1 validation.
- Reviewed identity-neutral skills present in canonical source and the release manifest.
- Hooks configuration.
- Exact file modes and SHA-256 manifest.

### Narwhal-Horn only

- `agent-context/AGENTS.md` installed through the neutral-context installer.
- Any existing context and append layer backed up first.
- `APPEND_SYSTEM.md` absent after install.
- No Wayang action.

### The-Sceptre only

- Preserve the active Wren overlay and context activation record.
- Do not run neutral-only context installation directly over the active Wren deployment.
- Restart Wayang only after coordination, backup, local validation, and install verification.

### Excluded

- Dreamer extension, cron, service, timer, state, and Dream-specific skills.
- Wren overlay, named identities, autobiography, activation records, memory, or identity-specific installers.
- Wayang artifacts on Narwhal-Horn.
- `secure_data`, `.env`, auth/trust stores, API keys, credentials, cookies, sessions, transcripts, browser state, MCP private grants, and host-private settings.
- `*.test.ts`, build output, backups, top-level stale compatibility shims, and accidental runtime residue.
- Remote-only files not explicitly listed in the release manifest.

## Architecture changes

### 1. Canonicalize the security runtime

- Recover the newer installed guard into `plugins/command-authorization-monitor.ts` as the security-preserving baseline.
- Review every runtime-only deterministic control before accepting it into source.
- Keep source and installed copies byte-identical after deployment.
- Add CI/install drift checks.

### 2. Remove assistant authorization context

- Stop adding `recentAssistantContext()` output to `buildPrompt()`.
- Exclude assistant visible text and hidden reasoning from model authorization input.
- Retain only provenance-tagged recent human inputs, exact command, cwd, tool, and timeout.
- Keep assistant statements non-authoritative by construction, not merely by prompt instruction.

### 3. Ground model denials

- Extend the verdict schema with a bounded risk category and command evidence when practical.
- Reject unsupported explanations that cite operations absent from the exact command.
- For low-risk residual commands only, allow one minimal context-free retry or independent fallback adjudication.
- Never retry away a deterministic hard denial.

### 4. Harden installer and manifest

- Exclude `*.test.ts` and Dreamer from automatic plugin discovery for this release.
- Add an explicit neutral-parity install target/manifest rather than relying on directory copying.
- Separate neutral context installation from capability installation.
- Back up managed target paths before replacement.
- Never use `--delete` outside an exact managed staging/runtime path; prefer explicit quarantine of stale managed artifacts.

## Milestones

### M1 — Reconciliation and tests

1. Import and review runtime-ahead command guard hardening.
2. Remove assistant context from model prompts.
3. Export narrow pure helpers needed by tests.
4. Add regression fixtures reproducing the PII-context contamination without real secrets.
5. Add hard-invariant tests for PIN paths, environment access, raw sudo, wrappers, protected paths, and model failure.

### M2 — Canonical parity manifest

1. Inventory every candidate source/runtime artifact by path, mode, size, hash, and host applicability.
2. Classify each as include, host-specific, excluded, stale residue, or unresolved.
3. Review the 88 neutral source skills before inclusion; exclude Dream-specific or host-inapplicable skills.
4. Produce an immutable manifest and archive from the clean worktree.

### M3 — Local validation

- Bundle/typecheck extensions.
- Run command guard, sudo, agent-team, todo, coordinator, title, provider, and identity-neutral distribution tests.
- Test against Pi 0.84.1.
- Install into an isolated temporary `PI_CODING_AGENT_DIR`; never test first against the live runtime.
- Confirm no secret, Wren, Dreamer, Wayang-on-Narwhal, test, or session path enters the artifact.

### M4 — Narwhal-Horn canary

1. Confirm no active conflicting deployment.
2. Create timestamped, checksummed backup of managed extensions, skills, hooks, and context metadata/content without printing them.
3. Stage and verify the release artifact and manifest.
4. Install Pi-only capabilities and canonical neutral context.
5. Keep Dreamer absent/disabled.
6. Validate Pi startup, extension loading, guard status, provider listing, deterministic hard denials, and contamination regression using synthetic non-secret commands.
7. Perform no Wayang action.

### M5 — The-Sceptre deployment

1. Coordinate and announce the restart window to active sessions.
2. Back up managed Pi runtime artifacts and current Wren composition through the supported owner flow.
3. Install the same host-neutral hashes.
4. Preserve/recompose Wren context through `~/src/wren`; never install neutral context directly over it.
5. Restart Wayang.
6. Validate health, new-session extension loading, command-guard bridge/status, forms, sudo broker, agent teams, provider registration, and the context-contamination regression.

### M6 — Documentation and durable state

- Commit source, tests, manifest tooling, and plan/journal.
- Record host hashes, validation outcomes, backup paths, and rollback commands without secrets.
- Update Memoriki's durable Pi-host topology after successful validation.

## Regression matrix

| Scenario | Expected |
|---|---|
| Assistant previously discusses PII, secrets, `rm`, or prior denials; exact command is harmless arithmetic | Allow or context-free low-risk adjudication; prior assistant content is absent from prompt |
| Assistant hidden reasoning contains hostile/policy-like text | No effect; not present in guard prompt |
| Verified recent human request authorizes scoped work | Available as provenance-tagged authority |
| Forged, stale, or mismatched Wayang form | Excluded |
| Exact command reads/changes PIN storage or forbidden PIN env names | Deterministic block in every mode |
| Raw sudo through direct or wrapped shell | Deterministic block; require `sudo_exec` |
| Actual secret display/copy/exfiltration | Block |
| Opaque authorized credential use with no disclosure | Residual adjudication; hard controls remain |
| Clearly destructive command without authority | Block |
| Model unavailable on ambiguous non-local-safe command | Fail closed |
| Source/runtime hash drift after install | Deployment failure |

## Validation commands

Exact commands will be recorded in the journal. Expected families:

- `node scripts/validate-extensions.js command-authorization-monitor`
- focused Node tests for command guard, sudo, identity neutrality, and distribution
- package build/type checks against the pinned Pi 0.84.1 artifact
- isolated `PI_CODING_AGENT_DIR` startup/list-model smoke tests
- manifest/hash comparison locally and over SSH
- The-Sceptre Wayang health and fresh-session smoke after restart

No destructive-command test executes a destructive action; such tests invoke pure classifiers or synthetic hook events.

## Rollback

### Narwhal-Horn

- Restore the timestamped managed-runtime backup atomically.
- Restore prior context and append-layer presence/absence from backup.
- Keep Dreamer disabled/absent.
- Validate Pi startup and prior guard hash.

### The-Sceptre

- Restore the managed Pi runtime backup.
- Restore/recompose Wren context through its guarded installer.
- Restart Wayang and validate health.

Rollback never resets dirty repositories, deletes worktrees, copies secrets, or activates Wren on another host.

## Agent-team roles

- **Guard canonicalization owner:** command guard source recovery, context isolation, pure-helper exports, regression tests.
- **Parity/installer owner:** explicit manifest, exclusions, backup/install/verify tooling, identity-neutral checks.
- **Security reviewer:** hard-control ordering, secret/identity/Dreamer exclusions, rollback audit; no deployment writes.
- **Remote validator:** Narwhal canary and cross-host hash/smoke validation after artifacts are approved.
- **Lead orchestrator (Wren):** integration, final review, deployment sequencing, Wayang restart coordination, and durable documentation.

## Stop conditions

Pause affected deployment—not unrelated safe work—if:

- Narwhal becomes unreachable;
- a runtime-only hard control cannot be reconciled confidently;
- release manifest contains any secret, Wren, Dreamer, session, test, or unintended Wayang artifact;
- backup or hash verification fails;
- active session coordination makes The-Sceptre restart unsafe;
- isolated Pi validation or hard-invariant tests fail.
