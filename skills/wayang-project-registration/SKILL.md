---
name: wayang-project-registration
description: Add an existing local folder as a Wayang project/session, troubleshoot project discovery, and explain when to use the Wayang API versus filesystem discovery signals.
---

# Wayang Project Registration

Use this skill when Clemente asks to add a folder as a project in Wayang, make a directory appear in the New Session/project picker, or troubleshoot why a folder is not showing up as a Wayang project.

## Mental model

Wayang does not have a separate durable `projects` table. The UI treats projects as groupings of sessions by `cwd`.

A folder can appear in Wayang in two ways:

1. **Existing session path** — any session row with `cwd=/path/to/folder` appears under “Your Sessions” and becomes a project grouping.
2. **Discovered project card** — `GET /api/fs/discover-projects` scans selected filesystem locations and returns folders with signals such as `.pi/`, `.git`, `package.json`, or existing pi session history.

For a one-off folder under `~/Documents`, `~/Downloads`, or another skipped/common directory, the reliable path is to create a lightweight Wayang session row via the sessions API. Creating `.pi/` may not be enough if the parent directory is not scanned or is explicitly skipped.

## Preflight

1. Confirm the intended folder path and normalize obvious variants:
   - `~/...` → `/home/clemente/...`
   - Watch for case and spacing: `Documents/japanese_practice` is not the same as `document/japanese practice`.
2. Verify the directory exists without reading private contents unnecessarily:
   ```bash
   ls -ld /path/to/project
   ```
3. Check Wayang local health:
   ```bash
   curl -sS -m 5 http://127.0.0.1:8787/healthz
   ```
4. Do not read secrets or broad personal files while registering the project.

## Add a folder as a Wayang project

Create a lightweight session row for the folder. The live pi `AgentSession` starts lazily only when the user opens/sends messages in the session.

```bash
curl -sS -m 10 \
  -X POST http://127.0.0.1:8787/api/sessions \
  -H 'Content-Type: application/json' \
  --data '{"cwd":"/absolute/path/to/project","title":"Human Readable Title"}'
```

Expected result: JSON with an `id`, `title`, `cwd`, and `runtime_status`. `pi_session_file` may be `null` until the session is actually used; this is normal.

After this, Wayang should show the folder in the Sessions/Projects list as a project grouping named from the last path segment, and the created session title should be visible.

## Avoid duplicate project/session rows

Before creating a new row, prefer checking whether a session already exists for the same `cwd` if doing so is safe in the current environment. If command-guard privacy rules block listing all sessions, do not fight the guard; either rely on current user intent, use the UI to inspect, or ask Clemente whether a duplicate session is acceptable.

Potential safe checks:

```bash
curl -sS http://127.0.0.1:8787/api/sessions
```

Then filter locally for the exact `cwd`. Be aware that a full session list contains workspace metadata.

## Make a folder auto-discoverable

Wayang discovery currently scans:

- `~/src`
- the home directory `~`

It skips many common home folders such as `Documents`, `Downloads`, `Desktop`, media folders, and hidden/config directories. Within scanned locations, a directory is included only if it has at least one signal:

- `.pi/`
- `.git/`
- `package.json`
- existing pi session history for that exact `cwd`

For folders inside skipped parents like `~/Documents`, use the sessions API instead of relying on discovery.

## Optional project-local agent guidance

If the folder needs special behavior, add an `AGENTS.md` at the project root. This is independent of Wayang registration, but Wayang sessions launched in that cwd should load relevant project guidance through pi.

Example:

```text
/path/to/project/AGENTS.md
```

## Validation checklist

- `curl http://127.0.0.1:8787/healthz` returns `{"status":"ok"}`.
- Session creation returns HTTP 201 and a JSON session row.
- The returned `cwd` exactly matches the intended absolute folder.
- The folder appears in Wayang under existing sessions/projects.
- If an `AGENTS.md` was added, start/open a session in that project and confirm the agent follows it.

## Troubleshooting

- **Folder not in Discovered Projects:** It may be under a skipped parent like `Documents`, or it lacks `.pi`, `.git`, `package.json`, and pi session signals.
- **Project appears only after creating a session:** This is expected; Wayang projects are session groupings.
- **Public Wayang fails but local health works:** suspect Authentik/Caddy/WebSocket path rather than registration.
- **`pi_session_file` is null:** normal for a newly-created lightweight row before the session is used.
- **Path typo:** create a new session with the correct cwd; archive the bad session via the UI/API if needed.
