---
name: wayang-chatterbox-tts-development
description: Implement, validate, debug, and deploy Wayang ↔ Chatterbox TTS/read-aloud support for assistant messages, covering live Chatterbox API probing, backend config/routes/cache/range audio serving, frontend assistant-bubble audio UX, message ID and text extraction pitfalls, build/deploy/systemd environment, and no-secret handling.
---

# Wayang Chatterbox TTS Development

Use this skill when implementing or debugging Wayang read-aloud/TTS features backed by Chatterbox, especially assistant-message audio generation and playback.

## Setup

1. Work in the Wayang repo, typically `~/src/wayang`.
2. Review the existing plan before changing behavior:
   - `docs/plans/chatterbox-tts-feature.md`
3. Treat Chatterbox and deployment settings as environment/configuration, not secrets in code:
   - `WAYANG_TTS_BASE_URL`
   - `WAYANG_TTS_VOICE`
   - other `WAYANG_TTS_*` settings defined by `backend/src/config.ts`
4. Never read, print, copy, or commit secret files or command-guard PIN files. If a credential is required, ask the user to set it as an environment variable or systemd override.
5. If sudo/systemd changes are needed, expect command guard or sudo prompts to block automation. Ask the user to approve or run the privileged command.

## Workflow

### 1. Validate the live Chatterbox API first

Before debugging Wayang code, confirm the Chatterbox server shape and required voice names:

```bash
curl -i "$WAYANG_TTS_BASE_URL/"
curl -i "$WAYANG_TTS_BASE_URL/docs"
curl -s "$WAYANG_TTS_BASE_URL/openapi.json" | head
curl -i "$WAYANG_TTS_BASE_URL/v1/audio/voices"
curl -sS -X POST "$WAYANG_TTS_BASE_URL/v1/audio/speech" \
  -H 'Content-Type: application/json' \
  -d '{"input":"Wayang TTS test.","voice":"Ava.mp3"}' \
  -o /tmp/wayang-tts-test.mp3
file /tmp/wayang-tts-test.mp3
```

Notes:
- Voice names may need the full filename, for example `Ava.mp3`, not just `Ava`.
- Prefer probing `/openapi.json` over guessing request/response formats.
- If `file` does not report audio, inspect HTTP status/body without assuming the saved file is valid.

### 2. Backend implementation checkpoints

Relevant files from the source implementation:

- `backend/src/config.ts`
  - Defines `WAYANG_TTS_*` config.
  - Ensure defaults are safe and local; do not hard-code secrets.
- `backend/src/routes/tts.ts`
  - Exposes TTS generation and cached audio serving routes.
  - Calls Chatterbox `/v1/audio/speech`.
  - Maintains ephemeral cache under `~/.wayang/tts`.
  - Serves generated audio with HTTP Range support.

Backend behavior to preserve:

1. Accept a stable assistant message ID and text payload.
2. Extract only assistant-visible text:
   - exclude thinking/reasoning blocks;
   - exclude tool calls/tool output;
   - avoid reading hidden metadata or debug content aloud.
3. Chunk long assistant text by sentence boundaries where practical.
4. Generate audio through Chatterbox and cache it ephemerally.
5. Serve audio with proper content type, length, cache headers as appropriate, and `206 Partial Content` for valid Range requests.
6. Return clear non-secret errors for failed Chatterbox calls.

### 3. Frontend implementation checkpoints

The read-aloud UX belongs on completed assistant bubbles only.

Expected behavior:

1. Show a `Read aloud` control only after the assistant message is complete.
2. Preserve and pass the original stable message ID; do not generate a new ID on render.
3. Use assistant-visible text, not markdown internals, thinking, tool blocks, or transient streaming fragments.
4. Show loading state while requesting audio.
5. Show a concise error state on failure.
6. Render an audio player or equivalent playback control once audio is ready.
7. Do not show TTS controls on user messages, tool messages, or incomplete assistant streams.

