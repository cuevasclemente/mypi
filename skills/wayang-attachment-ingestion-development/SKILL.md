---
name: wayang-attachment-ingestion-development
description: Implement and debug Wayang chat attachment ingestion for images, PDFs, .eml, and general binary files across frontend upload UX, websocket/backend storage, prompt file references, size limits, validation, journaling, and service restart handoff.
---

# Wayang Attachment Ingestion Development

## Setup
- Use this when changing or debugging Wayang chat attachments, file uploads, multimodal image handling, PDF/.eml support, or arbitrary binary file references.
- Typical project root: `~/src/wayang`.
- Relevant areas may include:
  - `frontend/src/panels/ChatPanel.tsx` or current chat input/upload components.
  - `backend/src/routes/ws.ts` or current websocket/message ingestion routes.
  - Backend tests for websocket/session message handling.
  - Documentation/journal such as `docs/JOURNAL.md`.
- Do not read uploaded file contents unless the user asks for analysis of that specific attachment. Never inspect unrelated secrets.

## Design Principles
- Images and non-image files need different treatment:
  - Images can be previewed/compressed client-side and forwarded as multimodal image blocks when supported.
  - Non-image files should be saved to a tool-accessible location and referenced in the prompt so the agent can use tools to inspect them if needed.
- Preserve existing image behavior when adding PDFs or binary files.
- Make limits explicit and enforce them consistently in frontend and backend.
- Treat uploaded files as local session artifacts, not secrets to print into prompts.

## Workflow

### 1. Inspect current attachment path
Map the current flow before editing:
1. Frontend file picker `accept` attributes and drag/drop handling.
2. Image preview/compression code.
3. Attachment serialization into websocket/chat payloads.
4. Backend websocket payload parsing.
5. Storage location for uploaded files.
6. Prompt construction for agent-visible references.
7. Existing tests and build scripts.

Use `rg`/`read` rather than broad manual guessing. Common search terms:
```bash
rg "attachment|attachments|image|mime|accept|FileReader|websocket|uploads" frontend backend
```

### 2. Frontend implementation checklist
When expanding beyond images:
- Allow general file selection; include PDFs and `.eml` explicitly when using `accept`.
- Keep image preview/compression behavior intact.
- Render non-image attachments as file chips/cards with filename, MIME type if available, and size.
- Provide clear validation errors for rejected files.
- Enforce limits such as:
  - Maximum attachment count.
  - Maximum image size.
  - Maximum non-image size.
  - Maximum total payload size.
- Avoid loading very large binary files into UI state unnecessarily beyond what is needed for upload.

Source-session example limits:
- 40 attachments.
- 5 MB per image.
- 25 MB per non-image file.
- 50 MB total.

Treat these as historical values to verify against current product requirements before reusing.

### 3. Backend/websocket implementation checklist
For each incoming attachment:
1. Validate declared metadata and size.
2. Store bytes under a tool-accessible temporary/session path, historically `/tmp/wayang-attachments`.
3. Sanitize filenames enough to prevent path traversal; preserve user-recognizable names for prompts.
4. For images, preserve current multimodal forwarding behavior where supported.
5. For PDFs, `.eml`, and arbitrary binaries, inject a prompt reference rather than raw contents:

```xml
<file name="/tmp/wayang-attachments/example.eml">[Uploaded file example.eml; message/rfc822; 274.7 KB. Saved at this path for tool access.]</file>
```

6. Ensure the prompt reference includes the saved path and enough metadata for the agent to decide whether to use `read` or other tools.
7. Avoid embedding binary contents directly into model context.

### 4. Testing and validation
Run the project's relevant checks. Source-session validation used:
```bash
cd frontend && npm run build
cd backend && npm run build
cd backend && npm test
```

Also manually/smoke-test when possible:
- Attach an image: preview appears; existing multimodal behavior still works.
- Attach a PDF: displayed as a file chip; backend saves it; prompt contains a `<file ...>` reference.
- Attach an `.eml`: same as PDF; agent can read the saved path with tools.
- Attach a generic binary: saved and referenced without corrupting websocket/session payloads.
- Rejection cases: too many files, file too large, total too large.
- Session replay/history: attachment references remain understandable after reload.

### 5. Restart/handoff
After builds pass, restart or ask the user to restart the Wayang service so the rebuilt frontend/backend is served. If a managed app/process exists, use the project's normal process manager rather than killing unrelated processes.

Mention in the final handoff:
- Files changed.
- Supported attachment types/limits.
- Validation commands run.
- Whether restart was performed or still required.

### 6. Journal significant changes
If the attachment path or persisted prompt format changes, journal the work in the project journal (for example `docs/JOURNAL.md`) with:
- Date/time.
- Summary of frontend/backend changes.
- Validation results.
- Any known caveats or follow-up items.

## Common Pitfalls
- Accidentally breaking image compression/preview while adding binary files.
- Passing raw PDF/.eml/binary contents into model context instead of a file reference.
- Trusting client MIME type without backend validation.
- Path traversal via uploaded filenames.
- Enforcing size limits only in the frontend.
- Forgetting that a rebuild/restart may be required before the browser sees the change.
- Making prompt references too vague for the agent to locate the saved file.

## Source-session Pattern
A successful implementation expanded Wayang attachments by:
- Updating `frontend/src/panels/ChatPanel.tsx` so the paperclip accepted general files, image behavior stayed unchanged, and non-images appeared as file chips.
- Updating `backend/src/routes/ws.ts` so uploads were stored under `/tmp/wayang-attachments`.
- Forwarding images as multimodal image blocks while injecting PDFs, `.eml`, and binary files into the prompt as `<file name="...">` references for tool access.
- Validating with frontend build, backend build, and backend tests.
- Journaling in `docs/JOURNAL.md` and noting that Wayang needed a restart/reload.
