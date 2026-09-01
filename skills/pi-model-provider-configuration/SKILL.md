---
name: pi-model-provider-configuration
description: Configure pi and wayang model availability, defaults, provider-backed model dropdowns, host-specific models, and context-window/token usage indicators.
---

# pi Model Provider Configuration

## Setup
- Work in the relevant pi or wayang checkout.
- Know which providers/hosts are expected: local pi models, OpenRouter/OpenAI/Anthropic, or host-specific endpoints such as `narwhal-horn`.
- Do not read API keys or secret files. Reference secret paths or environment variable names only.
- Treat `settings.json` and `models.json` as a coordinated non-secret configuration pair: preserving one while leaving the other stale can retain old defaults or provider routing.

## Workflow
1. **Inventory current model definitions**
   - Search for provider/model registries, default model constants, and UI dropdown sources.
   - Compare CLI pi config with wayang config so both expose the same useful models.
   - Identify display labels, provider ids, context windows, and whether a model supports streaming/tools.

2. **Verify provider authorization and billing policy**
   - Do not infer that a consumer subscription's OAuth login includes third-party harness usage. Check installed pi provider docs first, then verify the provider's current official policy.
   - Distinguish authentication support from included-plan billing, API/extra-usage billing, and officially supported first-party tools.
   - Keep credential setup user-driven or opaque; validate by model listing/behavior without displaying tokens.

3. **Add or expose models**
   - Add host-specific models to the provider registry, not just the dropdown UI.
   - Include stable ids, human-friendly names, provider routing info, and context limits.
   - Keep defaults in one place where possible.

4. **Set default model intentionally**
   - Change the default in the shared config layer if possible.
   - Confirm new-session creation and existing-session continuation both respect the default.
   - Avoid overwriting an explicitly selected model for an active session.

5. **Keep cheap-model routing and runtime copies aligned**
   - When a new model family affects command guard or monitor routing, update the provider-aware cheap fallback deliberately; do not assume an old sibling model still exists.
   - For security-sensitive extensions, synchronize the source copy, active `~/.pi/agent/extensions/` copy, and Wayang bridge/UI behavior in the same session.
   - Existing sessions may require `/reload`, reconnect, or a new session before they inherit registry/default/guard changes.

6. **Build the model selector UX**
   - Place the selector near connection/status controls when requested.
   - Persist the selected model per session or per project only if that matches user expectations.
   - Disable unavailable models with clear labels rather than hiding them silently.

7. **Expose context usage**
   - Track exact tokens used when usage data is available from model responses.
   - Render percentage based on the selected model's context window.
   - Fall back gracefully when token usage or context limit is unknown.

## Validation
- Create a new session and confirm the default model.
- Switch models, send a message, and verify the backend receives the selected provider/model id.
- Confirm host-specific models appear only when configured/reachable.
- Check the context meter against known usage metadata.
- Refresh and query Wayang's live `/api/models` (or equivalent provider-backed endpoint); a static CLI/config listing alone does not prove the running service loaded the model.
- Validate extension bundling plus backend/frontend builds when provider changes affect command guard, model selectors, or status bridges.

## Common pitfalls
- Adding a dropdown option without backend routing causes confusing send failures.
- Model ids and provider ids must match the backend contract exactly.
- Context indicators need per-model windows; a single global limit is misleading.
- Do not expose or log API key values while debugging provider config.
- A successful OAuth login does not by itself prove that consumer-subscription allowance covers third-party use; verify current billing policy.
- Preserving stale `settings.json` or `models.json` independently can leave old defaults and routing in place.

## Patterns from source sessions
- User asked for GPT 5.5 as the default and narwhal-horn models in wayang.
- Model selection belonged near the websocket connected sensor.
- Context used/available was useful as both an exact token count and a visual percentage.