---
name: secret-safe-browser-automation
description: Design and operate browser automation for pi/Wayang using Playwright MCP and Bitwarden-backed secret brokers, with local-only secret-tainted sessions, provider gates, compaction/history safeguards, and validation that secrets do not leak to cloud-model transcripts.
---

# Secret-Safe Browser Automation

Use this skill when Clemente wants agents to operate websites, fill credentials, use TOTP, or inspect sensitive browser content while controlling whether secrets can enter LLM context or persisted session history.

## Setup

- pi/Wayang project with extension support and normal session JSONL storage.
- Playwright or Playwright MCP for browser control.
- Bitwarden CLI (`bw`) only when the user has installed/configured it; never ask for or read the master password.
- Optional local model on Narwhal-horn/Qwen for sessions allowed to see secrets or sensitive page contents.
- A dedicated ignored artifact directory, for example:
  - `.pi/browser-artifacts/` for normal non-secret browser output.
  - `.pi/secret-browser/` for secret-tainted browser profiles, screenshots, traces, or storage state.

Never read credential files, Bitwarden vault data, private keys, browser cookies, auth-state JSON, or `.env` files directly.

## Core Principle

There are two safe operating modes:

1. **Broker mode** — secrets never enter model context. A custom tool/process retrieves a credential internally and fills the browser field or TOTP field, returning only redacted status.
2. **Local-secret mode** — the model is allowed to see sensitive content, but the session is permanently `secret-tainted` and must stay local-only for continuation, summarization, history search, and artifact inspection.

If a secret or sensitive page content ever lands in normal pi JSONL, preventing later exposure becomes a session-history routing problem. Treat that session as tainted forever.

## Workflow

### 1. Clarify the threat model

Ask before implementing:

- Is the goal accidental non-exposure, or a strong technical boundary?
- Should the browser be headed so Clemente can watch/intervene?
- Should login state persist, or should every run be isolated?
- Which browser: Chromium, Firefox, or an existing extension/browser profile?
- Which actions require explicit human confirmation: purchase, submit, pay, trade, delete, account changes?
- Can local Narwhal-horn/Qwen inspect sensitive pages, or should all secrets remain broker-only?

### 2. Set up non-sensitive browser automation first

For exploratory browser work, prefer Playwright MCP with an isolated output directory:

```bash
npx @playwright/mcp@latest --isolated --output-dir .pi/browser-artifacts --caps=core
```

Guidelines:

- Use isolated contexts for unknown sites.
- Use persistent profiles only when Clemente intentionally wants saved login state.
- Treat `storageState`, cookies, traces, screenshots, downloads, HAR files, and browser profiles as bearer secrets when logged in.
- Avoid enabling unsafe code/RCE-like browser tools unless explicitly needed.

### 3. Design the Bitwarden secret broker

A safe broker exposes intent-level tools, not raw `bw get` output. Example tool surface:

- `bw_status` — returns locked/unlocked/account metadata only; no vault contents.
- `bw_unlock_request` — prompts the user to unlock Bitwarden out of band; never accepts master password in chat.
- `browser_fill_bitwarden_login(itemRef, usernameSelector, passwordSelector)` — resolves the item internally, fills the fields internally, and returns `filled username/password for <alias>`.
- `browser_fill_totp(itemRef, selector)` — retrieves TOTP internally and fills it; never returns the code.
- `browser_save_auth_state(label)` — saves protected state, returns path metadata only.
- `browser_close_and_lock()` — closes browser context and asks/executes Bitwarden lock if appropriate.

Broker rules:

- Never return raw usernames/passwords/TOTP in `content`, `details`, logs, screenshots, or traces.
- Prefer exact item IDs or configured aliases over fuzzy vault searches.
- Confirm domain/item match before using credentials on a new origin.
- Do not expose `BW_SESSION` to unrestricted shell sessions.

### 4. Use session tainting for local-secret mode

When a tool or user intentionally exposes secret/sensitive content to the model:

1. Mark the current session metadata as `secret-tainted`.
2. Pin the session to a local provider/model (for Clemente, Narwhal-horn/Qwen).
3. Block or auto-switch any cloud provider request.
4. Force compaction and branch summaries through the local model, or cancel them.
5. Exclude tainted JSONL and artifacts from normal Wayang history search/indexing.
6. Block nonlocal sessions from reading tainted session files or secret browser artifacts via `read`, `bash`, `grep`, `find`, or custom search tools.

Useful pi/Wayang enforcement hooks:

- provider request guard: block nonlocal model calls for tainted sessions.
- `session_before_compact`: local-only summarization or cancel.
- `session_before_tree`: local-only branch summary or cancel.
- tool-call guard: deny reads of tainted JSONL/artifacts from nonlocal sessions.
- Wayang indexer filter: skip tainted histories or keep a local-only index.

### 5. Validate before real credentials

Use a dummy Bitwarden item and local/demo login page.

Validation checklist:

```bash
# Example checks; adapt to the repo/tool names.
rg 'DUMMY_SECRET_VALUE|dummy-password|123456' ~/.pi/agent/sessions .pi/browser-artifacts .pi/secret-browser
```

Pass criteria:

- Dummy secret does not appear in session JSONL, tool logs, browser traces, screenshots OCR/snapshots, or app logs.
- Direct `bw get password`, `bw get item`, and reads of Bitwarden/session material are blocked in guarded mode.
- Saved browser auth state is ignored by git and inaccessible to nonlocal sessions.
- Tainted sessions cannot be continued, compacted, summarized, or indexed by cloud models.

## Common Decisions

| Need | Recommended mode |
| --- | --- |
| Fill login/password/TOTP without model seeing it | Broker mode |
| Agent must inspect account pages, statements, or private forms | Local-secret mode with Qwen |
| Repeatable non-sensitive site workflow | Playwright script or MCP, normal session |
| Strong non-readability even if model tries | Privilege-separated broker user/container |

## Pitfalls

- MCP secrets redaction and Playwright redaction are convenience features, not security boundaries.
- Browser storage state is a credential; treat it like a password.
- Screenshots and accessibility snapshots can contain account numbers, recovery codes, addresses, balances, or other sensitive DOM text.
- If unrestricted `bash` can run `bw get` or read auth files, the model can read secrets; use a constrained tool profile or separate broker account for strong guarantees.
- Auto-compaction can send older messages to a model; tainted sessions must override or block compaction.

## Source-Session Techniques

- A 2026-05-21 mypi planning session researched Bitwarden CLI session behavior, Playwright MCP/browser profile behavior, and pi extension hooks.
- The session produced `docs/plans/browser-automation-secret-broker.md` and identified a two-layer architecture: Playwright for browser control, broker/provider gates for secret safety.
- Follow-up discussion established the session-tainting rule: once a secret appears in JSONL, only local models should read, summarize, index, or continue that history.
