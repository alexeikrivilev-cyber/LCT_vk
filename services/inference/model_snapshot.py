#!/usr/bin/env python3
"""Materialize a pinned model snapshot, optionally fetching tokenizer assets only."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from huggingface_hub import snapshot_download
from huggingface_hub.utils import disable_progress_bars


PREFLIGHT_FILES = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
    "added_tokens.json",
    "generation_config.json",
    "chat_template.jinja",
    "preprocessor_config.json",
    "video_preprocessor_config.json",
)
REQUIRED_PREFLIGHT_FILES = ("config.json", "tokenizer_config.json", "tokenizer.json")
SECRET_NAME_MARKERS = ("TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")


def redact_secret_values(value: str) -> str:
    for name, secret in os.environ.items():
        if any(marker in name.upper() for marker in SECRET_NAME_MARKERS) and len(secret) >= 4:
            value = value.replace(secret, "[REDACTED]")
    return value


def log(message: str) -> None:
    print(f"[lct-model-snapshot] {redact_secret_values(message)}", file=sys.stderr, flush=True)


def main() -> int:
    if len(sys.argv) != 5 or sys.argv[4] not in {"full", "preflight"}:
        log("usage: model_snapshot.py MODEL_ID MODEL_REVISION HF_HOME full|preflight")
        return 64

    model_id, revision, hf_home, mode = sys.argv[1:]
    cache_dir = Path(hf_home) / "hub"
    allow_patterns = list(PREFLIGHT_FILES) if mode == "preflight" else None

    disable_progress_bars()
    log(f"download.source={model_id}@{revision}")
    log(f"download.mode={mode}")
    log(f"download.cache_dir={cache_dir}")
    try:
        snapshot_path = Path(
            snapshot_download(
                repo_id=model_id,
                revision=revision,
                cache_dir=cache_dir,
                allow_patterns=allow_patterns,
            )
        )
    except Exception as error:
        # Hub exceptions can contain signed download URLs; report the class only.
        log(f"download.result=FAIL exception={type(error).__module__}.{type(error).__qualname__}")
        log("download.traceback=omitted to avoid printing signed URLs or credentials")
        return 1

    if not snapshot_path.is_dir():
        log("download.result=FAIL reason=snapshot path is not a directory")
        return 1

    if mode == "preflight":
        missing = [name for name in REQUIRED_PREFLIGHT_FILES if not (snapshot_path / name).is_file()]
        if missing:
            log(f"download.result=FAIL missing_preflight_files={','.join(missing)}")
            return 1

    log(f"snapshot.path={snapshot_path}")
    log("download.result=SUCCESS")
    # stdout is reserved for the path captured by entrypoint.sh.
    print(snapshot_path, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
