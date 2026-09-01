---
name: pi-command-guard-operations
description: Configure, install, troubleshoot, and align pi command-authorization guard behavior across pi CLI and Wayang, including provider-aware cheap model routing, unparseable verdict debugging, session/scheduled-job toggles, web bridge status, and extension source syncing.
---

# Pi Command Guard Operations

Use this skill when changing or debugging the command-authorization guard extension for pi or Wayang/pi-web-ui. The guard should reduce risk around dangerous commands without blocking normal software development loops.

## Setup

- Source extension repo, commonly `~/src/mypi/plugins/command-authorization-monitor.ts`.
- Installed runtime copy, commonly `~/.pi/agent/extensions/command-authorization-monitor.ts`.
- Wayang/pi-web-ui repo when aligning browser guard state or scheduled jobs.
- Pi extension docs if the hook/bridge contract is unclear.
- Never read API key files. Use environment variable names or config paths only.

## Workflow

1. **Identify the active guard path**
   - Check whether behavior comes from the installed extension, project-local extension, or source repo.
   - Keep source and installed copies synchronized when changing durable behavior.

2. **Route guard model cheaply and by provider**
   - Prefer a cheaper/flash sibling for guard verdicts while the main session uses a larger model.
   - Preserve `PI_COMMAND_GUARD_MODEL=provider/model` as an override.
   - Examples from source sessions:
     - OpenRouter DeepSeek Pro → DeepSeek V4 Flash.
     - GPT 5.5 sessions → a mini/spark equivalent when available.
     - Claude large models → Haiku.
     - Gemini large models → Flash.

3. **Tune the policy boundary**
   - Allow routine SDLC follow-through by default: inspect, build, test, lint, typecheck, format, local dev servers, and ordinary deploy-style scripts when requested.
   - Continue to scrutinize irreversible deletion, secret exposure, privilege escalation, destructive overwrites, credential/auth changes, public package publishing, unrelated service disruption, and `curl | sh`-style patterns.

4. **Validate extension syntax before install**
   - Bundle or typecheck the extension with the same tooling used by pi/mypi, often `esbuild`.
   - Install only after syntax validation.
   - Keep a timestamped backup of the previous installed extension when making risky changes.

5. **Align Wayang live-session state**
   - When a session starts, ensure extension lifecycle hooks are bound (`bindExtensions` or equivalent) so the guard registers its web bridge.
   - After `/model` changes or model-picker changes, refresh `command_guard_state` so the UI shows the current routed guard model.
   - Clear stale frontend errors when a positive guard-status message arrives.

6. **Expose controls safely**
   - Session top bar: allow toggling guard mode between `balanced` and `off` for the current live session.
   - Scheduled jobs: store a per-job guard setting and apply it when the job session starts.
   - Do not make one session’s guard toggle silently affect unrelated sessions unless that is explicit global configuration.

7. **Debug unparseable verdicts**
   - Inspect the raw guard model response shape and parser expectations.
   - Confirm the requested guard model exists for the active provider and is not silently falling back to an incompatible model.
   - Add logging around model selection, prompt, response, and parse failure without logging secrets.
   - If needed, temporarily choose a known-good guard model through `PI_COMMAND_GUARD_MODEL`.

## Validation

```bash
# Extension syntax/bundle check, example
npx esbuild plugins/command-authorization-monitor.ts --bundle --platform=node --outfile=/tmp/command-guard.js

# Wayang/pi-web-ui validation, examples
npm --prefix backend run build
npm --prefix frontend run build
curl -s http://127.0.0.1:8787/healthz
```

Manual smoke tests:

- Hover the guard widget and confirm it shows active status plus routed guard model.
- Toggle guard on/off in one session and confirm another session is unaffected.
- Change the main model and confirm guard state refreshes.
- Run a routine build/test command and confirm it is allowed in balanced mode.
- Try a clearly dangerous command only as a dry-run/prompt test; do not execute destructive actions.

## Pitfalls

- Updating only `~/src/mypi` does not affect current pi sessions until the installed extension is updated/reloaded.
- Updating only `~/.pi/agent/extensions` creates drift from the source repo.
- Existing live sessions may need `/reload`, a new session, or service restart to load extension changes.
- Scheduled jobs may use different model/guard settings than interactive sessions.
- Guard UI can say “unavailable” if lifecycle hooks never ran, even though local input checks appear active.

## Source-session techniques

- 2026-05-13 sessions implemented provider-aware guard routing, fixed web guard state after model changes, added session and scheduled-job toggles, bound extension hooks in Wayang sessions, relaxed routine SDLC policy, and debugged unparseable guard verdicts during web UI recovery.
