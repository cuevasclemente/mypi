---
name: wayang-session-deletion-development
description: Implement and debug Wayang session archive/delete behavior, especially privacy-sensitive permanent transcript deletion with command-guard PIN gating, live-session stop, search-index purge, metadata cleanup, frontend confirmation, and backend/frontend validation without exposing secrets.
---

# Wayang Session Deletion Development

## Setup
- Work in the Wayang repo, usually `/home/clemente/src/wayang`.
- Relevant areas from the source session:
  - Backend routes: `backend/src/routes/sessions.ts`
  - Session store/model tests: `backend/src/sessions.test.ts`
  - Frontend API client: `frontend/src/api/client.ts`
  - Sessions panel UI: `frontend/src/panels/SessionsPanel.tsx`
  - Journals: `docs/journals/`
- Never read, print, change, unset, or export the command guard identity PIN. The delete flow may request a PIN from the user/UI, but agents must treat it as opaque.
- Respect deletion safety in agent shell work. Do not manually delete session files with shell commands unless the user explicitly asks and confirms. This skill describes implementing the app's intentional delete feature.

## Core behavior
Wayang should support two distinct actions:

1. **Archive**
   - Existing archive-only endpoint remains available.
   - Does not require the command guard PIN.
   - Hides the session from the normal active list but does not claim to destroy transcript content.

2. **Delete**
   - Requires command guard identity PIN validation before mutation.
   - Stops any live `AgentSession` for the Wayang session first.
   - Removes the session from search/index state before reporting success.
   - Permanently deletes/unlinks the pi transcript file from the active session store.
   - Removes the Wayang metadata row.
   - Returns an explicit response such as `{ deleted: true, deleted_session_file: ... }`.

This distinction matters for sensitive local-model work: moving a transcript to a holding area is not enough if the user expects deletion to prevent later hosted-model context/search exposure.

## Workflow
1. **Inspect current archive/session architecture**
   - Search for existing archive APIs, session model functions, search index removal helpers, and frontend archive controls.
   - Identify whether sessions are file-linked to canonical pi JSONL transcripts and how background sync imports them.

2. **Add or verify backend delete route**
   - Define a delete endpoint separate from archive, e.g. `POST /api/sessions/:id/delete`.
   - Validate command guard identity PIN without exposing its value.
   - Stop any live session for that id before changing storage.
   - Purge search index state before success; if purge fails, surface failure rather than returning a false success.
   - Delete/unlink the transcript file and remove metadata so sync does not rediscover it.
   - Return clear JSON using `deleted_session_file`, not stale `moved_session_file` terminology.

3. **Update session model/tests**
   - Add or update a unit test proving deletion removes the metadata row, deletes the transcript, and future sync skips stale discoveries.
   - Keep archive tests separate; archive must remain non-PIN and non-destructive.
   - Include cases for missing sessions and file-linked sessions.

4. **Update frontend UX**
   - Add a trash/delete action near archive in the session row.
   - Use a confirmation dialog that clearly says deletion permanently deletes the pi transcript and removes the session from Wayang/search.
   - Request the command guard PIN via password-style input; never log it.
   - Keep archive copy distinct from delete copy.
   - Update API client response types to match backend JSON.

5. **Journal and handoff**
   - Add a project journal under `docs/journals/` documenting privacy semantics, touched files, and validation.
   - Mention that the Wayang service may need a restart/rebuild deployment for backend/frontend changes to take effect.

## Validation
Run the same validation pattern used in the source session:

```bash
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix backend test
```

Expected test coverage includes the session deletion case, search/index cleanup, and existing unrelated backend tests. Frontend build may emit normal chunk-size warnings; distinguish warnings from failures.

## Common pitfalls
- **Moving instead of deleting:** moving transcripts to `deleted-sessions/` or another holding area does not satisfy privacy-sensitive deletion semantics.
- **Async index purge after success:** if search removal is fire-and-forget, the UI can claim deletion while search still exposes snippets. Prefer purging before returning success.
- **Rediscovery by sync:** deleting only a metadata row while leaving a transcript in the canonical session store lets background import recreate the row.
- **PIN leakage:** never print PIN values in logs, tests, exceptions, or chat.
- **Archive/delete conflation:** archive should remain reversible/non-destructive; delete should be clearly destructive and PIN-gated.

## Example final report
- Backend delete route now validates the command guard PIN, stops live sessions, purges search, deletes transcript, and removes metadata.
- Frontend has a trash action with permanent-delete copy and PIN dialog.
- Validation: backend build, frontend build, backend tests passed.
- Restart Wayang to pick up built changes.
