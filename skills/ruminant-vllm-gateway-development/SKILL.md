---
name: ruminant-vllm-gateway-development
description: Develop, validate, and operate Ruminant, Clemente's server-lattice revocable idle-lease gateway in front of narwhal-horn vLLM, including OpenAI-compatible foreground proxying, durable SQLite rumen queues, immediate foreground preemption/cancel/requeue semantics, dummy and future email/sender enrichment plugins, LAN/VPN exposure decisions, and secret-safe smoke tests.
---

# Ruminant vLLM Gateway Development

## Setup

Use this skill when working on `/home/clemente/src/server-lattice/apps/ruminant`, the server-lattice app that sits in front of narwhal-horn's OpenAI-compatible vLLM server.

Relevant non-secret files:

- Plan: `/home/clemente/src/server-lattice/docs/plans/ruminant.md`
- App: `/home/clemente/src/server-lattice/apps/ruminant/`
- README: `/home/clemente/src/server-lattice/apps/ruminant/README.md`
- Journal pattern: `/home/clemente/src/server-lattice/docs/journals/`

Default runtime facts from the source sessions:

- Ruminant local port: `8055`
- Default bind: `127.0.0.1` until LAN/VPN auth is explicitly chosen
- Upstream vLLM base URL from server-lattice host: `http://192.168.50.216:8090` without `/v1`
- Observed model: `Qwen3.6-35B-A3B-Abliterated-Heretic-Q6_K.gguf`
- Python project uses `uv`, FastAPI, httpx, SQLite WAL, pytest, and ruff

Do **not** read `.env`, token files, API key files, cookies, private keys, or other secret-bearing files. It is OK to reference secret paths/env var names and let the runtime load opaque values.

## Core model

Ruminant is the default gateway for foreground vLLM clients and a background queue for low-priority batch work.

Vocabulary:

- **Ruminant** — the gateway + queue service.
- **Rumen** — durable queue/holding area.
- **Cud** — resumable unit of queued work.
- **Chewing** — actively processing a cud through vLLM.
- **Revocable idle lease** — permission to use narwhal-horn only while foreground pressure is absent.
- **Yield / lease revocation** — foreground traffic immediately cancels background work and requeues the cud.

Invariant:

> Ruminant never owns narwhal-horn compute. It only chews under a revocable idle lease. Foreground traffic gets first claim.

## Workflow

### 1. Orient before editing

```bash
cd /home/clemente/src/server-lattice/apps/ruminant
read ../../docs/plans/ruminant.md
read README.md
rg -n "TODO|dummy_sleep|lease|foreground|scheduler|cud|job|vllm" src tests README.md
```

Check current implementation phase in the plan/README. As of the source sessions, Phase 1 foreground gateway and a Phase 2 durable queue skeleton are implemented; real vLLM-backed background plugins and email/sender enrichment are not.

### 2. Preserve the foreground gateway behavior

Ruminant should proxy OpenAI-compatible foreground endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/completions`

Foreground path requirements:

1. Increment foreground pressure/active request state.
2. Revoke any active background idle lease.
3. Cancel/close in-flight background upstream request when applicable.
4. Forward foreground request to narwhal-horn immediately.
5. Support streaming and non-streaming responses.
6. Decrement foreground state and start a short cooldown.

When debugging a foreground issue, probe locally first:

```bash
curl -s http://127.0.0.1:8055/health
curl -s http://127.0.0.1:8055/ruminant/status | jq
curl -s http://127.0.0.1:8055/v1/models | jq
```

Use Ruminant as an OpenAI-compatible base URL:

```text
http://127.0.0.1:8055/v1
```

### 3. Maintain durable rumen semantics

The SQLite queue tracks at least:

- `jobs` — high-level job kind/status/config/progress
- `cuds` — work units with status, payload, attempt counts, next retry time
- `attempts` — run/yield/failure/success records
- `leases` — active/revoked/released idle leases and revocation reasons

Default cud lifecycle:

```text
queued -> claimed -> chewing -> digested
                    -> yielded -> queued
                    -> failed_retryable -> queued
                    -> failed_terminal
                    -> cancelled
