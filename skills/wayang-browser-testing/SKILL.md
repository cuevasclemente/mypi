---
name: wayang-browser-testing
description: Build and run Playwright browser regression tests for Wayang chat/session behavior, including temporal message ordering, WebSocket readiness, isolated test sessions, UI test IDs, streaming markers, and local timing profiles.
---

# Wayang Browser Testing

Use this skill when Wayang/pi-web-ui needs browser-level regression coverage for chat ordering, streaming, WebSocket readiness, session lifecycle, or mobile/UI behavior. Prefer this when DOM timing or real browser behavior matters more than unit tests.

## Setup

- Wayang/pi-web-ui repo with backend, frontend, and an `e2e` Playwright workspace.
- Node dependencies installed for backend/frontend/e2e.
- Real provider configuration available through the normal pi config, but test data isolated from the user’s real session list.
- Do not persist test sessions into the normal UI.

Recommended isolation:

```bash
export PI_WEB_UI_DATA_DIR=/tmp/wayang-e2e-data
export PI_CODING_AGENT_SESSION_DIR=/tmp/wayang-e2e-sessions
# Do not override PI_CODING_AGENT_DIR unless intentionally testing config discovery.
```

## Workflow

1. **Plan the behavior to catch**
   - Write down the invariant in user-visible terms, e.g. “a second user message sent during assistant streaming must never render above the assistant output it follows.”
   - Decide whether the test should use a real backend/pi `AgentSession` or a mocked route. For ordering and WebSocket issues, prefer real local processes.

2. **Add stable selectors**
   - Add `data-testid` attributes for chat messages, streaming blocks, queued placeholders, composer, send button, session picker, and status indicators.
   - Avoid brittle CSS class or text-only selectors when the UI is actively changing.

3. **Start isolated local services**
   - Use separate backend/frontend test ports so tests do not collide with the running Wayang service.
   - Keep provider/auth config real by preserving the normal pi config directory, while isolating session/data directories.

4. **Create browser helpers**
   - `sessions.ts`: create/select test sessions and clean them up.
   - `chatOrder.ts`: inspect rendered message order and expose assertions.
   - `wsProfile.ts`: measure WebSocket open, `session_ready`, history receipt, and close/error events.

5. **Catch transient ordering bugs**
   - Use a `MutationObserver` in the page to record every DOM order transition, not only the final settled state.
   - For streaming tests, send a long first message, wait for assistant streaming, then send marker B while marker A is still streaming.
   - Assert marker B never appears before the assistant response/placeholder for marker A.

6. **Add readiness/timing tests**
   - Measure time from page load/session selection to WebSocket open and `session_ready`.
   - Use local thresholds that are strict enough to catch regressions but tolerant of model/network variance.

## Example test shape

```ts
test('mid-stream user message keeps temporal order', async ({ page }) => {
  await createIsolatedSession(page)
  await sendMessage(page, 'Browser ordering test marker A. Write a long numbered response.')
  await waitForAssistantStreaming(page)

  const monitor = await installOrderMonitor(page)
  await sendMessage(page, 'Second message during streaming marker B')

  await expectNoOrderViolation(monitor, {
    before: 'Browser ordering test marker A',
    after: 'Second message during streaming marker B',
  })
})
```

## Validation

Run the narrow E2E suite before broadening:

```bash
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix e2e test -- message-temporal-consistency.spec.ts
npm --prefix e2e test -- websocket-connection-timing.spec.ts
```

Record validation in a journal with the exact command and whether tests used fresh dev servers or the currently running service.

## Pitfalls

- Final DOM order can look correct after refresh while transient live ordering was wrong; keep the `MutationObserver` history.
- Test sessions can pollute the real UI unless both Wayang data and pi session directories are isolated.
- WebSocket readiness can be slowed by background transcript sync; profile startup phases separately.
- Long streaming marker tests are useful but may be flaky if they depend on external model latency. Keep assertions about UI order, not answer content quality.

## Source-session techniques

- The 2026-05-13 browser testing plan and implementation added isolated directories, configurable ports, chat-order helpers, WebSocket profiling, and Playwright tests for mid-stream message ordering and session readiness.
