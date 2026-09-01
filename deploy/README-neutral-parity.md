# Neutral parity release tooling

`deploy/neutral-parity-allowlist.json` is the reviewed source-to-runtime policy for two host roles:

- `narwhal`: Pi-only capabilities plus a separately built neutral context.
- `sceptre`: shared capabilities only. `AGENTS.md` and `APPEND_SYSTEM.md` are protected and remain owned by the Wren composition flow.

The tool never discovers release contents implicitly. Policy entries are the allowlist; inventory output classifies other plugin/skill files as included, host-specific, excluded, stale runtime residue, or unresolved for review. An unresolved source artifact blocks `build`; intentional omissions must be recorded in `sourceExclusions` with host applicability and a review reason. Built manifests contain the clean source commit plus an exact path, host applicability, mode, size, and SHA-256 for every file. `build` fails if the source is not a clean Git worktree root. A deterministic uncompressed tar and SHA-256 sidecars make the release immutable and independently verifiable.

## Local release flow

```bash
# Review source candidates and the exact prospective manifest (no writes).
make neutral-parity-plan ROLE=narwhal COMPONENT=capabilities

# Build into a new output directory; an existing directory is never overwritten.
make neutral-parity-build ROLE=narwhal COMPONENT=capabilities \
  RELEASE_DIR=/tmp/neutral-parity-narwhal-capabilities

# Verify the immutable manifest against its staged payload.
make neutral-parity-verify RELEASE_DIR=/tmp/neutral-parity-narwhal-capabilities

# Exercise installation only under an isolated root.
make neutral-parity-install-plan \
  RELEASE_DIR=/tmp/neutral-parity-narwhal-capabilities \
  TARGET_ROOT=/tmp/pi-agent-root
```

Neutral context must use `COMPONENT=neutral-context` and `ROLE=narwhal`. Policy rejects that component for The-Sceptre. The context install backs up and quarantines an existing `APPEND_SYSTEM.md`; it never deletes it.

## Apply and rollback

There is intentionally no default live deployment target. After separate deployment authorization, an operator can run the script directly with `install ... --apply`. Every managed target is moved to a timestamped backup on the same filesystem and checksummed before a replacement is installed. Newly installed files are hash/mode verified against the immutable manifest. Any install failure invokes rollback automatically.

Rollback uses `rollback --backup <timestamped-backup> --target <same-root>`. Current installed files are moved into a timestamped `rollback-current-*` holding area, and prior files are moved back after checksum verification. Files that were absent before installation remain recoverable in that holding area rather than being permanently deleted.

## Exclusions

The tool rejects Dreamer/dream-cycle, test files, secret/auth/trust/session material, identity/Wren material, build/runtime residue, and Wayang paths on Narwhal even if accidentally added to policy. Allowlisted artifacts must be regular UTF-8 files; content mentioning Wren or Dreamer is rejected, and symlinked sources or target parents fail closed. Secret/identity paths are classified from metadata without hashing or reading their contents. `*.test.ts` and Dreamer are excluded from legacy Make plugin discovery as a separate defense.
