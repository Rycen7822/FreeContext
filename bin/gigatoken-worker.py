#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import sys
import tempfile
from collections.abc import Sequence

import gigatoken
import tiktoken


def build_tokenizer():
    encoding = tiktoken.get_encoding("o200k_base")
    mergeable_ranks = getattr(encoding, "_mergeable_ranks", None)
    special_tokens = getattr(encoding, "_special_tokens", None)
    if not isinstance(mergeable_ranks, dict) or not isinstance(special_tokens, dict):
        raise RuntimeError("tiktoken o200k_base does not expose the vocabulary required by Gigatoken")

    with tempfile.NamedTemporaryFile(suffix=".tiktoken") as vocabulary:
        for token, rank in sorted(mergeable_ranks.items(), key=lambda item: item[1]):
            vocabulary.write(base64.b64encode(token) + b" " + str(rank).encode("ascii") + b"\n")
        vocabulary.flush()
        return gigatoken.Tokenizer.from_tiktoken(
            vocabulary.name,
            pretokenizer="o200k",
            special_tokens=special_tokens,
        ).as_tiktoken()


TOKENIZER = build_tokenizer()


def token_counts(texts: Sequence[str]) -> list[int]:
    if len(texts) == 1:
        return [len(TOKENIZER.encode(texts[0], allowed_special="all"))]
    return [len(token_ids) for token_ids in TOKENIZER.encode_batch(list(texts), allowed_special="all")]


def respond(request: dict[str, object]) -> dict[str, object]:
    request_id = request.get("id")
    texts = request.get("texts")
    if not isinstance(request_id, int) or not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
        raise ValueError("request must contain an integer id and a string-array texts field")
    return {"id": request_id, "counts": token_counts(texts)}


for line in sys.stdin:
    request: object = {}
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        result = respond(request)
    except Exception as error:  # The Node caller turns this sanitized response into a configuration error.
        request_id = request.get("id") if isinstance(request, dict) else None
        result = {"id": request_id, "error": f"{type(error).__name__}: {error}"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    sys.stdout.flush()
