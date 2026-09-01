---
name: wayang-chat-performance-debugging
description: Diagnose and fix Wayang chat UI performance problems, especially long-session/mobile input lag caused by controlled composer state re-rendering the transcript, ReactMarkdown work, duplicate localStorage draft writes, forced scrollHeight layout, unstable message rows, websocket/history churn, and missing regression profiling.
---

# Wayang Chat Performance Debugging

## Setup

- Work in `~/src/wayang` unless the user specifies another checkout.
- Primary files often include:
  - `frontend/src/panels/ChatPanel.tsx`
  - `frontend/src/App.tsx`
  - `frontend/src/panels/SessionsPanel.tsx`
  - `frontend/src/api/client.ts`
  - e2e tests under `e2e/`
- Use `read` for source inspection, `bash` for `rg`, builds, and tests, and `edit` for targeted changes.
- Do not read browser profile/cookie files. If mobile behavior requires authenticated UI testing, use normal browser handoff rather than inspecting secrets.

## Diagnostic workflow

1. **Classify the performance symptom**
   - Is typing delayed only in long sessions?
   - Is the lag mobile-only or also desktop?
   - Does it happen while the agent is streaming, while idle, or after attachments/images?
   - Does switching sessions, search results, or browser tabs make it worse?

2. **Find what re-renders on each keystroke**
   - Locate the chat composer state, usually `inputText` in `ChatPanel.tsx`.
   - Trace the `<textarea value={inputText} onChange={...}>` path.
   - Check whether the same component also renders the full transcript, e.g. `displayMessages.map(...)`.
   - If the controlled textarea state lives in the transcript component, every character may reconcile all messages.

3. **Look for expensive transcript rendering**
   - Search for Markdown, syntax highlighting, image/base64 handling, timestamps, tool-call rendering, and collapsible sections.
   - Common hotspots:
     - `ReactMarkdown` invoked for every assistant text block.
     - message rows not memoized.
     - display-message normalization that rebuilds objects each render.
     - image attachments re-derived as data URIs on render.

4. **Check synchronous per-keystroke work**
   - Draft persistence:
     - A direct `localStorage.setItem` in `handleInput` is synchronous.
     - A second `[inputText]` effect that persists the same draft duplicates work.
   - Textarea resizing:
     - Repeated `style.height = "auto"` plus `scrollHeight` reads force layout.
     - If done both in `handleInput` and a `[inputText]` effect, layout is forced twice per key.
   - Slash autocomplete:
     - Filtering large command/model lists on every key can add cost.

5. **Inspect mobile-specific triggers**
   - In `App.tsx`, inspect `visualViewport` resize/scroll handlers.
   - Prefer CSS variable updates over React state for keyboard viewport changes.
   - Avoid full app state updates from mobile keyboard scroll/resize events.

## Fix workflow

1. **Extract the composer**
   - Move textarea/input state into a `ChatComposer` child so typing re-renders only the composer.
   - Keep send/queue callbacks stable with `useCallback`.
   - Pass only minimal props: connection status, running state, pending attachments, callbacks, and draft key/session id.

2. **Remove duplicate synchronous work**
   - Choose one draft persistence path.
   - Prefer debounced or idle-time localStorage writes.
   - On send/switch/unmount, flush the draft explicitly.

3. **Schedule textarea resizing**
   - Keep one resize path.
   - Use `requestAnimationFrame` where possible.
   - Avoid reading `scrollHeight` twice per keystroke.

4. **Memoize transcript rows**
   - Use `React.memo` for message row components and `AssistantMessage` where props are stable.
   - Memoize expensive parsed/rendered Markdown when message content and id do not change.
   - Ensure keys are stable message ids, not array indices unless unavoidable.

5. **Stabilize derived transcript data**
   - Avoid rebuilding all normalized messages on composer keystrokes.
   - Keep streaming-block updates separate from stable history rows.
   - Do not create new callback/object props for every row on every render unless memoized.

6. **Consider virtualization for very long sessions**
   - For thousands of messages/tool blocks, memoization may not be enough.
   - Evaluate transcript virtualization carefully because scroll-to-message, auto-scroll, active-turn pinning, and streaming anchors can break.

## Validation

Run normal builds/tests:

```bash
cd ~/src/wayang
npm --prefix frontend run build
npm --prefix backend run build
```

If browser/e2e coverage exists, add or run a regression that:

1. Creates or loads a long transcript with many assistant Markdown/tool blocks.
2. Focuses `data-testid="chat-input"`.
3. Types a representative message on desktop and, if possible, mobile viewport emulation.
4. Asserts the input receives characters promptly and the transcript remains stable.
5. Verifies sending, queued messages during running agents, attachments, slash autocomplete, and draft restore still work.

Manual profiling checklist:

- Use React DevTools Profiler or browser Performance panel.
- Record typing before and after the fix.
- Confirm only composer-related components re-render per keypress.
- Watch for long tasks caused by Markdown, syntax highlighting, localStorage, or layout.

## Common fixes from source sessions

- Long-session mobile input lag was traced to a controlled textarea in `ChatPanel` causing full transcript re-render on every keypress.
- `ReactMarkdown` inside message rendering amplified the cost.
- Duplicate draft persistence (`handleInput` plus an `[inputText]` effect) caused redundant synchronous `localStorage` writes.
- Duplicate textarea resizing caused repeated forced layout through `scrollHeight`.
- First low-risk fixes: extract/memoize composer, remove duplicate draft writes, and collapse resize logic; then memoize rows; virtualize only if still needed.

## Pitfalls

- Do not optimize by dropping draft restore, queued-message ordering, active interview/sudo/command-guard prompts, or attachment behavior.
- Do not let memoization hide streaming updates; live assistant blocks must still update.
- Do not break search-result scroll anchors or active-turn prompt pinning.
- Avoid measuring only desktop; mobile keyboards and visual viewport behavior can change the result.