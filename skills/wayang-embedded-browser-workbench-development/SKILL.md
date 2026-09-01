---
name: wayang-embedded-browser-workbench-development
description: Implement, debug, and deploy Wayang's embedded Browser workbench and companion pi browser-control tools, including backend-managed Chromium, CDP screencast/input transport, Browser right-panel UI, project-persistent profiles, secret-safe human handoff for login/MFA/CAPTCHA/payment, smoke tests, and restart handoff.
---

# Wayang Embedded Browser Workbench Development

Use this skill when building or debugging Wayang's shared embedded browser: a browser visible to the user in Wayang's right pane and controllable by the pi agent through explicit browser tools. The intended model is **human-mediated browser use**: the agent can navigate and inspect pages, while Clemente handles secrets and irreversible actions directly in the Browser tab.

## Setup

- Wayang repo: `~/src/wayang`
- mypi extension source repo: `~/src/mypi`
- Active pi runtime extension directory: `~/.pi/agent/extensions/`
- Backend package: `~/src/wayang/backend`
- Frontend package: `~/src/wayang/frontend`
- Preferred browser binary order:
  1. `WAYANG_CHROMIUM_PATH` or Chrome/Chromium environment override
  2. Playwright cached Chromium
  3. System Chromium
- Project browser state/artifacts should be ignored by git:
  - `.pi/browser-workbench/`
  - `.pi/browser-artifacts/`
  - `.pi/secret-browser/`

Do not read browser profile files, cookies, local storage databases, credential files, or secret broker outputs. Browser profiles are bearer-sensitive once logged in.

## Architecture Pattern

### Backend

Implement a backend-managed Chromium service with explicit API routes and a WebSocket viewer transport.

Typical files:

```text
backend/src/browser/types.ts
backend/src/browser/cdp.ts
backend/src/browser/manager.ts
backend/src/browser/ws.ts
backend/src/routes/browser.ts
backend/src/app.ts
```

Core responsibilities:

1. Resolve a browser binary using the priority order above.
2. Launch Chromium with a project-scoped persistent profile under ignored `.pi/browser-workbench/`.
3. Connect via Chrome DevTools Protocol (CDP).
4. Provide routes for status/start/stop/navigate/snapshot/user-handoff state.
5. Serve an interactive viewer over `/ws/browser` using CDP screencast frames and CDP input dispatch.
6. Ensure `/ws/chat` and `/ws/browser` coexist; use explicit WebSocket upgrade routing (for example `noServer`) rather than assuming a single WebSocket path.

Prefer CDP screencast frames for the v1 embedded viewer, not VNC. It is simpler to host inside the existing backend and allows direct CDP input events.

### Frontend

Add a Browser right-panel tab integrated with Wayang's existing panel layout.

Typical files:

```text
frontend/src/panels/BrowserPanel.tsx
frontend/src/components/browser/BrowserToolbar.tsx
frontend/src/components/browser/BrowserViewer.tsx
frontend/src/api/client.ts
frontend/src/panels/RightPanel.tsx
```

Frontend responsibilities:

1. Show browser status and URL.
2. Provide controls for start/stop, navigate, refresh, and handoff/resume state.
3. Render CDP screencast frames from `/ws/browser`.
4. Convert pointer/keyboard events into viewer messages for backend CDP dispatch.
5. Make sensitive/manual steps obvious: login, MFA, CAPTCHA, payment, booking, account changes, deletion, or anything irreversible should be user-handled.

### pi Browser-Control Extension

Keep source and runtime copies aligned:

```text
~/src/mypi/plugins/browser-control.ts
~/.pi/agent/extensions/browser-control.ts
```

Expose tools such as:

- `browser_status`
- `browser_open`
- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type_public`
- `browser_wait_for_user`
- `browser_resume_status`
- `browser_close`

Tool behavior should target the Wayang backend using `WAYANG_URL`, `PI_WEB_UI_URL`, or a safe local default such as `http://127.0.0.1:8787`.

## Workflow

### 1. Plan the Browser Workbench Contract

Before editing code, decide:

- Is this v1 Chromium-only?
- Where profiles/artifacts live and how they are ignored.
- Which routes and WebSocket messages are needed.
- Which operations are agent-safe versus user-handoff only.
- Whether authenticated page content may be snapshotted into the active model context.
- What must be deferred, such as Bitwarden/credential brokers, DOM target selection, or semantic page indexing.

For complex changes, write a plan under `docs/plans/` and journal the implementation under `docs/journals/`.

### 2. Implement Backend Browser Manager

A minimal manager should support:

- `status(projectCwd)`
- `start(projectCwd, url?)`
- `stop(projectCwd)`
- `navigate(projectCwd, url)`
- `snapshot(projectCwd, mode)`
- handoff/resume state
- viewer attach/detach

