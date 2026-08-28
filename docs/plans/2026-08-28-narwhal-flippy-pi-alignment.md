# Narwhal-Flippy reviewed-safe Pi alignment

Date: 2026-08-28
Status: implementation authorized
Branch: `ops/narwhal-flippy-pi-alignment-20260828`
Base: `b53fc26a77af294e7bb6008e0a6e2810ff639828`
Target: `clemente@192.168.50.204` (`narwhal-flippy`)

## Goal and chosen scope

Bring Narwhal-Flippy materially closer to The-Sceptre's Pi setup using only clean, reviewed, identity-neutral sources. Clemente selected reviewed-safe parity rather than core-only or exact parity, and selected disabling the target's active dreamer timer.

Success means:

- Narwhal-Flippy resolves user-owned Pi `0.84.1-wayang.4f7d03ce` before its existing root-owned Pi `0.75.3`;
- `pi --offline --list-models` matches The-Sceptre's public provider/model catalog wherever the same host-local authentication is already present, with exact remaining auth-gated deltas reported rather than credentials copied;
- the root package remains untouched as immediate rollback;
- the current canonical identity-neutral global context and clean neutral skill set are installed backup-first;
- only newer extensions with clean independently reviewed source branches are added;
- auth credentials, secret-bearing model/provider settings, sessions, trust state, secrets, and host-specific configuration are not read, copied, or replaced;
- no Wren overlay, memory ownership, activation witness, scheduler authority, or named continuing identity is copied;
- `mypi-dreamer.timer` is disabled and stopped, but its files and backup remain recoverable;
- validation records exact versions, hashes, source commits, remaining parity deltas, and rollback paths.

Exact extension parity is explicitly deferred until the partial runtime-extension integration and clean neutral-parity manifest are committed, reviewed, and reproducible.

## Evidence and initial inventory

- The-Sceptre: `/home/clemente/.npm-global/bin/pi`, version `0.84.1-wayang.4f7d03ce`.
- Combined package: `/home/clemente/src/wayang/backend/earendil-works-pi-coding-agent-0.84.1-wayang.4f7d03ce.tgz`, SHA-256 `c82956f058b7dc09a2206c8c9f9331f2971042a4fa9597a5ee017f58d5303da9`.
- Narwhal-Flippy: CachyOS x86_64, fish, Node `v26.7.0`, npm `12.0.2`, `/usr/bin/pi`, version `0.75.3`; executable/package are root-owned.
- Narwhal-Flippy already has 18 neutral extension entries, approximately 84 skill directories, a neutral `AGENTS.md`, no `APPEND_SYSTEM.md`, and an enabled/active dreamer timer.
- Narwhal-Flippy has no `~/src/mypi` checkout.
- The canonical live mypi checkout is dirty and must not be deployed.
- Clean skill source: `feat/neutral-skill-parity-20260826` at `9f80951f0dfc288507d1edaa55e227a493c72a6b`.
- Clean progressive-skill source: `feat/progressive-skill-search-20260825` at `678993e740783537fb61c065f21c68542fdc4fa8`.
- Clean TUI notifier source: `feat/human-input-tui-notifier` at `997766c3cf9d9a9f34aeb85ea0525492c5e81a8e`.
- Clean memory-first source/base: `feat/memory-first-compaction-20260827` at `b53fc26a77af294e7bb6008e0a6e2810ff639828`; inclusion remains conditional on a self-contained reviewed extension artifact and validation.
- Canonical neutral context SHA-256: `a5c0a0205607d28df792c3cf6c684be5c69e1e60862815347541f35c668397bf`.
- Pre-upgrade public model list: The-Sceptre exposes 409 rows across Anthropic, Claude Code, Narwhal-Horn, OpenAI Codex, OpenRouter, and Together; Narwhal-Flippy exposes 31 model rows across Claude Code, Narwhal-Horn, OpenAI Codex, and Together. Most OpenRouter and all direct Anthropic deltas are authentication-gated. Core/provider-extension upgrades must eliminate non-auth catalog deltas.
- Clean Flash-Next Narwhal provider source: `feat/qwen38-flash-ruminant-provider-20260827` at `dd4736572e148891860ebe63cc2a9e2abb11107d`; its public registration replaces the remote's stale `qwen3.8-27b` entry with The-Sceptre's `qwen3.8-flash-next` entry.

## Non-goals and preserved state