Common pitfall: frontend refactors that re-key messages or synthesize IDs can break backend cache identity and make read-aloud requests fail or regenerate unnecessarily.

### 4. Build and deploy

Build both halves after changes:

```bash
cd ~/src/wayang
npm --prefix backend run build
npm --prefix frontend run build
```

If Wayang runs under systemd, runtime environment may need an override rather than shell-only exports:

```ini
[Service]
Environment=WAYANG_TTS_BASE_URL=http://127.0.0.1:PORT
Environment=WAYANG_TTS_VOICE=Ava.mp3
```

Apply with the user's approval when privileged commands are needed:

```bash
sudo systemctl daemon-reload
sudo systemctl restart wayang
sudo systemctl status wayang --no-pager
```

Do not read or expose protected PIN/config files while doing this.

## Validation

Use this checklist before handoff:

- Chatterbox live probes succeed for `/`, `/docs`, `/openapi.json`, `/v1/audio/voices`, and `/v1/audio/speech`.
- Test audio file is valid according to `file /tmp/wayang-tts-test.mp3`.
- Backend build passes.
- Frontend build passes.
- Completed assistant bubbles show a read-aloud control.
- Incomplete assistant streams do not show read-aloud controls.
- User/tool/thinking content is not read aloud.
- Request uses the stable message ID and correct visible assistant text.
- Audio request returns a playable URL or stream.
- Browser playback works.
- Range requests work, for example:

```bash
curl -i -H 'Range: bytes=0-99' '<audio-url>' -o /tmp/wayang-range.bin
```

Expected: `206 Partial Content` with a valid `Content-Range` header.

## Troubleshooting

### Chatterbox returns 404 or unexpected schema

Probe `/openapi.json` and `/docs`. Do not assume the OpenAI-compatible path exists until validated. Update the client to match the live API.

### Voice not found

Try the exact name from `/v1/audio/voices`. Chatterbox may require a filename such as `Ava.mp3`.

### Saved MP3 is actually JSON or text

The API likely returned an error body. Re-run with `curl -i` or save headers separately. Do not trust the `.mp3` extension.

### Read-aloud button appears on the wrong messages

Check message role and completion state. The control should appear only on completed assistant bubbles.

### Wrong content is spoken

Audit text extraction. Exclude thinking/reasoning, tool calls, tool output, hidden metadata, and markdown/control artifacts that are not meant for speech.

### Cache misses or duplicate generation

Verify that the frontend preserves the backend/session message ID. Avoid render-time random IDs and unstable array indexes.

### Browser cannot seek audio

Check backend Range support: parse `Range`, return `206`, set `Accept-Ranges: bytes`, `Content-Range`, `Content-Length`, and stream only the requested byte span.

### Works in shell but not in service

The systemd service likely lacks `WAYANG_TTS_BASE_URL` or `WAYANG_TTS_VOICE`. Add a systemd override and restart the service with user-approved privileged commands.

### Command guard or sudo blocks deployment

Pause and ask the user to approve/run the command. Do not attempt to read, print, unset, export, or modify command-guard identity PIN files.

## Examples

### Minimal backend smoke test

```bash
cd ~/src/wayang
npm --prefix backend run build
curl -sS -X POST "$WAYANG_TTS_BASE_URL/v1/audio/speech" \
  -H 'Content-Type: application/json' \
  -d '{"input":"Short assistant reply for Wayang.","voice":"Ava.mp3"}' \
  -o /tmp/wayang-smoke.mp3
file /tmp/wayang-smoke.mp3
```

### Manual UX test

1. Start Wayang with TTS env configured.
2. Send a prompt that produces a normal assistant message.
3. Wait for streaming to complete.
4. Click `Read aloud` on the assistant bubble.
5. Confirm loading appears, then an audio control appears and plays.
6. Confirm no thinking/tool text is spoken.
