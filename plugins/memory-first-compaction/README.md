# Memory-first compaction

Source-controlled Pi extension for using authorized persisted memory before ordinary long-context compaction. It does not create capsules or episodes, replace Pi's compaction summary, install itself, or modify Pi runtime configuration.

## Independent opt-in flags

Every behavior is disabled unless its exact value is `on`; no flag enables another flag.

| Environment variable | Behavior |
|---|---|
| `PI_MEMORY_CONTEXT_GUIDANCE=on` | Adds concise `before_agent_start` guidance about future-value persisted memory, scheduled runs, and subagent handoff. |
| `PI_MEMORY_CONTEXT_REVIEW=on` | At 96,000 context tokens, queues one context-bearing first review reminder per compaction generation and registers `memory_review_complete`. |
| `PI_MEMORY_CONTEXT_COMPACTION=on` | At 128,000 tokens, requests ordinary `ctx.compact()` after a recorded review outcome or one completed retry turn. Also registers the review tool. |
| `PI_MEMORY_CONTEXT_LEDGER=on` | Enables the separate metadata-only JSONL ledger only when an explicit absolute path and HMAC key are both valid. |

The bounded review tool accepts only:

```text
wrote | read_only | not_relevant | blocked
```

It has no field capable of accepting memory text. Reminder queue/start state, outcomes, compaction requests/failures, and generation resets are reconstructed from strict `memory-first-compaction.state.v1` custom entries on the active branch.

## Reminder and compaction ordering

- `agent_end` queues first/retry reminders with `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.
- `before_agent_start` injects a reminder only for reload/high-context recovery; normal follow-up continuations do not emit that hook. Matching delivered custom messages transition queued state on `message_start`/`message_end`, and delivered `custom_message` branch entries reconstruct that transition after reload.
- Native `reason="threshold"` compaction at or above 96K may be cancelled while the first/retry review turn is still available. Once review completes or the retry is consumed, native threshold compaction proceeds.
- Native thresholds below 96K proceed for smaller-context models.
- Manual and overflow compaction are always synchronous pass-through: never cancelled, awaited, or delayed.
- Extension-owned ordinary `ctx.compact()` runs only from `agent_settled`, with no pending messages, avoiding races with native compaction and queued turns.
- Every `session_compact`, regardless of origin, resets the review generation.

Ordinary Pi compaction honors configured `keepRecentTokens` (20K by default). Use `/memory-context-status` to inspect flags, tokens, generation, pending reminder, review outcome, retry, compaction request, and ledger health.

## Guidance boundary

Only an **authorized Memoriki** or a **privacy-matched project wiki** is treated as persisted short- and long-term future-value memory. Useful memory includes ongoing activities and projects, decisions, commitments, preferences, and reusable facts—not only timeless facts. This prompt does not grant memory authority. Scheduled runs continue safe independent work rather than waiting for input. Subagents return future-value memory candidates to their parent unless explicitly authorized to write matching memory.

## Metadata-only ledger

Ledger activation fails closed unless both are present:

- `PI_MEMORY_CONTEXT_LEDGER_PATH`: an explicit **absolute** JSONL destination; there is no default
- `PI_MEMORY_CONTEXT_LEDGER_HMAC_KEY`: at least 32 bytes

The extension does not discover or read key files. Tests inject a fixture key and temporary paths.

Optional source classification:

- `PI_MEMORY_CONTEXT_SOURCE_CLASS`: `interactive`, `rpc`, `scheduled`, `subagent`, or `unknown`
- `PI_SCHEDULED_TASK=1` / `WAYANG_SCHEDULED_TASK=1`
- `PI_AGENT_ROLE=subagent` / `MYPI_SUBAGENT=1`

Strict metadata event classes:

- `context_usage`: threshold context-token snapshots
- `request_usage`: every assistant request's input/output/cache-read/cache-write/total tokens, bounded outcome, and HMAC provider/model-local IDs
- `compaction_usage`: compaction-summary request usage with the same components and local IDs when Pi supplies summary usage
- `review`: bounded review outcome
- `compaction`: bounded cause and pre-compaction context tokens

Records contain HMAC event/session/provider/model IDs, never raw IDs. The current active-branch leaf/boundary participates only in the HMAC event-ID input, preventing alternate-branch collisions without persistence. State reconstruction always uses `getBranch()`—an empty active branch never falls back to abandoned entries. Records contain no content, prompts, responses, memory text, filesystem paths, or project paths.

Directories/files exclude group/other access (`0700`/`0600` normally); symlinks and multiply linked files are rejected. Locks carry private PID+nonce ownership and use a bounded two-second default wait. Live or unknown owners are never removed; stale reclaim requires age, a verified-dead PID, atomic rename, and matching-owner revalidation; release removes only its own nonce. Appends are fsynced, duplicate event IDs are skipped, trailing partial writes recover, and malformed complete records fail closed.

## Aggregate and prune maintenance

Ordinary ledger operation is append-only. Maintenance requires an explicit, distinct private aggregate JSONL path:

```bash
npm run ledger:memory-context -- /absolute/path/to/metadata.jsonl \
  --aggregate /absolute/path/to/aged-aggregates.jsonl \
  --now 2026-08-27T00:00:00.000Z --days 90
```

For a fixed input/time, the helper deterministically:

1. deduplicates raw event IDs;
2. aggregates **only records being aged out** by UTC day/event/source/dimension, including all token components;
3. appends deterministic aggregate IDs to the private aggregate JSONL (deduped and fsynced);
4. atomically rewrites the raw ledger with validated retained records.

Writing aggregates before pruning makes reruns recoverable: a failure between those steps dedupes the already-written aggregate on retry. The command reports the actual number appended, and parent directories are fsynced after aggregate creation and raw-ledger rename where the platform supports directory fsync.

The append path currently validates/scans the full JSONL for dedupe and recovery. That scaling characteristic is intentionally unchanged for this pre-canary phase and must be load-tested before live rollout; it is not a reason to weaken lock ownership or risk silent content loss.

## Validation

```bash
npm run test:memory-first-compaction
npm run check:memory-first-compaction
```
