# mypi Repository Instructions

## Scope and Sources of Truth

This repository is the distributable, identity-neutral source for Clemente's Pi extensions, skills, hooks, and generic global user context.

- `agent-context/AGENTS.md` is the canonical source for the identity-neutral global working context. A neutral deployment may install it at `~/.pi/agent/AGENTS.md`.
- Named agent identities, identity anchors, autobiographical memory, task-conditioned identity capsules, and identity-specific installers do not belong in this repository. Installing `mypi` on another host must not instantiate Wren or any other named continuing identity.
- The active Wren overlay and its guarded runtime-context installer are owned separately by `~/src/wren`; do not copy them into this repository.
- This root `AGENTS.md` contains mypi repository instructions only. Do not install it as global context.
- Treat files under `~/.pi/agent/` as installed runtime copies, not canonical sources. Keep identity-neutral artifacts aligned through this repository and named-identity artifacts through their own canonical homes.
- Preserve unrelated work in this repository; it commonly contains concurrent or uncommitted changes.

## Secret Boundaries

Never read, print, copy, or commit secret values. Files or directories such as `secure_data/`, `.env`, credential stores, auth files, API-key files, and local trust stores may be referenced by path but must not be inspected for their contents.

The command-guard identity PIN is separate from sudo. It must remain outside repositories and chat in `~/.config/pi/command-guard-identity-pin`. Agent sessions must not read, print, copy, unset, export, modify, or relocate that PIN or its configuration.

## Skill Recording and Distribution

When creating or materially updating an Agent Skill, load the `pi-extension-distribution` skill and keep these locations aligned unless Clemente explicitly requests otherwise:

1. `~/src/mypi/skills/<skill-name>/SKILL.md` — distributable source.
2. `~/.pi/agent/skills/<skill-name>/SKILL.md` — active installed runtime.
3. `~/src/memoriki/skills/<skill-name>/SKILL.md` — durable skill archive.

Update the active runtime first when a change must affect the current or immediately following session, then mirror the approved content to both source archives. Prefer byte-identical copies; document any intentional format difference. Never put secret values in a skill. Journal meaningful skill changes and report every synchronized path.

## Security Extension Synchronization

When changing security-sensitive Pi extensions—especially `plugins/sudo-hook.ts` or `plugins/command-authorization-monitor.ts`—keep all affected runtime surfaces aligned in the same session:

- Update the mypi source copy.
- Update or install the active runtime copy under `~/.pi/agent/extensions/`.
- Update Wayang bridge, UI, or backend code when behavior depends on web approval, status, or session mapping.
- Validate extension syntax or bundling and all affected Wayang backend/frontend surfaces before handoff.

Use the relevant command-guard, sudo, or extension-distribution skill for the detailed procedure. Do not rely on prompt prose as the enforcement boundary.

## Installation and Validation

- `make install-all` installs identity-neutral capabilities only and deliberately excludes global context.
- Use `make install-neutral-context` only when intentionally creating or restoring a neutral deployment. It manages both runtime context layers and removes any identity append into its recoverable backup. The designated active Wren deployment composes this generic source with its separate overlay through `~/src/wren` instead.
- Use the repository Makefile targets rather than hand-copying distributable artifacts when a target exists.
- Before replacing installed context, preserve a recoverable backup when it may contain local changes.
- After installation, compare source and target and report the result.
- Validate proportionately to the changed artifact. Do not run unrelated deployment or synchronization steps merely because they exist.
