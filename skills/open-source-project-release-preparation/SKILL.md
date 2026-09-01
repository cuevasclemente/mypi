---
name: open-source-project-release-preparation
description: Prepare an existing private or local application for a safe first open-source release by interviewing maintainers, auditing repository and Git state, choosing licensing and support scope, curating an explicit public file allowlist, removing personal infrastructure and secret-bearing artifacts, designing reproducible bootstrap/configuration and agent-install flows, documenting the security model, adding CI and release gates, and publishing only after staged privacy review and explicit confirmation.
---

# Open-Source Project Release Preparation

## Setup

Use this skill for a substantial first public release, especially when the working tree contains personal deployment history or is not yet a Git repository.

Required:

- Local source tree and its project instructions
- Authoritative dependency/runtime documentation
- Git and the project's normal build/test tools
- A maintainer who can decide license, supported platforms, authentication, and publication scope
- Optional credential scanner such as Gitleaks

Safety boundaries:

- Never read or print `.env`, OAuth stores, API-key files, cookies, private keys, or credential values.
- Treat the named public repository as an external reference: inspect its actual state before describing or pushing to it.
- Do not use `git add .` for an initial publication from a private tree.
- Do not push, create releases, change accounts, or enter credentials without explicit maintainer confirmation and human handoff.
- Plan first. Unless immediate execution is explicitly requested, produce an execution plan and defer implementation to a fresh session.

## 1. Interview Before Editing

Clarify choices that change architecture or public promises:

1. Intended users and project maturity.
2. Supported operating systems and minimum runtime versions.
3. Source checkout, package, container, or machine-wide installation.
4. License and copyright notice.
5. Authentication paths and secret storage.
6. Default bind address and remote-access security model.
7. Human versus coding-agent installation UX.
8. CI platforms and required release gates.
9. Public history policy: curated initial commit or preserved history.
10. Community files, support policy, version/tag, and publication target.

Use a follow-up interview when an answer introduces a product feature. For example, “optional password protection” requires decisions about storage, sessions, HTTP routes, WebSockets, proxy trust, rate limiting, and tests—not merely README wording.

## 2. Audit the Actual State

Inspect before proposing changes:

```bash
find . -maxdepth 3 -type f -not -path './.git/*' | sort
git status --short --branch
git remote -v
git ls-remote --symref <public-repository-url> HEAD
```

Record:

- Whether the local tree is a Git checkout.
- Whether the remote is empty or has history that must be reconciled.
- Existing README, license, manifests, lockfiles, Makefile, CI, service files, and install scripts.
- Runtime versions, dependency constraints, wildcard ranges, native modules, and platform assumptions.
- HTTP, WebSocket, app-proxy, browser-control, and other privileged entry points.
- Features that silently depend on private extensions or globally installed tools.

Never infer that a GitHub repository is empty or that a named dependency behaves a certain way; verify it.

## 3. Classify Public and Private Material

Build an explicit table with three classes:

- **Publish after review:** source, tests, lockfiles, timeless architecture docs.
- **Rewrite or neutralize:** personal README content, absolute paths, hostnames, screenshots, example fixtures, service definitions.
- **Exclude:** secrets, `.env`, OAuth state, MCP config, local agent state, internal journals, incident histories, build/test output, browser profiles, databases, backups, and personal deployment configuration.

Prefer an explicit public allowlist. A typical initial set is:

```text
README.md LICENSE Makefile package manifests lockfiles
.env.example .gitignore AGENTS.md CONTRIBUTING.md SECURITY.md
src/ tests/ scripts/ docs/ .github/workflows/
```

Review each optional extension separately for source provenance, license, hard-coded models/paths, and security sensitivity. A public checkout must either bundle a reviewed generic dependency or document graceful degradation.

## 4. Define the Threat Model Before Quick Start

For applications that control files, shell commands, agents, or browsers, put the security warning before installation commands.

Document:

- Trusted-user versus multi-tenant status.
- Safe default binding, usually loopback.
- VPN, HTTPS, and authenticated reverse-proxy requirements.
- Every privileged REST, WebSocket, proxy, and static/app route.
- Transcript, provider credential, local data, and browser-profile sensitivity.
- What authentication does *not* sandbox.

If adding built-in authentication, centralize the decision across all transports. Test the public allowlist and verify that every privileged route and WebSocket upgrade rejects unauthenticated access. Avoid unrestricted CORS, tokens in URLs, browser storage for session secrets, and blind trust of forwarded headers.