Do not inspect or mutate:

- `~/.pi/agent/auth.json`;
- `~/.pi/agent/models.json`;
- `~/.pi/agent/settings.json` except metadata-free existence checks if validation requires them (prefer no access);
- `~/.pi/agent/sessions/`;
- secret/key/token files or directories;
- trust decisions;
- the root-owned `/usr/lib/node_modules/pi` package;
- existing extension versions lacking a clean reviewed parity source in this rollout.

Do not use `rsync --delete`, do not copy The-Sceptre's live `~/.pi/agent` tree, and do not copy `APPEND_SYSTEM.md`.

## Deployment manifest

| Artifact | Source | Target | Method |
|---|---|---|---|
| Pi core and built-in model catalog | exact combined `.tgz`, hash above | `~/.local` npm prefix | `npm install -g --prefix ~/.local <artifact>` |
| Narwhal-Horn public model registration | clean `plugins/narwhal-horn/index.ts` at `dd47365` | `~/.pi/agent/extensions/narwhal-horn/index.ts` | backup target extension, install exact reviewed file; do not copy auth |
| Neutral context | clean `agent-context/AGENTS.md` | `~/.pi/agent/AGENTS.md` | backup, then mode `0644` install |
| Neutral skills | clean `skills/` tree at `9f80951` | `~/.pi/agent/skills/` | additive/update rsync without delete |
| Progressive skills extension | clean `plugins/progressive-skills/` at `678993e` | `~/.pi/agent/extensions/progressive-skills/` | backup if present, exact directory copy |
| TUI notifier | clean `plugins/human-input-tui-notifier/` at `997766c` | `~/.pi/agent/extensions/human-input-tui-notifier/` | backup if present, exact directory copy |
| Memory-first compaction | only if clean branch exposes a self-contained reviewed extension directory matching The-Sceptre runtime | corresponding extension target | otherwise defer and report |
| Dreamer scheduler | existing remote user unit | disabled/stopped | `systemctl --user disable --now`, no deletion |

Dense progressive-skill model/cache installation is not required for correctness: BM25 fallback is reviewed and functional. The large dense cache will not be copied from The-Sceptre. A later host-local pinned model setup may be performed separately.

## Milestones and gates

### M0 — Source and identity gates

1. Verify each source worktree is clean at its recorded commit.
2. Verify the Pi tarball hash.
3. Scan only distributable context/artifacts for named-identity contamination and secret-like tracked paths; do not scan secret directories.
4. Confirm the new operations worktree is isolated and clean except this plan.
5. Identify whether memory-first compaction has a standalone clean extension artifact; defer it if not.
6. Capture normalized provider/model IDs and public capability columns from both hosts using only `pi --offline --list-models`; classify initial deltas without reading auth or model configuration files.

Stop on any mismatch.

### M1 — Remote backup and preflight

1. Create a mode-`0700` timestamped backup root under `~/.pi/backups/pi-alignment/`.
2. Record non-secret preflight metadata (host, OS, Node/npm/Pi versions, path resolution, source hashes).
3. Copy into the backup:
   - current `AGENTS.md`;
   - current versions of extension targets that will be replaced, if any;
   - current skill directories that will be updated (or an exact compressed copy of the skills tree);
   - dreamer user units and runtime script;
   - shell path-resolution metadata.
4. Do not back up or inspect auth, models, settings, sessions, secrets, or trust state.
5. Write a rollback README with literal restore commands that do not affect preserved state.

Stop if backup creation or verification fails.

### M2 — User-local Pi core

1. Transfer the exact tarball into the backup/staging directory.
2. Verify the remote SHA-256 before install.
3. Install under the user-owned `~/.local` npm prefix with lifecycle scripts disabled where supported.
4. Verify `~/.local/bin/pi --version` exactly.
5. Verify fish's interactive path resolves `~/.local/bin/pi`; if not, make the smallest non-secret PATH correction only after preserving the affected shell file. Do not replace shell configuration wholesale.
6. Verify `/usr/bin/pi --version` remains `0.75.3` and root package metadata is unchanged.
7. Capture the user-local Pi public provider/model list and compare provider/model IDs plus public capability columns against The-Sceptre. Core-catalog differences must be zero; auth-gated provider differences are reported separately without reading or copying credentials.

Rollback: remove the user-local command through the package manager only if needed; otherwise select `/usr/bin/pi` explicitly. No root mutation is required.

