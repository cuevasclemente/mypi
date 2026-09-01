---
name: saqi-guided-search-development
description: Guide agents through developing and debugging Saqi guided restaurant/food search UX and production service health, maintaining SSE event architecture, queued turn handling, session hydration, Next.js frontend assets, and test coverage without reading secrets.
---

# Saqi Guided Search Development

This skill guides agents working in `~/src/saqi` to implement, debug, and maintain the guided search experience for restaurants and food recommendations. Saqi is a direct web service (not Claude-managed agents) with FastAPI backend, Next.js frontend, SSE event streams, session replay, and provisional candidate UX.

## Setup

1. **Navigate to project root**: `cd ~/src/saqi`
2. **Inspect architecture first**: Read key files to understand current state before modifying:
   - `backend/app/main.py` — FastAPI routes, SSE endpoints
   - `backend/app/models/` — Candidate schema, session models
   - `backend/app/services/` — Disclosure builder, search agents
   - `frontend/src/components/` — Steering pane, map toggle, candidate previews
   - `backend/tests/` and `frontend/tests/` — Existing test patterns
3. **Check environment**: Verify secrets are configured externally (`.env`, API key files) — never read their contents directly
4. **Review SSE event schema**: Understand event ordering — `disclosure_update` emitted immediately after `turn_started`

## Workflow

### 1. Understand the Architecture

- **Backend state vs. frontend hydration**: Backend maintains authoritative session state; frontend hydrates from history endpoints for replay
- **SSE event flow**: `turn_started` → `disclosure_update` → `question_*` → `candidate_*` → `turn_completed`
- **Disclosure agent**: Deterministic disclosure builder prepares search context before candidate generation
- **Candidate schema fields**: `address`, `geo`, `raw_features`, `provisional` (provisional candidates appear in facets/map/preview window before finalized)
- **Session endpoints**: `/history`, `/replay` for session hydration and continuation
- **Queued turn handling**: JSON `POST /sessions/{id}/turns` should enqueue work quickly, return `202` with turn/status metadata, process turns FIFO in the background, and stream `queue_state`/turn events from `/sessions/{id}/events` so mobile or flaky clients can reconnect without losing the session.

### 2. Implement Features with Tests

- **Backend changes**: Add route/service logic, then write pytest tests in `backend/tests/`
- **Frontend changes**: Update components (steering pane, map toggle, text input focus/word wrap), then add tests in `frontend/tests/`
- **SSE events**: When adding new events, update event schema documentation and maintain strict ordering
- **Candidate badges**: "Already visited" and "favorited" badges displayed on recommendations require backend state + frontend rendering

### 3. Debug Common Issues

- **Auth 500 triage**: Check FastAPI auth middleware, session token validation, and error logging in `backend/app/auth/`
- **Session history/replay**: Verify endpoint returns complete event history in correct order; test hydration in frontend
- **Network/SSE interruption resilience**: If a browser alert says a network error broke a session, classify whether the failure is edge/Auth, frontend bundle, API process, DB/turn status, or SSE transport. Prefer durable queued-turn state plus reconnectable session events over one long fragile request. Confirm interrupted turns become `completed` or `failed`, not permanently `running`, and that the frontend refreshes session history after an EventSource or fetch failure.
- **Text input focus**: Ensure input focus management doesn't conflict with keyboard shortcuts or map interactions
- **Map toggle**: Coordinate map visibility state between steering pane and candidate preview components
- **Questions in steering pane**: Questions should render in side pane without blocking candidate display
- **Production frontend asset failures**: If the app loads through Authentik but browser/mobile Chrome shows a generic load error, check for missing `/_next/static/chunks/...` assets, stale cached HTML, and whether the running Next process has picked up the latest `.next` build.

### 4. Production Outage Triage

Use `service-health-check` first to classify the layer, then Saqi-specific probes:

1. **Edge and Authentik path**
   ```bash
   curl -sSI -m 12 https://saqi.narwhalzero.net/ | sed -n '1,30p'
   dig +short saqi.narwhalzero.net
   timeout 12 openssl s_client -connect saqi.narwhalzero.net:443 -servername saqi.narwhalzero.net </dev/null | head -30
   ```
   Healthy unauthenticated behavior is usually a Caddy `302` to `auth.narwhalzero.net`; that means DNS/TLS/Caddy/Authentik are probably not the failing layer.
2. **Local services and API**
   ```bash
   systemctl is-active saqi-api.service saqi-frontend.service
   curl -sS -m 8 -H 'X-Authentik-Username: ryan' http://127.0.0.1:3050/api/me | python -m json.tool | head
   ```
   Do not read `.env` or secret files. Public test headers are acceptable for local unauthenticated smoke tests only when the endpoint is designed for Authentik header auth.
3. **Next.js chunk validation**
   ```bash
   cd /home/clemente/src/saqi/frontend
   curl -sS -m 8 http://127.0.0.1:3050/ > /tmp/saqi-page.html
   python - <<'PY'
   import pathlib, re, sys
   root = pathlib.Path('/home/clemente/src/saqi/frontend/.next')
   html = pathlib.Path('/tmp/saqi-page.html').read_text(errors='replace')
   missing = []
   for url in dict.fromkeys(re.findall(r'/_next/static/chunks/[^"<>\\]+', html)):
       path = root / url.removeprefix('/_next/')
       print(('OK   ' if path.exists() else 'MISS '), url)
       if not path.exists(): missing.append(url)
   sys.exit(1 if missing else 0)
   PY
   ```
