---
name: shared-streaming-tts-broker-development
description: Develop, deploy, and troubleshoot a shared local TTS broker for Wayang read-aloud and report-publisher narration, including FastAPI job APIs, SSE progress, chunk/final audio serving with Range support, Chatterbox provider adapters, adaptive split/retry, broker/direct fallback, client integrations, validation, and live smoke tests without exposing secrets.
---

# Shared Streaming TTS Broker Development

## Setup

- Work in `~/src/server-lattice` for the broker/report-publisher side and `~/src/wayang` for Wayang integration.
- Typical components:
  - `apps/tts-broker`: FastAPI local TTS broker.
  - `apps/report-publisher-mcp`: report artifact/narration producer.
  - `~/src/wayang/backend`: read-aloud API and broker proxy.
  - `~/src/wayang/frontend`: read-aloud playback UI.
- Use secret-safe configuration boundaries:
  - Do not read `.env`, token files, API keys, or service credentials.
  - It is OK to reference env var names and config paths.
  - Let the user set secrets or private endpoints when needed.
- Useful env/config names:
  - `TTS_BROKER_STATE_DIR`
  - `TTS_BROKER_PROVIDER_ENDPOINT`
  - `WAYANG_TTS_BROKER_URL`
  - `WAYANG_TTS_BASE_URL` as legacy/direct fallback
  - report-publisher TTS fields such as `use_broker` and `broker_base_url`

## Core workflow

1. **Read the plan and inventory current TTS paths**
   - Start from any local plan such as `docs/plans/shared-streaming-tts-architecture.md`.
   - Locate direct Chatterbox usage in Wayang and report-publisher.
   - Identify whether the desired behavior is interactive streaming playback, final report artifact generation, or both.

2. **Implement or inspect the broker service**
   - Provide a job-oriented API:
     - `POST /v1/tts/jobs` to create or reuse jobs by idempotency key.
     - `GET /v1/tts/jobs/{job_id}/manifest` for status, progress, chunks, final audio, errors.
     - `GET /v1/tts/jobs/{job_id}/events` for SSE progress events.
     - chunk audio endpoints and final `audio.mp3` with HTTP Range support.
   - Persist manifests and audio under `TTS_BROKER_STATE_DIR` so refresh/retry does not lose state.
   - Include cancellation and bounded concurrency so one consumer cannot monopolize Chatterbox.

3. **Isolate the provider adapter**
   - Keep Chatterbox-specific behavior behind an adapter.
   - Use finite timeouts for chunk rendering.
   - Consider one optional provider restart retry after 5xx/provider memory-pressure symptoms.
   - Record enough manifest metadata to debug provider failures without logging secrets.

4. **Chunk, split, retry, and concatenate safely**
   - Start conservatively, e.g. 500–800 characters per chunk until benchmarks prove higher is stable.
   - On retryable provider failures, split the failed chunk rather than restarting the whole job.
   - Preserve parent/lineage metadata for split chunks so progress is understandable.
   - Concatenate chunk audio into final `audio.mp3` for artifact/replay clients.

5. **Integrate report-publisher as an artifact client**
   - Add broker-aware rendering that submits a job, polls/streams progress, and copies final audio into the report package, typically as `narration.mp3`.
   - Do not require the MCP publish request to remain open until long narration completes; persist the broker job ID and return a pending/`audio_rendering` status when needed.
   - Write progress/final TTS metadata into `metadata.json` or the report’s normal artifact metadata.
   - Add an idempotent finalizer/recovery path that can scan pending reports, read broker manifests, attach completed final audio, update metadata, and report completed/skipped/failed counts.
   - For OpenCloud PosixFS packages, refresh/normalize OpenCloud xattrs after finalizing audio or rewriting metadata so the web UI recognizes the folder and stops spinning.
   - Keep direct Chatterbox mode as a compatibility/debug fallback; tests should not require a live broker unless explicitly marked as smoke tests.

6. **Integrate Wayang as an interactive streaming client**
   - Backend:
     - Extract assistant-visible text as before.
     - Submit a broker job when `WAYANG_TTS_BROKER_URL` is set.
     - Proxy broker manifests, SSE events, chunks, and final audio under Wayang `/api/tts/*` routes so the browser does not need direct broker access.
     - Retain `WAYANG_TTS_BASE_URL` direct mode as fallback.
   - Frontend:
     - Subscribe to SSE for job progress.
     - Play completed chunks sequentially.
     - Show preparing/submitting/generating/buffering/progress/final-audio states.
     - Expose final audio for replay/seeking when available.

7. **Deploy carefully**
   - Start broker bound locally first, for example `127.0.0.1:8788`.
   - Configure provider endpoint separately from secrets.
   - Set Wayang runtime `WAYANG_TTS_BROKER_URL=http://127.0.0.1:8788` only after broker health passes.
   - Enable report-publisher broker mode in the real runtime config only after a non-sensitive smoke test.

## Validation

Run unit/build validation before live smoke:

```bash
cd ~/src/server-lattice/apps/tts-broker && uv run pytest
cd ~/src/server-lattice/apps/report-publisher-mcp && uv run pytest
cd ~/src/wayang && npm --prefix backend run build && npm --prefix frontend run build
```

Live smoke checklist:

1. Broker health/manifest endpoint returns successfully.
2. Submit a short non-sensitive TTS job and verify:
   - manifest reaches completed,
   - chunks are downloadable,
   - final `audio.mp3` supports Range requests.
3. In Wayang, click read-aloud on a short assistant message and confirm SSE progress plus sequential playback.
4. In report-publisher, run a non-sensitive report with TTS and confirm `narration.mp3` plus metadata are included.

## Common pitfalls

- Do not make tests depend on a live broker by default; use mocks or direct-mode defaults for unit tests.
- Avoid large chunks until Chatterbox stability is measured; adaptive split/retry is safer.
- Do not expose the broker broadly until access boundaries are decided.
- Preserve direct fallback paths to simplify rollback.
- Do not tie long-running report narration to one MCP request lifetime; completed broker jobs must be recoverable later.
- When diagnosing OpenCloud report folders that spin, check for pending TTS metadata, missing `narration.mp3`, stale broker manifests, and missing OpenCloud xattrs before assuming an auth problem.
- Do not read or print service `.env` contents; ask the user to set env vars.
- After modifying Wayang and server-lattice together, validate both builds and journal deployment follow-up.