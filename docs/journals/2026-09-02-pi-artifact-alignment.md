# Pi artifact alignment — 2026-09-02

## Purpose

Resolve the first Pi Stack Deploy compatibility gate without downgrading Wayang or choosing between artifact names by convention.

## Decision and evidence

Wayang `06795eb` already pins `@earendil-works/pi-coding-agent` artifact `0.84.1-wayang.4f7d03ce`. Pi source history shows `4f7d03ce` is a direct descendant of `29fcca05`: it retains the memory-first compaction controls and adds incremental resume-session loading and its regressions.

mypi previously compiled against the ancestor `29fcca05`. This branch moves its development dependency and lockfile to the same descendant artifact and adds the exact vendored tarball:

- artifact: `earendil-works-pi-coding-agent-0.84.1-wayang.4f7d03ce.tgz`
- SHA-256: `c82956f058b7dc09a2206c8c9f9331f2971042a4fa9597a5ee017f58d5303da9`

No active Pi runtime, global context, identity overlay, authentication, session, or installed extension was changed.

## Validation

Passed on the aligned branch:

- `npm ci --include=dev`
- `npm test`: 37/37
- `npm run check`
- `make neutral-parity-test`: 12/12
- `make check-identity-neutral`
- `node scripts/check-extensions-build.js`: all listed extensions validated
- exact delayed-worker regression alone: 1/1
- `git diff --check`

The broad parallel TypeScript run reached 150/151 twice; the only failure was the progressive-skills delayed-old-worker timeout at its 45-second ceiling. An untouched detached `ea88d5e` worktree with the former `29fcca05` artifact reproduced the same 150/151 timeout, while the exact test passes alone in about 0.2 seconds. It is therefore an ambient parallel-test issue, not caused by this artifact alignment.

The older `scripts/validate-extensions.cjs` also fails on both aligned and untouched base with a missing external `@earendil-works/pi-ai/compat` stub. The maintained build validator above passes; this branch does not hide an unrelated pre-existing validator defect.