4. **Repair a stale production bundle**
   - Run `cd frontend && npm run build`.
   - Prefer an authorized `systemctl restart saqi-frontend.service`. If sudo/command guard blocks and the service is user-owned with `Restart=on-failure`, a narrowly scoped process kill can let systemd restart it; explain this before doing it and validate immediately.
   - If mobile clients cached HTML with one stale missing chunk, consider a temporary compatibility copy from the corresponding new chunk filename, then restart the frontend so the static handler serves it. Treat this as a bridge, not a replacement for a clean build/reload.
5. **Final validation**
   - `saqi-api.service` and `saqi-frontend.service` active.
   - Local `/api/me` smoke test returns 200.
   - Current page references no missing chunks.
   - Any known stale chunk URL returns 200 or clients have been told to hard-refresh/clear site data.
   - Public edge still returns expected Authentik redirect.
6. **Journal the incident** in `~/src/saqi/docs/JOURNAL.md` with diagnosis, fix, and exact validation probes.

### 5. Validate Changes

Run test suites **without reading secrets** (tests use mocks/fixtures):

```bash
# Backend tests
cd backend
pytest

# Frontend tests
cd frontend
npm test
```

Check SSE event ordering manually:
- Open browser DevTools Network tab
- Filter for EventSource/SSE connections
- Verify `disclosure_update` appears immediately after `turn_started`
- Confirm candidate events include all schema fields

### 5. Document Patterns

When implementing non-obvious patterns:
- Add inline comments explaining SSE event dependencies
- Document disclosure builder deterministic behavior
- Note provisional candidate lifecycle (when/how they transition to finalized)

## Validation Checklist

- [ ] Inspected relevant architecture files before modifying
- [ ] Backend changes include pytest tests
- [ ] Frontend changes include npm tests
- [ ] SSE event ordering preserved (`disclosure_update` after `turn_started`)
- [ ] Candidate schema fields complete (`address`, `geo`, `raw_features`, `provisional`)
- [ ] Session history/replay hydration tested
- [ ] Queued turn/idempotency semantics tested: duplicate `client_message_id` does not create duplicate work, FIFO order is preserved, `/events` starts with a queue snapshot, and interrupted streams can reconnect.
- [ ] No secrets read directly (API keys, tokens stay in config files)
- [ ] Both backend and frontend test suites pass
- [ ] Browser DevTools confirms SSE event schema in live session
- [ ] Production checks pass when relevant: Caddy/Auth redirect, local API smoke, Next.js chunk references, and service active status

## Examples

### Example 1: Add New Candidate Field

**Task**: Add `cuisine_tags` field to candidate schema.

1. Inspect: `backend/app/models/candidate.py`
2. Add field to Pydantic model with default value
3. Update disclosure builder to populate field in `backend/app/services/disclosure.py`
4. Write test in `backend/tests/test_candidate_schema.py` verifying field presence
5. Update frontend component to display tags in `frontend/src/components/CandidateCard.tsx`
6. Add frontend test in `frontend/tests/CandidateCard.test.tsx`
7. Run `pytest` (backend) and `npm test` (frontend)
8. Verify in browser DevTools that SSE candidate events include `cuisine_tags`

### Example 2: Debug Session Replay 500 Error

**Task**: Session replay returns 500 when rehydrating long sessions.

1. Check FastAPI logs for stack trace (likely in auth or history endpoint)
2. Inspect `backend/app/routes/session.py` `/replay` endpoint
3. Verify session token validation in `backend/app/auth/`
4. Add test case in `backend/tests/test_session_replay.py` with >50 events
5. Fix pagination or timeout issue in history query
6. Confirm test passes with `pytest backend/tests/test_session_replay.py`
7. Test in browser with long session; verify hydration completes without 500

### Example 3: Implement Provisional Candidate Preview

**Task**: Show provisional candidates in map and facet preview before finalization.

1. Review candidate schema: `provisional: bool` field already exists
2. Update map component in `frontend/src/components/Map.tsx` to render provisional markers with distinct style
3. Update facet preview in `frontend/src/components/FacetPanel.tsx` to badge provisional items
4. Ensure SSE `candidate_update` event includes `provisional` field
5. Write frontend tests for provisional rendering in both components
6. Backend: verify disclosure builder sets `provisional=True` during search preparation phase
7. Add backend test confirming provisional candidates transition to `provisional=False` after confirmation
8. Run full test suite; validate in DevTools that events have correct provisional state

### Example 4: Recover a Production Stale Chunk Outage

**Task**: Mobile Chrome reports the Saqi page could not load after Authentik.

1. Confirm `https://saqi.narwhalzero.net/` returns the expected Authentik `302`, not a Caddy `502` or TLS failure.
2. Check `saqi-api.service` and `saqi-frontend.service` are active.
3. Fetch local frontend HTML and verify every `/_next/static/chunks/...` reference exists under `frontend/.next/static/chunks/`.
4. If a chunk is missing, rebuild with `cd frontend && npm run build`.
5. Restart `saqi-frontend.service` through authorized systemd control; if unavailable, use the narrowest documented restart-on-failure workaround and validate the new PID.
6. If a stale mobile HTML file still requests one old chunk, add a temporary compatibility copy only after identifying the replacement chunk, then restart again.
7. Validate current and stale chunk URLs return `200`, local `/api/me` returns `200`, and the public edge still redirects to Authentik.
8. Append an incident entry to `docs/JOURNAL.md`.

---

**Key Principle**: Saqi is a direct web service with backend-authoritative state, SSE-driven UX, and comprehensive test coverage. Always inspect architecture before modifying, maintain event ordering, separate backend state from frontend hydration, and validate with tests before handoff.