### M3 — Neutral context and skills

1. Back up current neutral context and skill tree.
2. Install canonical neutral `AGENTS.md`; ensure `APPEND_SYSTEM.md` remains absent.
3. Add/update clean neutral skills without deleting remote-only skills.
4. Compare installed hashes against source for every deployed file.
5. Report remote-only and source-only skill names after deployment.

Rollback: restore context and skill tree from the timestamped backup.

### M4 — Independently reviewed extensions

1. Deploy the clean Flash-Next Narwhal provider registration, progressive skill search, and TUI notifier from their recorded clean commits.
2. Deploy memory-first only if M0 proves a standalone reviewed extension directory; otherwise defer.
3. Preserve existing extensions not in this explicit allowlist.
4. Compare source/target hashes byte-for-byte.
5. Do not copy extension caches, logs, session state, credentials, or The-Sceptre runtime backups.
6. Re-run the public model-list comparison; fix only clean catalog/registration deltas. Any remaining provider rows hidden solely by absent host-local authentication require protected user login and are not repaired by credential copying.

Rollback: restore prior target directory or move the newly added directory into the rollout backup and start a fresh Pi session.

### M5 — Scheduler disablement

1. Capture `is-enabled` and `is-active` before state.
2. Run `systemctl --user disable --now mypi-dreamer.timer`.
3. Verify timer is disabled and inactive.
4. Leave service/timer/script files present and backed up.

Rollback: `systemctl --user enable --now mypi-dreamer.timer`.

### M6 — Integrated validation

1. In a fresh fish shell, verify `command -v pi` and exact version.
2. Run an offline model-list/startup smoke without exposing credential contents; normalize and compare provider/model IDs and public capability columns with The-Sceptre.
3. Classify any model-list delta as built-in catalog, clean extension registration, or host-local authentication. Fix the first two only from reviewed neutral sources; leave authentication to protected user input.
4. Confirm root Pi still exists and reports its prior version.
5. Confirm context hash, absence of `APPEND_SYSTEM.md`, deployed skill count/deltas, and extension tree hashes.
6. Confirm no named Wren identity artifacts or activation files were installed in the manifest targets.
7. Confirm timer disabled/inactive.
8. Confirm auth/models/settings/session paths were not part of the transfer manifest.
9. Record remaining model/auth deltas, other warnings, and rollback path in the project journal and Memoriki host-deployment record.

## Risks and controls

- **Dirty source propagation:** all deployment inputs use exact clean worktrees/commits; the dirty canonical checkout is excluded.
- **Identity duplication:** only canonical neutral context is eligible; `APPEND_SYSTEM.md`, Wren memory, activation records, Wayang stores, and scheduler authority are excluded.
- **Root package damage:** install uses a user prefix; root package is never replaced.
- **PATH ambiguity:** validate in fish, not just non-interactive SSH; preserve any shell file before a minimal edit.
- **Skill loss:** no delete/prune; remote-only skills remain.
- **Extension breakage:** explicit allowlist only, exact hash comparison, offline startup smoke, target backup.
- **Large progressive cache:** rely on reviewed lexical fallback; do not transfer the 1.2 GiB cache.
- **Duplicate scheduler work:** disable and stop timer as explicitly selected.
- **Rollback incompleteness:** backup and rollback README are gates before mutation.

## Agent-team roles

The rollout is sequential and shares one remote mutable target, so parallel writers would add risk. The lead session owns execution and integration. It applies three bounded review roles at each gate:

- **Deployment operator:** exact artifact transfer, backup, user-prefix install, and service state.
- **Security/identity reviewer:** source cleanliness, manifest confinement, secret exclusions, and singleton boundary.
- **Validator:** independent version/hash/PATH/startup/timer/rollback checks after mutations.

A fresh subagent is not required for mechanical remote commands; if a gate is ambiguous, execution stops rather than delegating authority.

## Deferrals

- Exact hash parity for all pre-existing extensions.
- Deployment of any uncommitted runtime-extension integration.
- Dense progressive-skill model/cache installation.
- Copying provider credentials or secret-bearing model/auth/settings files. Public model-catalog metadata is in scope; missing authentication remains a protected user-mediated follow-up.
- Wayang installation or agent-profile propagation.
- Enabling any scheduled agent activity on Narwhal-Flippy.
