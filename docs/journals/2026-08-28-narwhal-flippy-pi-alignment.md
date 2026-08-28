# Narwhal-Flippy reviewed-safe Pi alignment — 2026-08-28

## Outcome

Completed the authorized reviewed-safe Pi alignment from The-Sceptre to `clemente@192.168.50.204` (`narwhal-flippy`). The deployment used exact clean sources, preserved root Pi and host-local private state, installed only identity-neutral artifacts, disabled the neutral dreamer timer as selected, and verified exact Together AI model-catalog parity.

Anthropic and OpenRouter auth-gated rows were explicitly left out by Clemente. No credentials, auth files, model/settings files, sessions, trust state, Wren overlay, memory ownership, activation witness, or scheduler authority were copied.

Plan:

`docs/plans/2026-08-28-narwhal-flippy-pi-alignment.md`

Operations branch/worktree:

- branch: `ops/narwhal-flippy-pi-alignment-20260828`
- worktree: `/home/clemente/src/mypi-worktrees/narwhal-flippy-alignment`
- base: `b53fc26a77af294e7bb6008e0a6e2810ff639828`
- plan commit: `882bfcf`

## Initial state

- Host: CachyOS Linux x86_64, fish, Node `v26.7.0`, npm `12.0.2`.
- Pi resolved `/usr/bin/pi`, version `0.75.3`, backed by a root-owned package under `/usr/lib/node_modules/pi`.
- No user-local Pi package existed under `~/.local`.
- Existing runtime: 18 extension entries, approximately 84 skill directories before the additive sync, neutral `AGENTS.md`, no `APPEND_SYSTEM.md`.
- `mypi-dreamer.timer` was enabled and active; its service was inactive.
- No `~/src/mypi` checkout existed.
- Existing global context SHA-256: `5ce1423478f581f01e41af4ab2c6fc617ded00bf62d72e5382fd69f21f1744f3`.

## Exact rollback bundle

`/home/clemente/.pi/backups/pi-alignment/20260828T224500Z-reviewed-safe`

The directory is user-owned and mode `0700`. It contains:

- pre-rollout `AGENTS.md`;
- exact pre-rollout skills tree;
- pre-rollout Narwhal provider extension;
- absent markers for the three newly added extension directories and user-local Pi;
- dreamer user units and runtime script;
- fish PATH-fragment absent marker;
- exact combined Pi tarball;
- public pre/post metadata and model-list evidence;
- `ROLLBACK.md` with literal restore commands.

The backup excludes auth, models, settings, sessions, trust state, and secrets.

## Sources and deployed artifacts

### Pi core

- package: `earendil-works-pi-coding-agent-0.84.1-wayang.4f7d03ce.tgz`
- source path: `/home/clemente/src/wayang/backend/`
- SHA-256: `c82956f058b7dc09a2206c8c9f9331f2971042a4fa9597a5ee017f58d5303da9`
- target prefix: `/home/clemente/.local`
- install: npm global user prefix with lifecycle scripts disabled

### Neutral context and skills

- clean source commit: `9f80951f0dfc288507d1edaa55e227a493c72a6b`
- global context source SHA-256: `a5c0a0205607d28df792c3cf6c684be5c69e1e60862815347541f35c668397bf`
- 87 clean source skill directories installed additively; no delete/prune
- all 95 deployed skill files matched their source checksum manifest

Four remote-only skill directories were preserved:

- `agent-teams`
- `arch-linux-network-printer-setup`
- `dream-cycle-skill-extraction`
- `kde-wayland-desktop-lag-troubleshooting`

Final remote skill count: 91.

### Independently clean extensions

| Extension | Clean source commit | Files | Validation |
|---|---|---:|---|
| `progressive-skills` | `678993e740783537fb61c065f21c68542fdc4fa8` | 14 | source equals The-Sceptre runtime; staged/runtime checksums pass |
| `human-input-tui-notifier` | `997766c3cf9d9a9f34aeb85ea0525492c5e81a8e` | 2 | focused suite 12/12; source equals The-Sceptre runtime; checksums pass |
| `memory-first-compaction` | `b53fc26a77af294e7bb6008e0a6e2810ff639828` | 11 | source equals The-Sceptre runtime; staged/runtime checksums pass |
| `narwhal-horn` Flash-Next registration | `dd4736572e148891860ebe63cc2a9e2abb11107d` | 1 | staged/runtime checksum passes; model-list metadata equals The-Sceptre |

