---
name: wayang-session-history-search
description: Implement and debug Wayang session history search—backend keyword indexing over pi JSONL, SQLite FTS5, frontend search UX with message anchors, validation, and safe indexing lifecycle.
---

# Wayang Session History Search

Guide agents implementing, extending, or debugging Wayang's searchable session history feature. Covers backend keyword indexing (SQLite + FTS5), frontend search UX, result navigation, indexing safety, validation, and the deferred semantic/hybrid path.

**Use wayang-session-debugging for lifecycle/reconnect issues; use this skill for search/index/navigation.**

## Context & Architecture

Wayang's session history search allows users to search past sessions by keyword from the SessionsPanel UI and jump directly to relevant messages. The system is built in phases:

- **M1–M2 (shipped)**: Keyword search via SQLite FTS5, frontend UX with filters and result snippets, click-to-scroll message navigation.
- **M3 (deferred)**: Semantic/hybrid search via HTTP embedder client (OpenAI-compatible endpoint) with RRF fusion.

### High-Level Flow

```
store.json + pi JSONL files
    ↓
  indexer (lazy + 30s mtime-poll watcher)
    ↓
  search.db (chunks, chunks_fts, session_index_state)
    ↓
  GET /api/sessions/search (BM25 + filters + snippets)
    ↓
  SessionsPanel UI → ChatPanel scroll-to-message
```

### Key Files

**Backend:**
- `backend/src/search/db.ts` — SQLite schema (chunks, chunks_fts, session_index_state)
- `backend/src/search/chunker.ts` — Parse pi JSONL, pack user/assistant text into ≤2000-char chunks with 200-char overlap
- `backend/src/search/indexer.ts` — `indexSession`, `reindexAll`, `removeSession`
- `backend/src/search/watcher.ts` — Boot backfill + 30s mtime-poll loop
- `backend/src/search/search.ts` — BM25 query, snippet highlighting, filters, facets
- `backend/src/search/index.ts` — Public API surface
- `backend/src/routes/search.ts` — Express routes

**Frontend:**
- `frontend/src/panels/SessionsPanel.tsx` — Search input, debounce, filter strip, result list
- `frontend/src/components/SessionResultSnippet.tsx` — Sanitize & render `<mark>` snippets
- `frontend/src/panels/ChatPanel.tsx` — `scrollToMessageId`, `data-message-id` anchors

**Planning & Docs:**
- `docs/plans/session-history-search.md` — Full design, resolved decisions, M3 architecture
- `docs/journals/2026-05-16-session-history-search-m1-m2.md` — Implementation journal
- `docs/session-history-search.md` — Operator-facing guide

## Setup

1. **Verify dependencies**: `backend/package.json` includes `better-sqlite3` and `@types/better-sqlite3`.
2. **Locate search.db**: Lives at `<WAYANG_DATA_DIR>/search.db` (typically `~/.wayang/search.db`).
3. **Check watcher status**: `curl http://localhost:3001/api/sessions/search/health` shows indexed session count, pending count, schema version.
4. **Confirm pi session files**: Run `ls ~/.pi/agent/sessions/*/*_*.jsonl | wc -l` to count existing JSONL files. Compare with `store.json` session count.

## Workflow

### Implementing New Search Features

**Step 1: Review the plan**
```bash
cat ~/src/wayang/docs/plans/session-history-search.md
```
Read §7a (resolved decisions) and the relevant milestone section (M1/M2/M3/M4).

**Step 2: Identify the module**
- Adding a filter? → `backend/src/search/search.ts` + `SearchFilters` type + `SessionsPanel.tsx` filter strip
- Changing chunk logic? → `backend/src/search/chunker.ts` + bump `SCHEMA_VERSION` in `db.ts`
- Adding semantic search? → Start with plan §6 (HTTP embedder architecture)

**Step 3: Write tests first**
- Unit: `backend/src/search/*.test.ts` (chunker, indexer isolation)
- e2e: `e2e/tests/session-search.spec.ts` (Playwright)

**Step 4: Implement & validate**
- Make changes in the identified module
- Run `cd backend && NODE_ENV=development npm test`
- Run `cd e2e && NODE_ENV=development npx playwright test session-search`
- Manually test via UI: type query → verify results → click → confirm scroll

**Step 5: Force reindex if schema changed**
```bash
curl -X POST http://localhost:3001/api/sessions/search/reindex
```

### Debugging Indexing Issues

**Step 1: Check health endpoint**
```bash
curl http://localhost:3001/api/sessions/search/health | jq
```
Look for:
- `total_sessions` vs `indexed_sessions` gap
- `pending` count (should drop to 0 after watcher runs)
- `last_error` field

**Step 2: Inspect session_index_state**
```bash
sqlite3 ~/.wayang/search.db "SELECT session_id, error FROM session_index_state WHERE error IS NOT NULL LIMIT 10"
```
Common errors:
- Missing `pi_session_file` → session has no JSONL yet
- JSONL parse failure → corrupt file or schema drift
- NaN createdAt → missing `timestamp` in JSONL (defensive guards exist in `sessions.ts`)