Important details:

- Treat `projectCwd` as part of the profile key.
- Avoid reading profile/cookie files; interact through the running browser only.
- Add robust cleanup for Chromium processes on backend shutdown.
- Surface useful errors for missing browser binaries and GLIBC/runtime incompatibilities.
- If system Chromium fails, try Playwright cached Chromium before giving up.

### 3. Implement Browser Routes and WebSocket

Common HTTP routes:

```text
GET  /api/browser/status
POST /api/browser/start
POST /api/browser/stop
POST /api/browser/navigate
POST /api/browser/snapshot
POST /api/browser/wait-for-user
POST /api/browser/resume
```

Common WebSocket path:

```text
/ws/browser?project_cwd=/path/to/project
```

Viewer messages usually include:

- backend → frontend: `status`, `frame`, `error`
- frontend → backend: `mouse`, `key`, `resize`, `navigate`, `stop`

### 4. Implement Frontend Browser Tab

Add a right-panel tab named **Browser**. Keep the UX practical:

- URL entry and navigate button.
- Status line showing running/stopped/waiting-for-user.
- Viewer canvas/image area for screencast frames.
- Clear instructions when the agent is waiting for Clemente to finish sensitive steps.
- Error display for browser launch failures.

### 5. Implement pi Tools Safely

Tool safety rules:

- `browser_type_public` is only for non-secret public text.
- Never type passwords, TOTP/MFA codes, passkeys, CAPTCHA answers, payment details, SSNs, or private secrets through an agent tool.
- Use `browser_wait_for_user` for login, MFA, CAPTCHA, passkeys, payment, booking, account changes, deletion, and uncertain sensitive steps.
- Do not finalize purchases/bookings without explicit user confirmation.
- Before `browser_snapshot`, consider whether page contents are appropriate for the active model/provider.

### 6. Validate

Run builds:

```bash
cd ~/src/wayang/backend && npm run build
cd ~/src/wayang/frontend && npm run build
```

Validate extension syntax without executing secrets:

```bash
cd ~/src/mypi
node - <<'NODE'
const ts = require('typescript');
const fs = require('fs');
const file = 'plugins/browser-control.ts';
const source = fs.readFileSync(file, 'utf8');
const result = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
});
if (result.diagnostics?.length) {
  console.error(result.diagnostics);
  process.exit(1);
}
console.log('browser-control.ts transpiles');
NODE
```

Run a backend smoke test on a temporary port when possible:

1. Start backend on `127.0.0.1:<temp-port>`.
2. `POST /api/browser/start` for the project.
3. `POST /api/browser/navigate` to `https://example.com`.
4. `POST /api/browser/snapshot` and confirm title/text.
5. Connect to `/ws/browser` and confirm at least one `frame` message.
6. Stop the browser and backend.

### 7. Deploy / Handoff

After source changes:

- Install the runtime extension copy to `~/.pi/agent/extensions/browser-control.ts`.
- Rebuild backend/frontend assets.
- Restart/reload Wayang so the running service picks up new code.
- Restart/reload pi sessions so the extension tool list includes browser tools.
- Journal the change in Wayang docs and, if extension behavior changed, in `~/src/mypi/docs/journals/`.

## Troubleshooting

- **No screencast frames:** check CDP connection, page target attachment, and `/ws/browser` upgrade routing.
- **Chat WebSocket broke:** ensure `/ws/chat` and `/ws/browser` are routed by pathname and do not share a single unqualified WebSocket server.
- **Chromium launch fails with GLIBC/runtime errors:** prefer Playwright cached Chromium or set `WAYANG_CHROMIUM_PATH` to a compatible binary.
- **Agent can type into secrets:** tighten tool descriptions and route implementation so only `browser_type_public` exists for typed text, and sensitive steps require `browser_wait_for_user`.
- **Profiles leak into git:** add ignored `.pi/browser-workbench/`, `.pi/browser-artifacts/`, and `.pi/secret-browser/` paths.
- **Authenticated page appears in transcript unintentionally:** avoid `browser_snapshot`; ask Clemente whether to proceed and consider switching to local-only/secret-tainted workflows.

## References

- Plan pattern: `~/src/wayang/docs/plans/embedded-browser-workbench.md`
- Implementation journal: `~/src/wayang/docs/journals/2026-06-01-embedded-browser-workbench-implementation.md`
- mypi extension journal: `~/src/mypi/docs/journals/2026-06-01-browser-control-extension.md`
- Source extension: `~/src/mypi/plugins/browser-control.ts`
- Runtime extension: `~/.pi/agent/extensions/browser-control.ts`
