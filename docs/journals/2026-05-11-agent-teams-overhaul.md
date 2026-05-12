# Agent Teams: Skill, Bug Fixes, and Notify Channel

Date: 2026-05-11
Scope: `~/src/mypi/plugins/agent-teams/`

## Goal

Make agent teams actually work as a stateful coordination primitive: orchestrator spawns subagents, they run in parallel, communicate back, and the design philosophy is "identities are designed at creation time, not selected from a registry." Test it end-to-end.

## What We Found

The agent-teams extension was mostly there in concept (RPC subprocesses, designed identities) but had a few blocking issues:

1. **The RPC protocol bug.** `subagent-manager.ts` was sending `{"type":"prompt","text":"..."}`, but pi's RPC mode expects `{"type":"prompt","message":"..."}`. Subagents silently ignored every prompt. They sat at "running, 0 messages" forever. This is the kind of bug you only catch when you actually test.

2. **Spawn was synchronous.** The `subagent_spawn` tool was calling `subagentManager.send()` (which awaits the response) for the initial task. That meant spawning two subagents back-to-back required the first to fully respond before the second could even start. It looked exactly like the orchestrator was deadlocked, because for parallel work it effectively was.

3. **Polling wasn't cancellable.** `waitForIdle()` ignored the abort signal. Pressing Esc didn't actually stop the wait — the orchestrator just sat there. That's a hard UX bug for any TUI/web-UI workflow.

4. **No way for subagents to push back.** Subagents could only be polled. If a long-running subagent hit a blocker or finished early with something important, the orchestrator wouldn't see it until it remembered to poll.

5. **Dead code.** `teams.ts` and `agents.ts` loaded predefined identities from `.pi/teams/*.md` and `.pi/agents/*.md`. Nothing imported them. They contradicted the explicit "no predefined identities" philosophy. Vestigial.

6. **No skill.** The orchestrator had the tools but no clear narrative explanation of *when* and *how* to use them. Tool descriptions are short by design; a skill is the right place for patterns and tips.

## What We Did

### Bug fixes

- `RpcRequest.text` → `RpcRequest.message` everywhere. Fixed three sites in `subagent-manager.ts`.
- `subagent_spawn` now uses `sendAsync()` instead of `send()` for the initial task. Returns immediately. Multiple subagents spawn in parallel.
- `waitForIdle(agentId, timeoutMs, signal)` now respects an `AbortSignal`. The `subagent_poll` tool passes its tool-execute `signal` through. Esc cancels the wait cleanly with a status message instead of silently hanging.

### Feature: end-of-turn message routing (replacing the `[NOTIFY]` magic prefix)

The original notification design used a `[NOTIFY]` magic-string prefix that the subagent would optionally include to push a message into the orchestrator's chat. The user pushed back: *"this is just one model for subagent structure (team member working on goals), there's another (orchestrator/worker)..."* and *"if there's nothing to report, subagents should end their session with their final message to the orchestrator, so in both the subagent and agent team scenarios, the loop works the same."*

The right model is unified: every assistant turn ends with a final message, and that message is the subagent's reply to whoever is listening. The plumbing routes it automatically:

- If a `send()` is pending in the orchestrator's manager (someone is awaiting a direct reply), the final message resolves that promise.
- Otherwise (the turn was unsupervised — e.g., the initial task from spawn, or a turn the subagent kicked off itself), the final message is surfaced in the orchestrator's chat via `pi.sendMessage({ customType: "subagent-notify", display: true, ... }, { deliverAs: "nextTurn" })`.

A custom message renderer styles the notification as `↑ notify from "<agent-id>"` with the body below.

The `[NOTIFY]` prefix detection was removed from `handleRpcEvent`. The new branch in `agent_end` checks whether `pendingResolve` is set and dispatches accordingly. Subagents no longer need to elect anything — they just produce a clear final message and the plumbing delivers.

### Feature: subagents track their own goals

When the user said *"we should encourage subagents to create their own set of goals as well, that will make it easier to send that final message imo"* — yes, that's exactly right. If the subagent has its own goal list, end-of-turn reporting becomes "here's what I set out to do, here's the status of each." Structure-for-free.