```

Rules:

- Commit only complete, validated results.
- Discard partial output from cancelled/yielded generation.
- Record yielded attempts with reason such as `foreground_pressure`.
- Requeue yielded cuds without double-writing downstream annotations.
- Queue state must survive process restart.

### 4. Validate with the dummy plugin before real plugins

The first implemented plugin is `dummy_sleep_v1`. Use it to validate scheduling, lease revocation, restart recovery, and admin controls before adding real LLM work.

Create a dummy job:

```bash
curl -s http://127.0.0.1:8055/ruminant/jobs \
  -H 'Content-Type: application/json' \
  -d '{"kind":"dummy_sleep_v1","cuds":[{"sleep_seconds":5}]}' | jq
```

Inspect and control jobs:

```bash
curl -s http://127.0.0.1:8055/ruminant/jobs | jq
curl -s 'http://127.0.0.1:8055/ruminant/cuds?status=queued' | jq
curl -X POST http://127.0.0.1:8055/ruminant/jobs/<job-id>/pause
curl -X POST http://127.0.0.1:8055/ruminant/jobs/<job-id>/resume
curl -X POST http://127.0.0.1:8055/ruminant/jobs/<job-id>/cancel
```

Expected behavior: while dummy chewing is active, a foreground `/v1/...` request revokes the lease and returns the cud to `queued`.

### 5. Probe upstream vLLM and cancellation safely

Use the provided probe script rather than improvising secret-printing diagnostics:

```bash
cd /home/clemente/src/server-lattice/apps/ruminant
uv run ruminant-cancel-probe --status --abort-after 3
```

If model inference from `/v1/models` fails:

```bash
uv run ruminant-cancel-probe --model '<model-id>' --status
```

The script may read `RUMINANT_API_KEY` or `VLLM_API_KEY` from the environment, but must not print token values.

### 6. Add real background plugins cautiously

First real job types are expected to be:

- email dimension classification
- sender/domain enrichment

Plugin guidance:

- Keep queue core generic; do not bake email logic into scheduler/lease code.
- Load source content at chew time from the owning app/database.
- Use structured JSON/Pydantic validation for outputs.
- Use idempotent downstream writes keyed by email/job/schema/version.
- Start with limited dry-runs, e.g. 100-500 emails, before large backfills.
- Sensitivity should be level + types, not only a boolean.
- Batch for throughput, but split batches after repeated validation failures or excessive cancellation waste.

Example output shape for email classification:

```json
{
  "email_id": 123,
  "personal_email": true,
  "receipt": false,
  "order_related": true,
  "company_or_automated": true,
  "sensitive": {
    "contains_sensitive_info": true,
    "level": "medium",
    "types": ["financial", "account", "identity"]
  },
  "confidence": 0.87
}
```

### 7. Keep exposure conservative

- Bind loopback by default.
- Do not expose publicly without an explicit auth design.
- LAN/VPN exposure is acceptable only after deciding network trust, bearer token, mTLS, or Authentik/service-token behavior.
- If installing systemd, use the template only after manual proxy and cancellation validation:

```bash
sudo cp systemd/ruminant.service /etc/systemd/system/ruminant.service
sudo systemctl daemon-reload
sudo systemctl enable --now ruminant.service
```

Use the sudo skill/handoff rules for privileged commands. Do not run service changes during planning-only sessions.

## Validation checklist

From the app directory:

```bash
uv run ruff check .
uv run pytest
uv run python -m compileall src scripts tests
```

Runtime smoke tests:

```bash
curl -s http://127.0.0.1:8055/health
curl -s http://127.0.0.1:8055/ruminant/status | jq
curl -s http://127.0.0.1:8055/v1/models | jq
```

For queue/preemption changes, include a dummy job test plus a foreground request during chewing and verify:

- active lease becomes revoked/released
- active cud returns to `queued` or records the expected yielded attempt
- foreground request completes promptly
- no partial output is committed
- restart recovery leaves interrupted cuds retryable

## Journaling and handoff

For material changes, update a project journal under:

```text
/home/clemente/src/server-lattice/docs/journals/YYYY-MM-DD-ruminant-*.md
```

Mention:

- files changed
- validation commands and results
- upstream reachability/model observations
- whether service installation/restart was performed
- remaining blockers, especially auth, cancellation, or real-plugin gaps

## Common pitfalls

- Do not let background producers call narwhal-horn directly; they should submit jobs/cuds to Ruminant.
- Do not rely on vLLM priority scheduling for the initial design; the gateway owns cancellation/requeue semantics.
- Do not treat partial streamed output as valid after cancellation.
- Do not enable LAN/public access as a side effect of local development.
- Do not print prompts containing private email/file contents into logs or agent transcripts unless explicitly authorized and local-only.
- Do not read or copy secret env/token files while debugging auth.
