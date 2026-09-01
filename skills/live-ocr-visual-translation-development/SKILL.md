---
name: live-ocr-visual-translation-development
description: "Develop and troubleshoot Linux live OCR visual-translation apps for video/game/chat overlays: interview requirements first, handle Wayland/X11 capture constraints, choose local OCR and translation providers, integrate Ruminant/OpenAI-compatible LLM backends safely, design side-panel/overlay UX, and validate privacy, latency, dedupe, and auth boundaries without exposing secrets."
---

# Live OCR Visual Translation Development

Use this skill when Clemente wants to build, evaluate, or debug an application that watches part of the screen or a video frame, OCRs visible foreign-language text, and translates it live or semi-live. The source sessions focused on a Linux/KDE/Wayland app for Korean game/Twitch chat, using local OCR and a LAN Ruminant/vLLM translation backend, with a side-panel UI first.

## Setup

### Project and planning defaults

- Prefer a planning-first start for new desktop apps. Create or update a project `PLAN.md` before implementation unless Clemente explicitly asks to code immediately.
- The initial project from the source session lives at:
  - `~/src/live-ocr-translator/`
  - `~/src/live-ocr-translator/PLAN.md`
- Use Clemente's communication preference:
  - Ask before assuming architecture, requirements, repo names, or UX.
  - Flag uncertainty explicitly.
  - If a clearly better approach exists, state it before implementing with 2–4 tradeoff bullets.

### Environment questions to answer first

Ask or verify:

1. Display stack: Wayland, X11, or both?
2. Desktop environment: KDE, GNOME, wlroots, etc.?
3. First UX: screenshot/file translation, side-panel live translation, or in-place overlay?
4. Source content: game UI, Twitch chat, subtitles, manga/comics, scanned docs?
5. Initial languages/scripts: Korean, Japanese, Chinese, etc.?
6. Privacy boundary:
   - images local-only?
   - OCR text may go to a LAN/cloud LLM?
   - everything local-only?
7. Translation provider:
   - Ruminant/OpenAI-compatible LAN endpoint,
   - direct local model gateway,
   - cloud fallback,
   - or pluggable provider interface?
8. Latency target: latest snapshot only, deduped appended lines, tunable capture rate, or quality-first batching?

### Tooling and likely dependencies

Choose based on the spike; do not assume all are required.

- Screen capture / portals:
  - Wayland: `xdg-desktop-portal`, PipeWire, desktop-specific portal behavior.
  - X11: region capture and transparent overlays are usually simpler, but less future-proof.
- OCR options:
  - Tesseract + language data (`tesseract`, `tesseract-data-kor`, etc.) for simple local OCR.
  - EasyOCR/PaddleOCR for better neural OCR at the cost of Python/model packaging complexity.
  - Vision LLM only if privacy/latency/cost are acceptable.
- Desktop app options:
  - Rust + GTK4/libadwaita or egui/slint for Linux-native work.
  - Tauri/Wails/webview if UI velocity matters, with native helpers for capture.
  - Keep capture/OCR/translation core separable from the UI.
- Translation backend:
  - Ruminant LAN gateway or other OpenAI-compatible endpoint.
  - Per-session translation prompt tuned for OCR noise, game/chat context, and preserving names.

## Workflow

### 1. Survey off-the-shelf options before building

For a user who only needs a workflow, recommend or test existing tools first:

- **Copyfish** browser extension: good for paused Twitch/browser video frames; not true continuous translation.
- **Crow Translate**: desktop selection/translation workflow; Wayland hotkeys and OCR may need manual setup.
- **NormCap + translator**: reliable select-region OCR, then paste/send to translator.
- **eSearch**: cross-platform screenshot/OCR/translate/screen tools; verify current Linux support.
- **Live_Screen_Translator_Linux** or similar projects: useful reference, but verify maintenance and Wayland support.

If the desired experience is continuous or semi-continuous live translation, proceed with a custom app/spike.

### 2. Plan the architecture before code

Document in `PLAN.md`:

```text
Capture source: selected screen region via Wayland portal/PipeWire or X11 capture
Frame scheduler: e.g. 2 Hz capture, coalesce unchanged crops
Preprocess: crop, scale, contrast, threshold, optional game-chat region masks
OCR backend: local Tesseract/EasyOCR/PaddleOCR adapter
Line tracker: normalize, dedupe, append new chat lines or replace latest snapshot
Translator: Ruminant/OpenAI-compatible adapter with translation prompt
UI: side panel first; overlay later after capture/permission spike
Privacy: images local-only; text routing configurable with warnings
Validation: screenshots -> OCR fixtures -> translation fixtures -> live capture smoke
```

Start with side panel rather than overlay when Wayland constraints are uncertain:

- Lower risk: normal application window avoids transparent click-through overlay issues.
- Easier debug: show crop preview, OCR text, translation, latency, and provider status.
- Better iteration: OCR quality and dedupe usually determine usefulness before overlay polish.

### 3. Build thin spikes in this order

1. **Static screenshot OCR fixture**
   - Save non-sensitive test images under a fixtures directory.
   - Run OCR locally.
   - Record OCR output and common errors.