The spawn-time augmentation now teaches team-member subagents to use `goals_add`/`goals_check`/`goals_update` to track their own work and to use the goal list as the natural skeleton of every end-of-turn report.

### Feature: `style` parameter on `subagent_spawn`

The team-member-with-goals pattern is wrong for some subagents. The user pointed it out: *"this is just one model for subagent structure (team member working on goals), there's another (orchestrator/worker), similar to the dictionary thesaurus agents we made earlier, which works quite differently."*

Three styles now selectable via `style: "team-member" | "worker" | "minimal"` on `subagent_spawn`:

- **`team-member`** (default): owns a substantial task, decomposes into goals, reports goal-shaped status.
- **`worker`**: narrow service role, idles until requests arrive, replies tersely per-request, no goals, no children.
- **`minimal`**: only the universal end-of-turn-message-as-reply rule; orchestrator owns all other guidance via `system_prompt`.

The plumbing (end-of-turn routing, goal injection, model defaulting) is universal. Only the auto-injected coaching differs. Implemented as a `styleGuidance(style)` helper that returns the appropriate appended text.

### Goals → subagent context

Active goals (from `goals_add`) are now injected into each subagent's system prompt at spawn time. The subagent sees what the team is collectively working towards. Goals stay in the orchestrator's session but propagate down at spawn.

### Model inheritance

`subagent_spawn` and `subagent_dispatch` now default to the orchestrator's current model (`provider/id` formatted) when no `model` is specified. Override only when the user asks or the task needs a specific model.

### SKILL.md

New file at `~/src/mypi/plugins/agent-teams/SKILL.md`, symlinked into `~/.pi/agent/skills/agent-teams/SKILL.md`. Covers:
- When to use agent teams vs direct work
- Identity design (the four questions)
- Model selection guidance
- Goal sharing (orchestrator goals injected into subagents; team-member subagents track their own)
- The two stateful styles (team-member vs worker) and when to pick each
- Patterns: parallel reconnaissance, worker pool, iterative refinement, one-shot parallel, one-shot chain
- Subagent lifecycle diagram
- Coordination tips
- End-of-turn-message routing semantics

The user explicitly said: *"this shouldn't be a command, it's something that you can just do when asked to do it (more of a skill)."* Right call. Skills are persistent guidance the model carries; commands are explicit user actions. Agent teams should feel like something the orchestrator does naturally when the work suggests it.

### Cleanup

Deleted:
- `plugins/agent-teams/teams.ts`
- `plugins/agent-teams/agents.ts`
- `~/.pi/agent/agents/` (all `*.md` predefined-identity files)
- `~/.pi/agent/teams/` (all `*.md` predefined-team files)

Updated `README.md` to drop the "vestigial files are harmless" note since they no longer exist.

## What We Tested

Two scenarios.

### Test 1: PDF inventory across home dirs (failed at first, instructive)

Goal: split a PDF search across `~/Downloads`, `~/Documents`, `~/src` using parallel stateful subagents.

What happened:
- Spawn #1 blocked on its initial `send()` — uncovered the synchronous-spawn bug.
- After fixing spawn, all three spawned in parallel but sat at 0 messages — uncovered the RPC `text` vs `message` bug.
- After fixing both, polling with `wait: true` was uncancellable — uncovered the AbortSignal bug.

We then abandoned this test because the user pointed out PDF inventory is actually a poor fit for agent teams: it's parallel-independent search work, not coordination, and `find` would do it in milliseconds.

### Test 2: dictionary + thesaurus workers (succeeded)

Better fit. Two stateful workers, each with a narrow role:
- `dictionary-worker` writes definitions to `~/src/pi-agent-team-test/dictionary/<word>.txt`.
- `thesaurus-worker` writes synonyms to `~/src/pi-agent-team-test/thesaurus/<word>.txt`.

Workflow:
1. Spawn both in parallel. Each acknowledges readiness via `subagent_poll wait:true`.
2. Send each worker the same three words: `serendipity`, `ephemeral`, `ineffable`.
3. Each worker processes its three words and writes its three files.
4. Verify file contents — six files, all correct, scoped exactly to each worker's domain.
5. `subagent_stop all`.