## 5. Design a Reproducible, Non-Privileged Bootstrap

A first source release should provide a self-documenting command surface. Common Make targets:

```make
help doctor bootstrap install configure build start dev test test-e2e check
```

Guidelines:

- Default `make` displays help and does not mutate the machine.
- Use lockfiles and deterministic clean installs.
- Avoid `sudo`, global installs, service installation, destructive clean/reset targets, and secrets in argv.
- Keep production start in the foreground unless service management is explicitly in scope.
- Check prerequisites and print package-manager guidance rather than silently modifying the host.
- Include a non-secret `doctor` command and dry-run/test mode.

An interactive configuration wizard should:

1. Detect OS/architecture and validate tools/runtime.
2. Install and build deterministically.
3. Hand OAuth login to the human through the official CLI.
4. Collect API keys or passwords only through hidden local terminal input.
5. Default to loopback and warn on non-loopback exposure.
6. Preserve unknown config keys and write atomically with mode `0600`.
7. Report only key names/presence, never values.
8. Run health and startup smoke tests.

Do not shell-source untrusted `.env` syntax when a strict parser or runtime env-file facility is available.

## 6. Write Human and Agent Documentation

The README should cover:

1. Purpose and early-stage status.
2. Sanitized features/screenshots.
3. Security model before quick start.
4. Verified prerequisites and supported platforms.
5. Copyable quick start.
6. Authentication/configuration choices.
7. Common commands, data locations, architecture, testing, contribution, security, and license links.

Create an agent-install guide that tells agents to:

- Inspect first and use `doctor`.
- Perform only non-secret setup/build work autonomously.
- Pause for human OAuth, API-key, password, MFA, or account steps.
- Never ask for secrets in chat or put them in argv, logs, commits, or tool calls.
- Keep loopback defaults unless networking is discussed.
- Validate health, authentication gates, and one user-visible workflow.
- Roll back without deleting user data.

Keep public `AGENTS.md` limited to repository-relevant instructions; remove personal synchronization rules, private paths, identity controls, and deployment assumptions.

## 7. Add CI and Release Gates

Match CI to the public support promise:

- Minimum and recommended runtime versions.
- Clean installs, unit tests, lint, and production builds.
- Cross-platform smoke jobs.
- Browser/E2E tests with synthetic home/config directories.
- No real credentials or authenticated personal data.

Treat dependency-audit output as evidence to review, not an automatic blocker without exploitability analysis.

Before staging, validate:

```bash
make doctor
make check
make test-e2e
```

Then run case-insensitive privacy searches for personal names, home paths, private hosts/domains, emails, production incidents, secret filenames, and internal journals. Run a credential scanner when available without reproducing matched secret values in chat or reports.

## 8. Curate and Publish Safely

For an empty public remote:

```bash
git init -b main
git remote add origin <verified-url>
git ls-remote --symref origin HEAD
```

Abort and reconcile if refs appeared. Stage only the allowlist, then review:

```bash
git diff --cached --stat
git diff --cached
git ls-files
```

Confirm that ignored local state is not tracked. Create a clean initial commit, show the maintainer the staged/commit summary, and obtain explicit confirmation before external push.

Use human handoff for GitHub login, passkeys, MFA, or tokens. Push without force, then inspect the rendered public repository and file list immediately. Do not automatically add tags or releases unless they were explicitly approved.

## 9. Rollback and Incident Handling

Before push, preserve a recoverable local snapshot and adjust staging/commits without deleting source.

If private data is discovered after publication:

1. Stop further publication.
2. Rotate implicated credentials.
3. Remove the material from full Git history using an approved rewrite procedure.
4. Coordinate remote cache/support cleanup.
5. Re-scan and verify; deleting only the latest file is insufficient.

## Definition of Done

A release is ready only when:

- A fresh supported host can install, configure, build, start, and exercise the documented workflow.
- Secret entry requires human-local hidden input and generated private files use restrictive permissions.
- All privileged transports follow the documented auth model.
- The staged tree contains no private history, credentials, local state, or build artifacts.
- CI matches the stated platform/runtime support.
- README quick start works verbatim.
- The maintainer approves the final staged content and external publication.
- The public repository is inspected after push.

## Source-Session Techniques

This workflow was distilled from a planning-first release audit that combined repository inspection, authoritative dependency documentation, maintainer interviews, remote-state verification, explicit public allowlisting, cross-transport authentication analysis, agent-safe credential handoff, CI planning, privacy scanning, and a final no-force publication gate.
