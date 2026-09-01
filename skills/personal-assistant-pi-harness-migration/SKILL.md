---
name: personal-assistant-pi-harness-migration
description: Develop, migrate, and debug Clemente's server-lattice personal-assistant app as it moves from a bespoke Python LLM/tool loop to a Pi-backed harness, preserving Matrix UX, scheduler/reminder behavior, memory quality, temporal correctness, MCP/tool parity, and secret-safe repo-scoped shell/file powers.
---

# Personal Assistant Pi Harness Migration

## Setup
- Use this for work in `/home/clemente/src/server-lattice/apps/personal-assistant` related to Pi harness migration, Matrix bot behavior, temporal prompt correctness, assistant MCP/tool parity, or runtime safety.
- Key files/areas:
  - Plan: `apps/personal-assistant/docs/plans/pi-harness-migration.md`
  - App code: `apps/personal-assistant/src/`
  - Tests: `apps/personal-assistant/tests/`
  - Project journals: `docs/journals/`
- Before broad edits, check `todo` and `session_coordination status`; claim paths/tasks when coordination is active.
- Never read `.env`, API tokens, OAuth credentials, private keys, `.agents-do-not-read` areas, or other secret-bearing files. Reference secret env vars/paths opaquely.
- Avoid permanent deletion. Keep rollback via git and document any service-restart handoff.

## Architecture to preserve
The migration goal is better assistant quality and reliability, not a restricted chatbot.

- Pi becomes the reasoning/tool harness for personal-assistant turns.
- Python Matrix bot and APScheduler remain the shell for inbound messages, reminders, scheduled check-ins, file watching, and missed-reminder recovery at first.
- Prefer stateless-ish per-message Pi invocation:
  - fresh Pi process/RPC session per inbound/scheduled/reminder event,
  - minimal runtime envelope with user, event, current date/time/timezone, trigger, and recent turns,
  - durable memory remains in assistant stores/tools, not Pi session resume.
- Use project-local prompts/skills/resources only; do not inherit Clemente's global personal Pi environment in production.
- Default model route is local Qwen where configured; ZDR DeepSeek is fallback/escalation when configured.
- Assistant-domain tools should be exposed through a project-local MCP bridge or equivalent local tool layer.
- The assistant may retain repo-scoped shell/file powers, protected by command/path guard and secret rules.

## Temporal/date bug workflow
When the assistant has the wrong current day/date/time:

1. Verify host and service timezone/date:
   - `date`, `timedatectl`, service environment where safe.
2. Verify user timezone/profile config without reading secrets.
3. Inspect the temporal context producer, e.g. `src/temporal.py` or the current equivalent.
4. Inspect the active prompt path actually used by the runtime, not just legacy templates.
5. Check prompt variable names. Jinja silently rendering undefined variables can hide stale names.
6. Render the prompt locally with representative temporal context.
7. Add or run focused tests for date/day/timezone behavior.

Typical fix pattern: align template variables with the `TemporalContext` fields that are actually produced, then validate rendered prompt text.

## Migration implementation workflow
1. **Read the plan and current code path**
   - Start with `pi-harness-migration.md` and the current `matrix_bot.py`, `orchestrator.py`, provider, scheduler, and tool-executor paths.
2. **Phase 0 spike**
   - Build a `PiRunner`/Pi invocation smoke path.
   - Verify Pi can receive prompt/envelope, produce final text, and shut down.
   - Verify local model config and tool calling.
   - Add a minimal guard test: out-of-repo writes and secret reads must be blocked.
   - Add a minimal MCP/tool bridge call to one safe assistant-domain tool.
3. **Tool parity**
   - Mirror current personal-assistant capabilities through MCP or a bridge: context/search, todos, reminders, recurring/calendar, schedule CRUD, workspace files, weather/news/deals if active, and admin onboarding gates.
   - Enforce user/admin/household boundaries server-side; do not rely on the model to pass safe IDs.
   - Keep tool results concise/truncation-safe.
4. **Runtime prompt/envelope**
   - Avoid rebuilding the old giant Jinja stack.
   - Keep a stable base system prompt, user-level prompt/profile, and minimal per-turn envelope.
   - Include current date/time/day/timezone explicitly.
5. **Matrix integration**
   - Wire Pi behind a config flag first.
   - Preserve existing Matrix UX: concise, warm, not coding-agent flavored.
   - If quick acknowledgements are used, make them configurable and varied; avoid repeating one hard-coded phrase.
6. **Journal and handoff**
   - For meaningful app/runtime changes, update `docs/journals/` with summary, validation, blockers, restart status, and rollback notes.

## Matrix reliability and response guarantees
The assistant must not quick-ack and then silently fail to answer.

Checklist for message buffering/consolidation bugs:
- Understand timer lifecycle: sleeping consolidation timers may be canceled by new messages; active processing should not be canceled accidentally.
- If a timer finishes sleeping and is about to process, unregister it from `_consolidation_timers` before handing off to processing.
- Add regression tests like `tests/test_matrix_buffering.py` to ensure a later message cannot cancel an already-active processing task and drop the earlier batch.
- Consider durable in-flight turn logging before draining buffers so crashes/cancellations can be recovered.
- Recovery should detect quick-ack-only situations on restart and reprocess last unanswered user messages.
- Runtime timeout/error paths should send a final status/apology when Pi fails, not leave the user with only an acknowledgement.

## Validation
Run focused validation before handoff:

```bash
cd /home/clemente/src/server-lattice/apps/personal-assistant
PYTHONPATH=src .venv/bin/python -m pytest -q tests/test_pi_harness.py tests/test_matrix_buffering.py
PYTHONPATH=src .venv/bin/ruff check src tests
PYTHONPATH=src python -m py_compile src/matrix_bot.py
```

Adapt paths/tests to the files changed. Also validate:
- Pi invocation smoke: final text extraction, timeout/error handling, no global resource leakage.
- Guard smoke: blocks secret paths, out-of-repo writes, and dangerous mutations.
- MCP/tool bridge smoke: safe tool call succeeds and enforces user scope.
- Manual Matrix DM: quick ack (if enabled), final response, message order, long-message handling.
- Scheduled check-in and reminder trigger paths still work.
- Memory/context quality is at least as good as the old assistant on representative prompts.

## Service restart handoff
If code changes require the live Matrix bot to restart, validate what you can without sudo, then report the exact command and blocker:

```bash
sudo systemctl restart personal-assistant-matrix-bot.service
sudo systemctl status personal-assistant-matrix-bot.service --no-pager
```

If sudo is unavailable in the agent harness, do not loop. Mark the relevant todo blocked, journal it, and ask Clemente to run the restart.

## Safety notes
- Keep secrets opaque: env var names and secret paths are acceptable; values are not.
- Do not use production user data for broad evals unless necessary; prefer representative saved prompts or sanitized fixtures.
- Treat memory/context quality as the top must-not-regress area.
- Keep a clean git rollback point before cutting over the primary code path.
