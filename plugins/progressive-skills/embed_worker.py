#!/usr/bin/env python3
"""Local-only JSONL embedding worker for progressive skill search."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

MAX_LINE_BYTES = 1_048_576
MAX_DOCUMENTS = 512
MAX_TEXT_CHARS = 4096
REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, allow_nan=False, separators=(",", ":")), flush=True)


def fail(request_id: str | None, error: str) -> None:
    emit({"id": request_id, "ok": False, "error": error})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    model_path = args.model_path.expanduser().resolve()
    if not model_path.is_dir():
        fail(None, "model_unavailable")
        return 2

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        import numpy as np
        import torch
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(min(4, os.cpu_count() or 1))
        model = SentenceTransformer(
            str(model_path),
            device="cpu",
            trust_remote_code=False,
            local_files_only=True,
        )
    except Exception:
        fail(None, "model_load_failed")
        return 2

    names: list[str] = []
    matrix: Any | None = None
    for raw_line in sys.stdin.buffer:
        if len(raw_line) > MAX_LINE_BYTES:
            fail(None, "request_too_large")
            continue
        try:
            request = json.loads(raw_line)
        except Exception:
            fail(None, "invalid_json")
            continue
        request_id = request.get("id") if isinstance(request, dict) else None
        if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
            fail(None, "invalid_id")
            continue
        operation = request.get("op")
        if operation == "index":
            documents = request.get("documents")
            if not isinstance(documents, list) or not 1 <= len(documents) <= MAX_DOCUMENTS:
                fail(request_id, "invalid_documents")
                continue
            parsed_names: list[str] = []
            texts: list[str] = []
            valid = True
            for document in documents:
                if not isinstance(document, dict):
                    valid = False
                    break
                name = document.get("name")
                text = document.get("text")
                if (
                    not isinstance(name, str)
                    or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name)
                    or not isinstance(text, str)
                    or not 1 <= len(text) <= MAX_TEXT_CHARS
                ):
                    valid = False
                    break
                parsed_names.append(name)
                texts.append(text)
            if not valid or len(set(parsed_names)) != len(parsed_names):
                fail(request_id, "invalid_documents")
                continue
            try:
                encoded = model.encode(
                    texts,
                    batch_size=32,
                    normalize_embeddings=True,
                    convert_to_numpy=True,
                    show_progress_bar=False,
                )
                matrix = np.asarray(encoded, dtype=np.float32)
                names = parsed_names
                emit({"id": request_id, "ok": True, "count": len(names), "dimensions": int(matrix.shape[1])})
            except Exception:
                names = []
                matrix = None
                fail(request_id, "index_failed")
        elif operation == "search":
            query = request.get("query")
            limit = request.get("limit", 20)
            if matrix is None or not names:
                fail(request_id, "index_unavailable")
                continue
            if not isinstance(query, str) or not 1 <= len(query) <= 500 or not isinstance(limit, int) or not 1 <= limit <= 50:
                fail(request_id, "invalid_query")
                continue
            try:
                query_vector = model.encode(
                    [QUERY_PREFIX + query],
                    normalize_embeddings=True,
                    convert_to_numpy=True,
                    show_progress_bar=False,
                )[0]
                scores = matrix @ np.asarray(query_vector, dtype=np.float32)
                order = np.argsort(-scores)[:limit]
                emit({
                    "id": request_id,
                    "ok": True,
                    "results": [
                        {"name": names[int(index)], "score": float(scores[int(index)])}
                        for index in order
                    ],
                })
            except Exception:
                fail(request_id, "search_failed")
        else:
            fail(request_id, "invalid_operation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
