# Progressive Skills

Provider-agnostic on-demand skill discovery for Pi.

The extension removes Pi's global model-visible skill catalog from the per-turn system prompt and replaces it with a compact discovery protocol. Skills remain fully discovered by Pi and available through:

- `skill_search` — hybrid local dense + BM25 retrieval, lexical fallback;
- `skill_load` — exact-name, descriptor-relative, bounded `SKILL.md` loading;
- explicit `/skill:name` commands;
- up to five trusted-project pins in `.pi/progressive-skills.json`.

The extension creates no separate prompt/query/content logs and the dense worker is local-only with no runtime downloads. Normal Pi behavior still applies: `skill_search` arguments and tool results are persisted in the session JSONL and sent to the active model provider; a loaded `SKILL.md` is model-visible context. Search queries should omit private details that are irrelevant to routing.

## Project pins

```json
{
  "pins": ["memoriki", "home-assistant-automation-troubleshooting"]
}
```

Pins disclose only the standard skill metadata. The agent must still load the instructions before acting.

## Dense retrieval

Defaults:

- model path: `~/.cache/pi-progressive-skills/models/bge-small-en-v1.5`
- Python: `PI_PROGRESSIVE_SKILLS_PYTHON`, otherwise the extension-managed `~/.cache/pi-progressive-skills/venv/bin/python`

Create/update the managed worker environment from the reviewed lock file:

```bash
uv venv --python 3.12 ~/.cache/pi-progressive-skills/venv
uv pip sync --python ~/.cache/pi-progressive-skills/venv/bin/python worker-requirements.lock \\
  --index-strategy unsafe-best-match \\
  --extra-index-url https://download.pytorch.org/whl/cpu
```

Optional overrides:

```text
PI_PROGRESSIVE_SKILLS_MODEL_PATH=/absolute/local/model
PI_PROGRESSIVE_SKILLS_PYTHON=/absolute/python
```

If the interpreter/model/worker is unavailable, `skill_search` uses lexical BM25 only and does not repeatedly restart a failed worker during that session. Dense and lexical candidates must also clear calibrated relevance thresholds; unrelated queries return no match instead of loading the nearest skill unconditionally.

Skill bodies are opened through a held Linux `/proc/self/fd` directory descriptor with no-follow semantics, must be direct children of Pi's approved skill root, and are rejected above 36 KiB or 1500 lines. Final tool results are kept below 48 KiB and 1800 lines; instructions are rejected rather than partially truncated.

## Relevance evaluation

Generate a metadata-only catalog through Pi's `before_agent_start` options, then run:

```bash
tsx evaluate-relevance.ts /tmp/pi-skill-catalog.json
```

The checked-in fixture gates positive recall@3 and unrelated-query no-match precision separately.

## Disable

```text
PI_PROGRESSIVE_SKILLS=0
```

Reload or start a fresh session after changing the extension or its environment.
