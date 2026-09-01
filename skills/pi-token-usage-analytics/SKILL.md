---
name: pi-token-usage-analytics
description: Build, operate, and troubleshoot pi token usage tracking/analytics for pi by scanning session JSONL and realtime usage, aggregating by model/provider/time into ~/.pi/tokens/usage.json, and exposing safe /tokens reports.
---

# pi-token-usage-analytics

Use this skill when adding, maintaining, or debugging pi token usage analytics, including backfills from session JSONL, realtime usage hooks/extensions, `~/.pi/tokens/usage.json`, and `/tokens` reports.

## Core requirements

- Aggregate token usage by time period, provider, and model into `~/.pi/tokens/usage.json`.
- Source historical usage from pi session JSONL files under `~/.pi/agent/sessions/**/**/*.jsonl`.
- Source realtime usage from assistant `message_end` hook/extension metadata.
- Support `/tokens today`, `/tokens week`, `/tokens month`, `/tokens all`, `/tokens scan`, `/tokens clear`, and `/tokens since <date-or-duration>`.
- Provide a standalone scan script fallback so analytics can be rebuilt without relying on the extension runtime.
- Never copy secrets into analytics. Parse metadata only; do not inspect transcript text for secrets and do not read secret files.

## Data sources and extraction

### Session JSONL backfill

Scan `~/.pi/agent/sessions/**/**/*.jsonl` incrementally. For each line:

1. Parse as JSON; tolerate corrupt lines by recording an error count and continuing.
2. Select assistant-message records only.
3. Extract usage/provider/model/timestamp from metadata fields, preferring explicit structured fields over text.
4. Accept common usage shapes such as:
   - `usage.input_tokens`, `usage.output_tokens`, `usage.total_tokens`
   - `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`
   - nested assistant/message usage metadata when present
5. If provider/model is absent, record `unknown` rather than guessing.
6. Do not parse prompt/response text for usage or secrets.

Dedupe scans by file path plus mtime. Store per-file scan state so rerunning `/tokens scan` does not double count unchanged files. If a file mtime changes, recompute that file's contribution and rebuild totals from current per-file plus realtime records.

### Realtime tracking

Use a `message_end` hook/extension to capture finalized assistant response metadata:

- timestamp
- provider
- model
- input/prompt tokens
- output/completion tokens
- total tokens
- session id when available
- stable message/event id when available

Keep realtime event identifiers to avoid double-counting if hooks retry or extension state reloads. Do not store message text.

## Storage model

Persist analytics at `~/.pi/tokens/usage.json`. Create parent directories if needed. Use atomic writes when implementing.

Recommended top-level shape:

```json
{
  "version": 1,
  "updatedAt": "ISO-8601 timestamp",
  "totals": {
    "inputTokens": 0,
    "outputTokens": 0,
    "totalTokens": 0,
    "requests": 0
  },
  "byDay": {},
  "byProvider": {},
  "byModel": {},
  "byProviderModel": {},
  "files": {
    "/path/to/session.jsonl": {
      "mtimeMs": 0,
      "records": 0,
      "inputTokens": 0,
      "outputTokens": 0,
      "totalTokens": 0,
      "errors": 0
    }
  },
  "realtime": {
    "events": {},
    "totals": {}
  }
}
```

For large installations, store compact per-file aggregates rather than full transcript-derived events. If event retention is needed for `/tokens since`, keep only metadata fields and prune or compact safely.

## `/tokens` command behavior

- `/tokens today`: report totals since local start of day.
- `/tokens week`: report totals for the current local week.
- `/tokens month`: report totals for the current local month.
- `/tokens all`: report all stored usage.
- `/tokens since <date-or-duration>`: report usage since an ISO date/time or duration like `24h`, `7d`, `30d`.
- `/tokens scan`: run the JSONL backfill scanner and refresh aggregates.
- `/tokens clear`: require explicit confirmation before removing or resetting `~/.pi/tokens/usage.json`; prefer recoverable backup/rename over permanent deletion.

Reports should include total requests, input tokens, output tokens, total tokens, and breakdowns by provider/model. Keep output concise and avoid printing transcript contents.

## Validation checklist

When changing this feature:

1. Validate `~/.pi/tokens/usage.json` with JSON parsing after writes.
2. Run a backfill scan and compare the number of discovered `.jsonl` files with the scanner's processed/skipped/error counts.
3. Verify unchanged files are skipped and not double-counted on a second scan.
4. Test changed-file behavior by rescanning a small fixture and confirming totals are replaced, not added twice.
5. Exercise `/tokens today`, `/tokens week`, `/tokens month`, `/tokens all`, and `/tokens since` with sample data.
6. Verify realtime `message_end` events add one request per assistant response and dedupe retries.
7. Confirm reports never include transcript text, API keys, credentials, or contents of secret files.
8. Do not read key files, `.env`, `credentials.json`, or other secret-bearing files during validation.

## Troubleshooting

- If totals are too high, check file path + mtime dedupe and realtime retry dedupe first.
- If totals are too low, inspect whether the provider/model's usage schema differs from supported shapes.
- If JSON parsing fails, preserve the old usage file, write a repaired file atomically, and report the error path without exposing transcript content.
- If `/tokens since` is inaccurate, ensure enough time-bucketed or event metadata is retained to support the requested window.
- If the extension is unavailable, use the standalone scanner to rebuild historical aggregates from session JSONL.
