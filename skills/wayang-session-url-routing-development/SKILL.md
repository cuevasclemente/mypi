---
name: wayang-session-url-routing-development
description: >-
  Develop and debug Wayang canonical `/sessions/:sessionId` routing: direct deep-link restoration, History API navigation, race-safe resolution, SPA/auth preservation, archive/delete URL cleanup, accessible desktop/mobile recovery, encoded-ID handling, and focused/full Playwright validation. Use for session URL ownership and navigation; use `wayang-session-debugging` for generic lifecycle, reconnect, polling, persistence, or performance problems.
---

# Wayang Session URL Routing Development

## Scope

Use this skill when sessions need stable, copyable browser URLs or those routes behave incorrectly. The canonical contract is:

```text
/sessions/:sessionId
```

The session ID—not title, project path, or model—is the durable identity. This workflow owns URL parsing, direct restore, session-to-history behavior, recovery UX, deep-link serving, and route tests.

This is not generic session debugging. For disappearing sessions, stale lists, WebSocket reconnects, transcript persistence, or latency, use `wayang-session-debugging`. For general browser fixtures and timing techniques, also load `wayang-browser-testing`.

## Setup and safety

- Work in the Wayang checkout, normally `/home/clemente/src/wayang`.
- Read repository instructions, `README.md`, `SECURITY.md`, and existing session URL plans/journals.
- Run `git status --short` first. Record unrelated dirty paths; do not edit, format, stage, restore, or overwrite them.
- Inspect current integration points before editing:
  - `frontend/src/App.tsx` — active session and pane ownership.
  - `frontend/src/auth/AuthGate.tsx` — requested URL retention through login.
  - `frontend/src/panels/SessionsPanel.tsx` — rows, search, archive, delete.
  - `frontend/src/panels/ScheduledJobsPanel.tsx` — linked run sessions.
  - `frontend/src/api/client.ts` — encoded session-detail requests.
  - `backend/src/app.ts` — production SPA fallback and JSON API 404.
  - `e2e/playwright.config.ts` and existing session/auth tests.
- Use isolated synthetic E2E data, never real transcripts, credentials, cookies, or normal Wayang/pi data directories.
- Prefer a small History API adapter while this remains one focused route. Do not add a router dependency merely for this feature.

## Planning questions

Confirm these before coding; recommended defaults are shown:

1. Canonical shape: `/sessions/:sessionId`?
2. Should direct navigation and refresh restore the session? **Yes.**
3. Should user session switches use `pushState`, making Back/Forward traverse selections? **Yes.**
4. Should a missing session show an inline notice and usable session list? **Yes.**
5. Should active archive/delete cleanup replace the dead URL with `/`? **Yes.**
6. Which unknown paths belong to this route, and should query/hash survive canonicalization?
7. Must this work under Vite, production Express, shared-password auth, and a reverse proxy?
8. Are title slugs, project/job routes, message anchors, and public sharing explicitly deferred?

## Architecture

### Route helper

Keep path logic in a pure module such as `frontend/src/routing/sessionRoute.ts`:

- Build paths with `encodeURIComponent(sessionId)`.
- Parse exactly one non-empty segment after `/sessions/`.
- Optionally accept one trailing slash, then canonicalize with `replaceState`.
- Reject extra segments.
- Wrap `decodeURIComponent` in `try/catch`; malformed escapes return a controlled invalid-route result.
- Compare canonical paths before writing history to avoid duplicates.
- Preserve or intentionally discard `location.search` and `location.hash` per the agreed policy.

A discriminated union such as `root | session | invalid` works well. `ChatPanel` should not parse URLs.

### App-owned route state

`App` coordinates routing because it already owns active session, project context, overlays, search anchors, and mobile tabs. Keep route state distinct from `activeSession`:

```text
idle -> loading -> ready
               -> not_found  (HTTP 404)
               -> error      (network/5xx)
```

On initial load and `popstate`:

