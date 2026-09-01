---
name: report-publisher-mcp-development
description: >-
  Develop, migrate, and debug Clemente's report-publisher MCP flow: publishing reports/artifacts to OpenCloud, Matrix notifications, MCP resources, optional text-to-speech, and secret-safe configuration.
---

# Report Publisher MCP Development

Use this skill when designing, implementing, migrating, or debugging Clemente's report-publisher MCP flow: publishing generated reports/artifacts to OpenCloud, sending Matrix notifications, exposing resources through MCP tools, and adding optional text-to-speech or index metadata.

## Boundaries and safety

- Do **not** read or print secrets, OAuth tokens, app passwords, `.env` values, Matrix access tokens, OpenCloud credentials, or private keys.
- It is OK to inspect code, docs, manifests, examples, filenames, schemas, service status, and redacted configuration keys.
- Treat published report URLs as potentially sensitive. Prefer private/link-gated destinations unless the user explicitly asks for public publishing.
- If a migration touches existing report stores, preserve old data first and make rollback explicit.

## Typical workflow

1. **Clarify publishing target and audience**
   - What will be published: markdown, HTML, PDF, audio, logs, images, or bundles?
   - Destination: OpenCloud/WebDAV/share, local archive, Matrix attachment, MCP resource, or several of these.
   - Access model: private, authenticated share, temporary link, or public link.
   - Notification channel and expected summary format.

2. **Inventory existing implementation**
   - Locate MCP server entrypoints, tool definitions, resource handlers, report storage paths, and docs.
   - Identify environment variable names and config file paths without reading values.
   - Check current tests, scripts, package manager, and deployment service definitions.

3. **Design the publish pipeline**
   - Normalize report metadata: title, generated timestamp, source job/session, artifact type, MIME type, retention, share URL, and notification status.
   - Keep upload, share-link creation, Matrix notification, and MCP indexing as separable steps so partial failures can be retried.
   - Make idempotency explicit: stable report IDs, overwrite policy, duplicate notification prevention, and migration markers.

4. **Implement secret-safe configuration**
   - Reference secrets by env var names or secret file paths only.
   - Add or update `.env.example`/docs with variable names and descriptions, never values.
   - Validate missing credentials with actionable errors that do not echo attempted values.

5. **OpenCloud/WebDAV publishing checks**
   - Probe destination existence and permissions without listing more than necessary.
   - Upload to a temporary/staging name first when feasible, then finalize atomically.
   - Record canonical path, content hash/size, MIME type, and share URL if generated.
   - For direct PosixFS/OpenCloud writes, normalize or refresh OpenCloud-specific extended attributes after temp-file rewrites, metadata rewrites, or artifact finalization; stale/missing xattrs can appear as endless spinners in the UI.
   - When a report folder spins, inspect package metadata state first: look for half-published bundles, `audio_rendering`/pending TTS markers, missing artifacts, and mismatch between filesystem files and OpenCloud metadata before changing permissions broadly.

6. **TTS/audio artifact publishing**
   - Treat long TTS generation as durable asynchronous work, not as a synchronous MCP request that must stay alive until audio completes.
   - Submit broker-backed TTS jobs with stable idempotency keys, persist job IDs/status in report metadata, and return an `audio_rendering`/pending status when generation continues after the publish request.
   - Provide an explicit recovery/finalizer tool (for example `finalize_pending_tts_reports`) that scans pending packages, checks broker manifests, copies completed final audio into the package as `narration.mp3`, updates metadata, and refreshes OpenCloud xattrs.
   - Keep finalization idempotent: safe to rerun, skips already-complete packages, and reports completed/skipped/failed counts with paths but no secrets.

7. **Matrix notification checks**
   - Send concise notifications: report title, timestamp, short summary, and link(s).
   - Avoid dumping full report text into Matrix unless requested.
   - Handle notification failure separately from upload success and expose retry state.

7. **MCP surface**
   - Tools should return structured JSON with IDs, URLs, paths, and status fields.
   - Resource handlers should serve report metadata and content with predictable URIs.
   - Document tool arguments and failure modes.

8. **Migration pattern**
   - Snapshot existing indexes/metadata first.
   - Write a dry-run that reports actions without mutating remote state.
   - Migrate in small batches; verify counts, representative records, and links.
   - Leave compatibility aliases or redirects when old resource IDs may still be referenced.

9. **Validation**
   - Run unit/type/build tests for the MCP package.
   - Smoke-test one publish path end-to-end with a non-sensitive sample report.
   - Verify that logs redact credentials and that failed auth does not reveal secrets.
   - Confirm MCP clients can list/fetch the new report resource.

## Common pitfalls

- Treating upload success as notification success; track them separately.
- Blocking MCP publish calls on slow TTS rendering; prefer async jobs plus finalizers for long audio.
- Leaving packages in `audio_rendering` or half-published states without an operator recovery command.
- Rewriting OpenCloud PosixFS metadata/artifacts without refreshing the xattrs OpenCloud uses to recognize resources.
- Emitting signed/share URLs into broad logs or journals.
- Reading `.env` or credential files during debugging.
- Migrating report metadata without preserving old IDs or timestamps.
- Returning free-form strings from MCP tools where structured status is needed for automation.