Worked end-to-end. Demonstrated: parallel stateful subagents, multi-turn conversation per worker, scoped file I/O, model inheritance (both workers ran on Opus 4.7 because that's what the orchestrator was using), cascading stop.

### Test 3: style parameter (worker vs team-member)

After adding the `style` parameter, spawned one of each in parallel:

- `dict-worker-styled` (style: `worker`): system prompt told it to define words sent to it. Initial task was "Stand by. Acknowledge readiness briefly."
- `tm-pdf-inventory` (style: `team-member`): system prompt told it to inventory PDFs in `~/src/pi-agent-team-test/`. Initial task was "Build the PDF inventory as described. When done, report status."

Results exactly matched the design intent:

- The worker's reply to its initial task was *literally one word*: "Ready." No structure, no goals, no preamble.
- The team-member produced a goal-shaped completion report with `✓` checkmarks for each verified subgoal, despite never being explicitly asked to use that format. The auto-injected style guidance produced it organically.
- Followed up by sending the worker the word "serendipity" — it wrote `dict-styled/serendipity.txt` and replied with the path and definition. Stayed terse.
- Followed up by asking the team-member "what's on your goal list?" — it admitted it had skipped the decompose-into-goals step because the task was small enough to do in one shot, but offered to retroactively add and check goals. Reasonable judgment from the agent; the *report shape* still came out goal-shaped because the model internalized the ✓/✗ pattern from the prompt even when not using the goals tool.
- The unsupervised end-of-turn notifications surfaced both subagents' final messages in the orchestrator's chat correctly, headed `[from subagent: <id>]`, with no manual polling required.

The pattern works. Worker and team-member are both first-class.

## Open Questions / Future Work

- The `[NOTIFY]` convention is plain-text-prefix-based. It's robust enough for now but a structured tool call would be cleaner. That requires the subagent's pi process to load a tool we register, which is a bigger change.

- Subagents currently can't see the orchestrator's *todos* (the user's main session todos via the todo extension). They see goals via injection. If we want full bidirectional todo visibility, the subagent would need a tool to query the parent's todo list. That's a future enhancement.

- The user mentioned wanting to deploy this to `the-sceptre`. Will need a clean git-based deployment story. For now changes live in `~/src/mypi/plugins/agent-teams/` and are picked up via symlinks.

- Polling cancellation works in TUI (Esc). Web UI cancellation should work too if the web UI plumbs its abort through the same `AbortSignal`. Untested.

## Lessons

**Test the protocol the moment you spawn a subprocess.** The RPC `text`/`message` mismatch was invisible — spawn succeeded, the subprocess started, status said "running" — until you actually tried to get output back. A 30-second integration test would have caught it instantly. The lesson: when you have a process boundary, the *first* test should be "send a ping, get a pong."

**Async-first for any concurrent primitive.** The synchronous spawn was tempting because "spawn-and-task" is conceptually one step. But the moment you want two of them in parallel, you need them decoupled. Defaulting to fire-and-forget plus an explicit blocking poll is the right shape.

**A skill is worth a thousand tool descriptions.** Tool descriptions are constrained — they live in every prompt and have to be terse. A skill can spread out and explain *patterns*. The same orchestrator that was confusedly using `subagent_dispatch` for everything now has a clear mental model of when to use stateful spawn vs one-shot dispatch.

**"Predetermined identity" is the wrong primitive.** Pre-baked agent definitions (`.pi/agents/backend.md`, etc.) felt natural at first but they don't compose. Every real task wants a slightly different identity — different scope, different constraints, different report format. Designing the identity at spawn time costs ~20 tokens and produces a much better-fitted subagent.

**Let subagents elect to interrupt.** The model knows better than the protocol whether something is worth surfacing. Giving them an explicit `[NOTIFY]` channel with clear "use sparingly" guidance is more useful than either polling-only (orchestrator misses things) or always-push (orchestrator drowns in routine output).