1. Parse `window.location.pathname`.
2. Root clears route-owned selection without writing history.
3. A session route shows loading and calls the existing encoded detail API.
4. Success selects session/project state, closes conflicting overlays, opens Chat on mobile, and canonicalizes only if needed.
5. A 404 keeps the requested URL and shows not-found recovery.
6. Other failures keep the URL and show Retry; never call an outage “not found.”

### Race protection

Deep-link requests race with row clicks, Back/Forward, search, and scheduled-run enrichment. Use a monotonically increasing generation or an abort controller:

- Increment for every route resolution.
- Invalidate in-flight restoration on explicit user selection.
- Apply a response only if it is still current.
- Keep existing selected-ID guards on placeholder enrichment.

Otherwise a slow response for A can overwrite a later navigation to B.

### Centralized navigation

Provide one user-driven `navigateToSession(session, options?)` callback that:

- Selects known or placeholder metadata immediately.
- Updates project context and closes incompatible overlays.
- Clears stale scroll state unless search supplied a message anchor.
- opens Chat on mobile.
- Calls `pushState` only when the canonical path differs.

Use it for session rows, search results, both session-creation flows, scheduled-run links, and future focus-session actions.

History ownership is strict:

- User selection: `pushState`.
- Startup and `popstate`: resolve only, never push.
- Trailing-slash canonicalization: `replaceState`.
- Active archive/delete cleanup: `replaceState('/')`.

### SPA and auth preservation

- Valid production session paths must return `frontend/dist/index.html`.
- `/api/*` must remain protected JSON routes and never fall through to HTML.
- Vite development/preview must serve valid session deep links.
- `AuthGate` must retain pathname, query, and hash until successful login mounts the app.
- URLs contain only the existing opaque ID—not title, cwd, transcript text, credentials, or provider data.

## Implementation workflow

1. **Baseline and protect scope**
   - Run the current doctor/check command.
   - Inventory dirty paths and re-read current callbacks; do not assume an older layout.

2. **Add route helpers**
   - Implement encoding, one-segment parsing, optional trailing slash, safe decode failure, and canonical comparison.

3. **Add App route resolution**
   - Resolve initial location after auth allows the app to mount.
   - Install exactly one `popstate` listener and clean it up.
   - Separate 404 from transient failure and guard stale async responses.

4. **Centralize all session-opening paths**
   - Replace local selection writes where an action means “open this session.”
   - Preserve search anchors and scheduled placeholder enrichment.
   - Reselecting the active row must not add history.

5. **Clean URLs after removal**
   - When active archive/delete closes chat, clear session/scroll route state and replace the URL with `/`.
   - Keep archive and permanent-delete backend semantics distinct; routing only coordinates visible state.

6. **Add accessible recovery UX**
   - Loading: “Loading session…” with `role="status"`.
   - Not found: “Session not found,” safely abbreviated ID, and deleted/unavailable guidance.
   - Transient error: “Unable to load session” and Retry.
   - Browse action: show/expand Sessions on desktop; expose the notice and list on mobile.
   - Use `aria-live`, keyboard-operable buttons, and stable `data-testid`s.
   - Keep the session list mounted and usable.

7. **Test narrowly, then broadly**
   - Use intercepted APIs and synthetic sessions for routing behavior.
   - Add stable row/search/run selectors rather than brittle classes.
   - Compare the final diff to the original dirty-path inventory.

## Testing

### Focused E2E cases

Cover at least:

1. Selecting A then B writes encoded canonical URLs.
2. Reselecting A creates no duplicate entry.
3. Back restores A, Back to `/` clears selection, Forward restores A/B.
4. Direct navigation and refresh restore the same session.
5. A trailing slash canonicalizes without adding history.
6. Search and scheduled-run opening use centralized navigation.
7. A 404 shows accessible recovery and keeps its URL.
8. A 500/network failure shows Retry, not not-found.
9. A late A response cannot overwrite B.
10. Active archive/delete replaces the URL with `/`.
11. Shared-password login preserves the deep link and agreed query/hash.
12. Desktop and mobile expose usable loading/error/not-found recovery.
13. IDs with spaces/reserved characters round-trip through frontend and API encoding.

Use repository-supported commands, for example:

```sh
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix e2e test -- session-urls.spec.ts auth.spec.ts
make test
make test-e2e
WAYANG_E2E_PRODUCTION=1 npm --prefix e2e test -- session-urls.spec.ts
```

Record exact commands, fresh versus existing servers, warnings versus failures, and pass counts. Prefer the package `test` script: malformed `npm --prefix e2e exec playwright ...` argument placement can bypass the intended Playwright config.

### Direct-server probes

Browser-side History API tests do not prove a direct request reaches the SPA. Probe production separately:

```sh
curl -i http://127.0.0.1:<port>/sessions/<synthetic-id>
curl -i http://127.0.0.1:<port>/api/definitely-unknown
curl --path-as-is -i 'http://127.0.0.1:<port>/sessions/malformed%E0%A4%A'
```

Expect the valid route to return the SPA shell and the unknown API to return JSON 404.

## Malformed-encoding backend edge case

Safe `decodeURIComponent` handles malformed paths only **after the SPA loads**. Express/static routing or Vite may reject malformed escapes with HTTP 400 before React runs.

Treat this as a separate server boundary:

1. Reproduce with `curl --path-as-is` against development and production.
2. Keep a History API parser test proving the loaded SPA cannot crash.
3. If direct malformed-path recovery is required, add only narrowly scoped server handling for intended `/sessions/...` GET/HEAD paths.
4. Prove it does not capture `/api/*`, assets, WebSockets, or unrelated malformed paths and does not weaken auth/origin gates.
5. Add server integration or production smoke coverage before calling it fixed.

If backend edits are excluded or unrelated backend files are dirty, report this as a blocker instead of editing opportunistically.

## Failure modes

- **Slow A overwrites B:** no generation/abort guard.
- **Back loops:** `popstate` resolution pushes history.
- **Extra Back presses:** active-row reselect or canonicalization pushes duplicates.
- **Pane and URL disagree:** one entry point bypasses centralized navigation.
- **Search loses anchor:** navigation always clears the message target.
- **Outage appears deleted:** all API errors are treated as 404.
- **Dead URL remains:** archive/delete clears selection but not route state.
- **Mobile hides recovery:** the notice replaces Sessions without a way back.
- **Direct link fails despite E2E success:** tests used only `pushState`; SPA fallback was not probed.
- **Malformed direct URL is still 400:** frontend decoding never got to run.
- **Encoded ID mismatch:** raw IDs are interpolated without `encodeURIComponent`.
- **Auth loses route:** login redirects to `/` or captures the requested URL too late.
- **Unrelated work changes:** broad formatting/restoration touched pre-existing dirty files.

## Rollback

This feature needs no data migration. To roll back:

1. Remove the route helper, App route state, and `popstate` listener.
2. Restore selection callbacks to local active-session updates.
3. Remove route-specific notices, selectors, tests, and auth extension.
4. Revert only feature-owned hunks; preserve unrelated worktree changes.
5. Re-run frontend build and existing session/auth E2E tests.

Never alter IDs, metadata, transcripts, API storage, or auth records. Revert a server malformed-path handler independently and revalidate normal SPA fallback plus JSON API 404 behavior.

## Concrete examples

### History behavior

```text
Start: /
Click A -> pushState('/sessions/A')
Click A -> no history write
Click B -> pushState('/sessions/B')
Back -> resolve A without pushState
Back -> resolve root without pushState
Forward -> resolve A without pushState
```

### Race-safe restore

```text
1. GET /sessions/A begins at generation 7.
2. User selects B; generation becomes 8 and URL becomes /sessions/B.
3. A resolves late.
4. Ignore A because 7 != 8.
```

### Encoded ID

```ts
const path = `/sessions/${encodeURIComponent(sessionId)}`;
try {
  const id = decodeURIComponent(encodedSegment);
} catch {
  // Controlled invalid/not-found state once the SPA is loaded.
}
```

### Active deletion

```text
Current URL: /sessions/A
Delete A succeeds -> clear selection -> replaceState('/')
No extra dead-session cleanup entry is added to Back history.
```