**Step 3: Check watcher logs**
```bash
# Backend logs show watcher activity every 30s
tail -f ~/.wayang/backend.log | grep -i watcher
```

**Step 4: Force reindex a specific session**
```bash
curl -X POST http://localhost:3001/api/sessions/search/reindex \
  -H "Content-Type: application/json" \
  -d '{"session_id":"<uuid>"}'
```

**Step 5: Verify chunks**
```bash
sqlite3 ~/.wayang/search.db "SELECT COUNT(*), session_id FROM chunks GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 10"
```
Expect: ~few-to-hundreds of chunks per session depending on transcript length.

### Debugging Frontend Search UX

**Step 1: Check API response**
Open DevTools Network tab, type a query, inspect the `/api/sessions/search?q=...` response:
- `results` array present?
- `snippet_html` contains `<mark>`?
- `degraded` field indicates backend issue?

**Step 2: Verify debounce**
Type rapidly; only one request should fire 250ms after last keystroke.

**Step 3: Test scroll-to-message**
Click a search result; ChatPanel should:
- Open the session
- Scroll to the matched message (look for `data-message-id` in DOM)
- Highlight with amber ring for 1.5s

If scroll fails:
- Check `ChatPanel.tsx` `scrollToMessageId` prop wiring
- Verify `data-message-id` attributes in rendered messages
- Check browser console for scroll errors

**Step 4: Test filters**
Toggle "Include archived" → archived sessions should appear/disappear.
Set project filter → only sessions matching `cwd` returned.

### Validating Search Quality

**Step 1: Known-good query test**
Pick a distinctive phrase from a known session (e.g., `"session history search"`), search for it, confirm that session ranks #1.

**Step 2: Snippet accuracy**
Result snippets should:
- Contain the query term wrapped in `<mark>`
- Preserve line breaks as `<br>` tags
- Not contain raw HTML or script tags

**Step 3: Filter correctness**
```bash
# Test archived filter
curl 'http://localhost:3001/api/sessions/search?q=test&archived=false' | jq '.results[].archived'
# All should be false

curl 'http://localhost:3001/api/sessions/search?q=test&archived=true' | jq '.results[].archived'
# All should be true

curl 'http://localhost:3001/api/sessions/search?q=test&archived=any' | jq '.results[].archived'
# Mix of true/false OK
```

**Step 4: Performance check**
With ~200 sessions indexed:
- Cold query: <300ms
- Warm query (same term): <100ms
- Check rate limit (5 rps): 6th request in 1s should fail with 429

### Extending to Semantic/Hybrid (M3)

**Pre-requisites:**
1. Read plan §6 completely (HTTP embedder architecture)
2. Decide on embedder upstream: Ollama (local GPU), narwhal-horn (SSH tunnel), or other OpenAI-compatible endpoint
3. Add config fields: `searchEmbeddings`, `searchEmbeddingsHttp`

**Implementation order:**
1. `backend/src/search/embedder.ts` — HTTP client with fallback chain, per-endpoint health, optional SSH tunnel manager
2. `backend/src/search/db.ts` — Add `chunk_vectors` table
3. Extend `indexer.ts` to populate vectors in a worker thread
4. Extend `search.ts` to run cosine search + RRF fusion
5. Wire `searchIncludeThinking` config flag
6. Add e2e test for semantic-only query (no keyword match)

**Validation:**
- Query with no keyword match (e.g., "sessions about debugging") should return results via semantic leg
- `/health` endpoint reports embedder status (`healthy`, `unhealthy-until-T`, `disabled`)
- With all upstreams down, search degrades to keyword-only with `degraded: "semantic_off"` in response

## Validation Checklist

- [ ] `search.db` exists at `<WAYANG_DATA_DIR>/search.db`
- [ ] `/api/sessions/search/health` reports ≥90% sessions indexed
- [ ] Unit tests pass: `cd backend && npm test`
- [ ] e2e tests pass: `cd e2e && npx playwright test session-search`
- [ ] Keyword query returns results with `<mark>` snippets
- [ ] Click result opens session and scrolls to matched message
- [ ] "Include archived" toggle hides/shows archived sessions
- [ ] Archived filter API param works: `archived=false|true|any`
- [ ] Project/date/model filters narrow results correctly
- [ ] Rate limit blocks 6th request in 1 second (429 status)
- [ ] Watcher reindexes new sessions within 30s
- [ ] Schema version mismatch triggers chunk rebuild
- [ ] Frontend builds cleanly: `cd frontend && npm run build`
- [ ] (M3 only) Semantic query with no keyword match returns results
- [ ] (M3 only) Embedder fallback chain degrades gracefully when upstream down

## Examples

### Example 1: Search for a known session
```bash
# API
curl 'http://localhost:3001/api/sessions/search?q=session+history' | jq '.results[0]'

# UI
1. Open Wayang
2. In SessionsPanel, type "session history"
3. Results appear with highlighted snippets
4. Click top result → ChatPanel opens and scrolls to matched message
```

