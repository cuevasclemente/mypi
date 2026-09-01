---
name: agent-scheduled-tasks
description: Design, migrate, debug, and operate scheduled agent tasks in pi/wayang, including catch-up behavior, environment/secrets handling, task logs, and manual execution.
---

# Agent Scheduled Tasks

## Setup
- Identify where schedules live: application database/config, cron/systemd timer, wayang scheduler, or legacy project runner such as Atrium.
- Know which model/provider and environment variables each task requires.
- Scheduled runs must not block on human input. Complete all independent safe work and durable outputs first. If an approval, clarification, login, secret, or other human action is required, record the exact blocker, fail closed for that action, and continue. A questionnaire may be opened only at the end, after substantive completion, and the run must not wait for its answer.
- Never read API key files. If a task needs a key, reference the env var or configured secret path and report the missing configuration noninteractively without printing values.

## Workflow
1. **Inventory existing tasks**
   - List task names, schedules, commands/prompts, cwd, model/provider, required env vars, and expected outputs.
   - Note whether each task is idempotent and whether missed runs should catch up.

2. **Migrate or define schedules**
   - Preserve task identity and history where possible.
   - Store schedules in a durable location owned by the application.
   - Include timezone, enabled/disabled state, retry policy, and last-run metadata.

3. **Handle environment and secrets**
   - Pass required environment variables into task execution explicitly.
   - Do not prompt interactively for API keys during scheduled runs.
   - Log missing env vars as actionable configuration errors without printing secret values.

4. **Execution model**
   - Support manual run-now for debugging with the same completion-before-question behavior as the scheduler.
   - Support scheduled run, retry/backoff, and catch-up mode after downtime.
   - Complete safe independent work even when one action is blocked; persist blockers and required next steps before opening any optional end-of-run question surface.
   - Capture stdout/stderr, transcript/session id, exit status, start/end timestamps, and model usage.

5. **UI/API integration**
   - Expose task list, next run, last result, enabled state, and recent logs.
   - Allow safe edits to schedule and environment references.
   - Make failures visible without blocking unrelated tasks.

## Validation
- Run one task manually with the same env as the scheduler.
- Temporarily set a near-future schedule and confirm it fires once.
- Simulate missing env vars, missing approval, and consequential ambiguity; verify each is reported clearly and non-secretly, the run completes without waiting, and any questionnaire appears only after substantive completion.
- Restart the service and confirm pending/catch-up behavior is correct.

## Common pitfalls
- Scheduler asks for an API key, approval, clarification, login, or decision before completing independent work, or waits for the answer.
- A scheduled prompt opens a questionnaire before state/report persistence, making durable completion depend on a delayed reply.
- Tasks run in the wrong cwd and cannot find project files.
- Catch-up runs duplicate non-idempotent side effects.
- Logs omit enough metadata to debug failures later.

## Patterns from source sessions
- Atrium scheduled tasks were migrated toward wayang.
- A later run failed because scheduled tasks asked for an API key; the fix pattern is explicit env propagation and noninteractive failure.
- Dream cycles need catch-up processing of many sessions and durable state updates.