2. **Translation adapter smoke**
   - Send a small public OCR-like text sample to the chosen backend.
   - Validate prompt behavior and latency.
   - Do not include private screen text in logs.
3. **Capture region spike**
   - Wayland: test portal/PipeWire permission flow and whether repeated captures are possible.
   - X11: test region capture separately if relevant.
4. **End-to-end loop**
   - Capture at a bounded rate, OCR, dedupe, translate, display in side panel.
   - Add cancellation/backpressure so slow translation does not queue unbounded work.
5. **Optional overlay**
   - Only after capture/OCR/translation quality is acceptable.
   - Prototype transparent, always-on-top, click-through, and multi-monitor behavior per desktop.

### 4. OCR and game-chat heuristics

For game/Twitch chat, plain frame-by-frame OCR often repeats or garbles text. Add:

- Crop stabilization: keep the selected region fixed; allow quick reselection.
- Image preprocessing toggles: upscale, grayscale, threshold, invert, denoise.
- Language-specific OCR config: start with Korean language data for Korean sessions.
- Text normalization: strip timestamps, normalize whitespace, remove common OCR artifacts.
- Dedupe strategy:
  - `latest_snapshot_only` for menus/signs/subtitles,
  - `dedupe_lines_append` for scrolling chat,
  - bounded history window to avoid repeated translations.
- Debug pane with crop preview + OCR raw text + translated text.

### 5. Translation prompt pattern

Use a provider adapter. For Ruminant/OpenAI-compatible backends, keep the app-side API generic and put prompt text in a config file.

Example system prompt:

```text
You translate noisy OCR text from a Korean video game or Twitch stream into natural English.
The OCR may contain repeated lines, missing spacing, or confused characters.
Preserve usernames, item names, game terms, and numbers when uncertain.
If text is too garbled to translate, say what parts are uncertain briefly.
Return only the English translation, with short notes in brackets only when needed.
```

For chat mode, pass only new or changed lines when possible. For subtitle/sign mode, replace the latest translation instead of appending.

### 6. Ruminant / LAN LLM integration safely

When the translation backend is Ruminant:

- Treat Ruminant as the auth boundary between the desktop app and upstream vLLM.
- Use a Ruminant client key in app config or environment, but **do not print or read secret values into the transcript**.
- Expected boundary from source work:
  - `/health` may remain public for LAN health checks.
  - Other endpoints require `RUMINANT_API_KEY`.
  - Accept either `Authorization: Bearer <ruminant key>` or `X-Ruminant-API-Key` if implemented.
  - When Ruminant auth is enabled, do **not** forward client `Authorization` upstream.
  - Ruminant should use its own `RUMINANT_VLLM_API_KEY` for upstream vLLM auth.
- Validate with public text only:
  - unauthenticated protected endpoint returns `401`,
  - authenticated request reaches the model,
  - upstream credential is not echoed/logged,
  - `uv run pytest -q` passes in the Ruminant repo after changes.

If systemd installation or firewall changes are needed, use the sudo workflow and request explicit authorization; do not work around command guard.

### 7. Privacy and logging rules

- Do not log screenshots or OCR text by default.
- Provide an explicit debug mode for saving crops/OCR output, with warnings.
- Avoid sending images to cloud models unless Clemente explicitly approves.
- If authenticated/private video, chat, or personal screen content appears, keep output summaries high-level and do not include raw text unless needed and authorized.
- Keep API keys in env/config files, not in `PLAN.md`, `README.md`, test fixtures, or transcripts.

## Validation checklist

Before calling an MVP usable, verify:

- `PLAN.md` captures current assumptions, privacy boundary, target desktop, and deferred work.
- Static OCR fixture produces acceptable text for the target language/script.
- Translation provider smoke test succeeds with public sample text.
- Wayland/X11 capture spike works on Clemente's actual desktop and documents permission prompts.
- Loop has bounded concurrency/backpressure; slow LLM calls do not pile up indefinitely.
- UI exposes crop preview, raw OCR, translated output, provider status, and latency/error messages.
- Ruminant or other provider auth works without leaking keys.
- Tests or scripts cover OCR adapter, dedupe, and translation adapter using non-secret fixtures.

## Common pitfalls

- Assuming Wayland behaves like X11 for global screenshots or transparent overlays.
- Building overlay UI before proving capture/OCR/translation quality.
- Sending full screenshots to an LLM when local OCR would satisfy the privacy boundary.
- Translating the same scrolling chat lines repeatedly because there is no line-level dedupe.
- Letting translation requests queue faster than the backend can process them.
- Confusing Ruminant client auth with upstream vLLM auth or forwarding client bearer tokens upstream.
- Recording raw private OCR text in app logs, transcripts, or test fixtures.

## References from source sessions

- Project path: `~/src/live-ocr-translator/`
- Plan path: `~/src/live-ocr-translator/PLAN.md`
- Ruminant app path: `~/src/server-lattice/apps/ruminant/`
- Ruminant validation used in source session: `uv run pytest -q`
- Existing-tool survey keywords/products: Copyfish, Crow Translate, NormCap, eSearch, Live_Screen_Translator_Linux.
