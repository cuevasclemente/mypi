# Agent Monitor Hook System

**Date:** 2026-05-10
**Context:** Setting up hooks infrastructure for pi coding agent

## Summary

Built an **agent-monitor** extension — a lightweight second model that watches the main agent's output and signals when significant work is completed, prompting for journaling and memoriki updates.

## What was built

### Agent Monitor Extension (`plugins/agent-monitor.ts`)

A TypeScript extension that:
- Listens to `message_end` for assistant messages and collects output text
- On `agent_end`, evaluates accumulated text through a cheap/fast model (DeepSeek V4 Flash)
- The monitor model receives a structured prompt asking it to determine if the work represents a meaningful milestone (completed feature, tricky bug fix, architectural decision)
- When triggered, injects a distinctly-styled custom message (`🜁 Monitor: journal-reminder`) into the chat suggesting journaling and memoriki updates
- Configurable via `.pi/hooks.json` with `minInterval` (min messages between evaluations) and `maxContextTokens`
- Fire-and-forget async — never blocks the main agent
- `/monitors` command to inspect active monitors

### Hooks Config (`plugins/hooks.example.json` → installed to `~/.pi/agent/hooks.json`)

Currently configured with one monitor:
- **journal-reminder** — triggers on meaningful milestones, reminds to journal in `./docs/journals/` and update memoriki at `~/src/memoriki`

### Global AGENTS.md (`~/.pi/agent/AGENTS.md`)

Added standing instructions:
- **Memoriki:** When unclear or needing domain knowledge, check `~/src/memoriki` first
- **Communication:** Surface questions to the user rather than guessing
- **Hook awareness:** Informs the agent about the monitor system

### Hooks Extension (`plugins/hooks.ts`)

Retained as reference infrastructure for simpler turn-cadence hooks (every_turn, every_n_turns, after_tool, on_command triggers). Currently inert since config uses `monitors` array.

## Design Decisions

- Chose `agent_end` as the evaluation trigger rather than every turn — avoids noise, better captures "task completion"
- Used a separate cheap model for evaluation rather than prompt-injection — doesn't consume main context window, semantically smarter than keyword matching
- Async fire-and-forget pattern — the monitor call never blocks the user or agent
- Custom message renderer (`🜁 Monitor:`) makes monitor-triggered messages visually distinct from normal agent output
- Config in JSON for easy editing without touching TypeScript

## Key Files

| File | Role |
|------|------|
| `plugins/agent-monitor.ts` | Monitor extension |
| `plugins/hooks.ts` | Lifecycle hooks infrastructure |
| `plugins/hooks.example.json` | Reference monitor & hook config (installed to `~/.pi/agent/hooks.json`) |
| `~/.pi/agent/AGENTS.md` | Global agent instructions |
| `./docs/journals/2026-05-10-agent-monitor.md` | This journal entry |
