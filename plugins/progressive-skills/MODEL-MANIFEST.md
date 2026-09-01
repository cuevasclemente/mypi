# Dense retrieval model manifest

- Model: `BAAI/bge-small-en-v1.5`
- Source: <https://huggingface.co/BAAI/bge-small-en-v1.5>
- Pinned source revision: `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`
- License: MIT (FlagEmbedding/model card)
- Parameters: 33.4M
- Dimensions: 384
- Maximum input: 512 tokens
- Local saved-model path: `~/.cache/pi-progressive-skills/models/bge-small-en-v1.5`
- Local saved-model size at validation: 129 MiB
- Deterministic sorted per-file SHA-256 manifest hash: `83e994000e284c59d27c95b213d3c1488ba51c0ef9096fed71b4dc6c6f19034f`
- Runtime policy: local files only; `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `trust_remote_code=false`, CPU inference.

The extension does not download the model. If this local artifact is absent or the embedding worker fails, search falls back to lexical BM25 for the rest of that session.
