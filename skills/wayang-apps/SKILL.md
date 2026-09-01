---
name: wayang-apps
description: Build, register, and operate project-local interactive apps inside wayang's Apps pane using app manifests, managed processes, iframe bridge state, and agent-facing app tools.
---

# wayang Apps

## Setup
- Work in a project that can host a small web app and a `.pi/apps/<app-id>/app.json` manifest.
- Use wayang app tools when available: `register_app`, `list_apps`, `start_app`, `stop_app`, and `update_app_state`.
- Keep app code project-local; do not install global services unless the user requests it.

## Workflow
1. **Clarify the interaction**
   - Ask what the app should visualize or control, what state the agent should be able to update, and whether the user needs persistence.
   - Decide if this should be a static iframe app, a dev-server process, or a bridge-driven visualization.

2. **Create a project-local app**
   - Add app files under a stable directory such as `.pi/apps/<app-id>/` or `apps/<app-id>/`.
   - Include a minimal `app.json` manifest with id, name, description, start command (if needed), URL, and bridge expectations.
   - Avoid hard-coding secrets; pass configuration by env vars or user-provided config paths.

3. **Register and run**
   - Call `register_app` with the manifest path so the app appears in wayang's Apps pane.
   - Use `start_app` only for apps with managed processes.
   - Use `list_apps` to confirm registration.

4. **Bridge agent state to the iframe**
   - Use `update_app_state(appId, state)` to send JSON-serializable planning or visualization data.
   - Design the app to handle repeated state messages and reloads idempotently.
   - Include enough schema/version fields in state for future agent sessions.

5. **Validate UX**
   - Confirm app appears in the right Apps pane.
   - Confirm process lifecycle: start, stop, refresh, and reload.
   - Test that returning to a session preserves or rehydrates app state when expected.

## Example
```json
{
  "id": "bike-route-planner",
  "name": "Bike Route Planner",
  "description": "Map-based planning surface for agent-assisted bike routes",
  "url": "http://localhost:5179",
  "startCommand": "npm run dev -- --host 127.0.0.1 --port 5179"
}
```

Then:
```text
register_app(manifestPath: ".pi/apps/bike-route-planner/app.json")
start_app(appId: "bike-route-planner")
update_app_state(appId: "bike-route-planner", state: { routeDraft, waypoints })
```

## Patterns from source sessions
- Visual apps can take over the assistant pane or live in the right pane; choose based on how much interaction is needed.
- Keep manifest registration separate from app code generation so wayang can discover apps reliably.
- For map/route tools, use agent state as the source of truth and let the iframe render it.
- When debugging, inspect both the manifest and the managed process logs before changing UI code.

## Production iframe/proxy checklist
- Prefer wayang managed ports: have the app bind exactly to `PI_APP_PORT`, `127.0.0.1`, and `strictPort: true`; do not hard-code ports in the app manifest.
- For remote/mobile browsers, raw `127.0.0.1:<port>` iframe URLs point at the client device. Use wayang's same-origin proxy path for iframe `src` and assets.
- When proxying Vite apps, preserve the proxy prefix. The backend should forward the full original/proxy URL to Vite so Vite can serve history-fallback and static assets without redirect loops.
- Set `PI_APP_BASE_PATH` for managed app processes when serving through a proxy. In Vite, use `base: process.env.PI_APP_BASE_PATH || './'` so local production builds remain proxy-safe.
- If using `vite preview` against a prebuilt `dist/`, make sure the build was produced with proxy-safe/relative asset paths. Root paths like `/assets/...` or `/style.css` can work locally but break inside `/api/apps/<id>/proxy/<session>/`.
- For faster and less fragile restarts, build explicitly during development/deploy, then use a lightweight preview/static serve command for managed app startup. Avoid `npm run build && npm run preview` in the app's steady-state start command unless rebuild-on-launch is intentional.

## Secrets and bridge state
- Never read token/secret files directly. Ask the user to provide secrets or route them through environment variables, secure app state, or a user-managed path.
- Do not hard-code tokens in app files or print them in responses/logs.
- If wayang exposes bridge state in a textarea/debug panel, redact token-like keys (`token`, `secret`, `password`, `credential`, `apiKey`) by default and preserve the original value when saving an unchanged `<redacted>` field.
- App bridge state must be JSON-serializable. Treat it as an object, not a pre-stringified JSON blob.

## Mapbox / map apps
- Use the Mapbox GL CSP build when iframe/CSP/worker restrictions matter: import `mapbox-gl/dist/mapbox-gl-csp.js` and serve `mapbox-gl-csp-worker.js` from the app's own public assets.
- Keep the worker URL relative to the app/proxy base; verify it loads through the same-origin app proxy.
- If Mapbox `load` does not fire, inspect whether JS/CSS assets loaded before debugging token/style issues. Unstyled HTML usually means the app shell loaded but CSS/JS asset paths are wrong.
- Mapbox Directions is good for road-following cycling routes; use unsnapped/sketch rendering for gravel/fire-road routes where Directions may snap to unsuitable roads.

## Mobile UX checklist
- App header/action bars should be horizontally scrollable on narrow screens with `shrink-0` controls so critical actions like Focus/Fullscreen remain reachable.
- Bridge/debug controls should wrap or scroll on mobile; avoid forcing explanatory text into narrow columns.
- Provide a Focus/Fullscreen mode that hides bridge state and event logs so the iframe can use most of the viewport.
- In iframe apps, constrain large overlay panels with `max-height` and `overflow: auto; -webkit-overflow-scrolling: touch`; avoid fixed panels that cover the entire map on mobile.
- Keep legends and secondary overlays smaller or move them away from primary controls on small screens.