### Example 2: Force reindex after chunker change
```bash
# After modifying chunker.ts or bumping SCHEMA_VERSION
cd ~/src/wayang/backend
npm test  # Verify chunker.test.ts passes

# Restart backend (watcher will auto-reindex on boot)
pm2 restart wayang-backend

# Or force immediate full reindex
curl -X POST http://localhost:3001/api/sessions/search/reindex
```

### Example 3: Debug missing session
```bash
# 1. Check if session has a pi_session_file
sqlite3 ~/.wayang/store.json.db "SELECT id, title, pi_session_file FROM sessions WHERE title LIKE '%my session%'"

# 2. Check if file exists
ls -lh ~/.pi/agent/sessions/.../<file>.jsonl

# 3. Check index state
sqlite3 ~/.wayang/search.db "SELECT * FROM session_index_state WHERE session_id='<uuid>'"

# 4. Check for indexing errors
sqlite3 ~/.wayang/search.db "SELECT error FROM session_index_state WHERE session_id='<uuid>'"

# 5. Force reindex
curl -X POST http://localhost:3001/api/sessions/search/reindex -H "Content-Type: application/json" -d '{"session_id":"<uuid>"}'
```

### Example 4: Add a new filter (e.g., "has_tool_use")
```typescript
// backend/src/search/types.ts
export interface SearchFilters {
  // ... existing
  has_tool_use?: boolean;  // NEW
}

// backend/src/search/search.ts
function buildWhereClause(filters: SearchFilters): { sql: string; params: any[] } {
  // ... existing
  if (filters.has_tool_use !== undefined) {
    conditions.push(`has_tool_use = ?`);
    params.push(filters.has_tool_use ? 1 : 0);
  }
  // ...
}

// backend/src/routes/search.ts
const filters: SearchFilters = {
  // ... existing
  has_tool_use: parseBool(req.query.has_tool_use),
};

// frontend/src/panels/SessionsPanel.tsx (filter strip)
<label>
  <input type="checkbox" checked={filters.has_tool_use} onChange={...} />
  Has tool use
</label>

// backend/src/search/chunker.ts
// Detect tool_call in JSONL and stamp chunks with has_tool_use=true

// backend/src/search/db.ts
// Add `has_tool_use INTEGER` column to chunks table, bump SCHEMA_VERSION
```

### Example 5: Validate scroll-to-message
```typescript
// e2e/tests/session-search.spec.ts
test("click result scrolls to message", async ({ page }) => {
  await page.goto("http://localhost:3000");
  await page.fill('[data-testid="session-search-input"]', 'keyword');
  await page.waitForSelector('.search-result');
  
  const firstResult = page.locator('.search-result').first();
  await firstResult.click();
  
  // ChatPanel should be visible
  await expect(page.locator('.chat-panel')).toBeVisible();
  
  // Message with data-message-id should be in viewport and highlighted
  const targetMessage = page.locator('[data-message-id]').first();
  await expect(targetMessage).toBeInViewport();
  await expect(targetMessage).toHaveClass(/highlight/);
});
```

## Common Pitfalls

1. **Route shadowing**: Mount `searchRouter` **before** `sessionsRouter` in `app.ts` or `/api/sessions/search` will match the `/:id` param route.

2. **Test isolation**: pi's session list reads from `PI_CODING_AGENT_DIR`, not `PI_CODING_AGENT_SESSION_DIR`. Set the correct env var in `playwright.config.ts`.

3. **Schema drift**: After changing chunk fields, bump `SCHEMA_VERSION` in `db.ts` and force reindex. Stale chunks with old schema cause query errors.

4. **NaN timestamps**: pi JSONL may lack top-level `timestamp`; `new Date(undefined).getTime()` → NaN. Use `Number.isFinite()` guards in `sessions.ts`.

5. **Snippet XSS**: Never use `dangerouslySetInnerHTML` with raw FTS5 snippet output. Use `SessionResultSnippet.tsx` strict allowlist sanitizer.

6. **Watcher not running**: If new sessions don't appear in search, check `app.ts` calls `startWatcher()` on boot and `stopWatcher()` on shutdown.

7. **Empty results after reindex**: Confirm chunks were written: `sqlite3 search.db "SELECT COUNT(*) FROM chunks"`. If zero, check indexer errors.

## Related Skills

- **wayang-session-debugging** — session lifecycle, reconnect, WebSocket issues
- **wayang-browser-testing** — Playwright e2e test patterns, fixture setup
- **memoriki** — durable knowledge recording (if exporting search patterns to MemPalace)

## References

- Planning doc: `~/src/wayang/docs/plans/session-history-search.md`
- Implementation journal: `~/src/wayang/docs/journals/2026-05-16-session-history-search-m1-m2.md`
- Operator guide: `~/src/wayang/docs/session-history-search.md`
- FTS5 docs: https://www.sqlite.org/fts5.html
- M3 architecture (semantic/hybrid): plan §6, deferred pending embedder upstream setup