The progressive-skill release record already documents 17 passing tests and independent security/retrieval GO. A local rerun in this session could not start because that clean worktree lacks its test-time TypeScript loader; installed source was byte-identical to the reviewed The-Sceptre runtime and loaded without startup errors. Dense retrieval cache/model was intentionally not copied; reviewed BM25 fallback remains available.

Existing extension targets outside this allowlist were preserved. Final extension-name comparison has two intentional The-Sceptre-only entries:

- `privileged-exec-protocol.ts`
- `session-auto-title.ts`

Those and full hash parity for pre-existing extensions remain deferred until a clean full neutral manifest is committed and reviewed.

## PATH and root rollback

A new dedicated fish fragment was installed:

`~/.config/fish/conf.d/10-local-bin-path.fish`

It prepends `~/.local/bin` without replacing existing shell configuration. Fresh fish and noninteractive SSH now resolve:

- path: `/home/clemente/.local/bin/pi`
- version: `0.84.1-wayang.4f7d03ce`

The root command remains unchanged:

- path: `/usr/bin/pi`
- version: `0.75.3`
- owner: `root:root`

## Model catalog validation

After the core and provider upgrade, public metadata is identical between The-Sceptre and Narwhal-Flippy for every in-scope/already-authenticated provider:

| Provider | The-Sceptre | Narwhal-Flippy | Public metadata delta |
|---|---:|---:|---:|
| Claude Code | 3 | 3 | 0 |
| Narwhal-Horn | 1 | 1 | 0 |
| OpenAI Codex | 7 | 7 | 0 |
| Together AI | 20 | 20 | 0 |

Together AI was the final required model criterion. All 20 model IDs, context windows, maximum outputs, reasoning flags, and image flags match exactly. The installed list includes current entries such as GLM-5.3-Flash, DeepSeek V4 Pro/Flash, Qwen 3.6 Plus/3.7 Max, Kimi K2.6/K2.7 Code/K3, MiniMax M2.7/M3, GPT-OSS 20B/120B, Gemma 4 31B, Nemotron 3 Ultra, and Inkling.

The Narwhal provider now lists `qwen3.8-flash-next` at native 262,144 context instead of the stale `qwen3.8-27b` entry.

Direct Anthropic (13 rows on The-Sceptre) and OpenRouter (364 rows) remain hidden on Narwhal-Flippy because host-local authentication was not configured. Clemente explicitly chose to leave those auth-gated providers out for now.

## Scheduler state

Clemente selected disabling the remote dreamer timer.

Final state:

- `mypi-dreamer.timer`: disabled, inactive
- `mypi-dreamer.service`: inactive
- timer/service/script files: present and backed up

Rollback is:

```bash
systemctl --user enable --now mypi-dreamer.timer
```

## Final validation

Passed:

- exact Pi package hash on source and target;
- exact user-local Pi version and fresh-shell path resolution;
- root Pi preserved at prior version;
- global context exact canonical neutral hash;
- `APPEND_SYSTEM.md` absent;
- all staged and installed checksums for 124 context/skill/extension files;
- 87-source-skill subset complete, four remote-only skills preserved;
- no symlinks in deployment sources;
- model-list startup completed with no extension errors;
- Together AI 20/20 exact public catalog parity;
- every common in-scope provider has zero model metadata delta;
- timer disabled/inactive and rollback files retained;
- rollback root mode `0700` and rollback README present.

## Deferred work

- Anthropic/OpenRouter protected login, intentionally out of scope.
- Two The-Sceptre-only extension names and full pre-existing extension hash parity.
- Clean committed neutral-parity installer/manifest consolidation.
- Dense progressive-skill model/cache installation.
- Any provider credential, auth, models/settings, session, Wayang, identity, or scheduler propagation.
