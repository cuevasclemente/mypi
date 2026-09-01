---
name: wayang-session-debugging
description: >-
  Debug wayang session lifecycle problems: disappearing sessions, slow reconnects, stale polling, recency sorting, missing streamed responses, and session/process association.
---

# wayang Session Debugging

## Setup
- Work in `~/src/wayang` unless the user specifies another checkout.
- Use `read` for source files, `bash` for `rg`, tests, and process inspection, and `edit` for targeted changes.
- Avoid deleting session history. If cleanup is required, use recoverable deletion and ask first.

## Diagnostic workflow
1. **Establish a trustworthy latency baseline**
   - Measure distinct stages instead of one aggregate: session-list request, backend catalog/scan, row selection, websocket attach, transcript fetch/parse, React commit, and first usable transcript paint.
   - Record corpus size, cold/warm cache state, mobile/desktop viewport, tab visibility, and whether the target session is running or stopped.
   - Validate the test target before trusting results. Vite/noVNC proxy drift or a broken dev URL can make browser baselines meaningless.

2. **Reproduce and classify the symptom**
   - Disappearing sessions: inspect session discovery and project/session cache invalidation.
   - Slow click/reconnect: inspect websocket connection flow and redundant polling.
   - Stale session list: inspect recency timestamps, sort keys, and refresh intervals.
   - Missing streamed response after navigation: inspect persistence of assistant messages and stream replay.

3. **Find the data source of truth**
   - Locate APIs that read `~/.pi/agent/sessions` and transform session metadata.
   - Confirm whether sessions are associated with running pi processes or only persisted log files.
   - Check for derived fields such as `lastInteractionAt`, `updatedAt`, current working directory, project id, process id, and websocket state.

4. **Remove transcript scanning from list request paths**
   - Profile whether `GET /api/sessions` or `SessionManager.listAll()` reparses the full JSONL corpus, including in a background sync still awaited by the request.
   - Prefer a server-owned incremental catalog keyed by file fingerprint/mtime/size, with worker parsing for changed sessions only.
   - For stopped sessions, load one fingerprinted transcript snapshot and derive metadata from that same parse instead of rescanning for multiple fields.
   - Return cached catalog data immediately when safe; refresh asynchronously without replacing stable session identities.

5. **Stabilize session ordering and identity**
   - Sort by most recent user/assistant/tool interaction, not just session creation time.
   - Keep stable session ids across refreshes.
   - Avoid replacing selected-session objects during polling unless the id truly changed.

6. **Reduce reconnect and refresh churn**
   - Debounce or coalesce periodic refreshes.
   - Do not drop active websocket state when metadata refreshes.
   - Preserve the selected session and scroll position across list updates.

7. **Optimize selection-to-paint without hiding latency**
   - Treat session selection as a transaction from click through usable transcript paint, not merely websocket-ready or metadata-loaded.
   - Avoid post-commit selection switching, mobile Chat remounts, and transcript-wide rerenders when only connection or composer state changes.
   - Use stable message-row ids and progressive transcript rendering when long histories dominate commit/paint time.
   - Make polling visibility-aware and preserve Chat/session state across mobile panel changes.

8. **Persist streamed content**
   - Ensure assistant stream chunks are appended to durable session state.
   - On navigation back, rehydrate from the saved transcript plus any active stream state.
   - Test partial, completed, and errored assistant responses.

## Validation commands
- Run the project typecheck/test suite (for example `npm test`, `npm run typecheck`, or the package-specific command).
- Use `rg "lastInteraction|session|websocket|stream"` to find related code paths.
- Manually exercise: create session, send message, navigate away/back, refresh list, reconnect, and verify transcript remains.
- Capture cold and warm timings from session-row click to usable transcript paint; verify list refresh latency does not scale linearly with the entire unchanged corpus.
- Confirm hidden tabs/mobile panel switches do not keep high-frequency polling or remount active Chat state.

## Common fixes
- Add a `lastInteractionAt` helper that scans transcript events and falls back to file mtime/session timestamp.
- Make session-list refresh idempotent and preserve selected ids.
- Separate running-process status from persisted-session visibility.
- Add tests for recency sorting and response persistence.
- Add an incremental session catalog so unchanged transcripts are not reparsed per list request.
- Add click-to-paint selection metrics and stable progressive transcript rows for long sessions.

## Patterns from source sessions
- User-facing slowness often came from list refreshes resetting connection state.
- Session pane bugs recur; first inspect state ownership before changing UI rendering.
- Several fixes were small targeted edits after tracing the session API and frontend cache path.