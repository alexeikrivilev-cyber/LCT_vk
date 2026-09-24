#!/usr/bin/env python3
"""Materialize a pinned model snapshot in the configured persistent cache."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

from huggingface_hub import snapshot_download
from huggingface_hub.utils import disable_progress_bars
from huggingface_hub.utils.logging import set_verbosity_error


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


def prepare_storage(storage_root: Path, hf_cache: Path) -> bool:
    try:
        storage_root.mkdir(parents=True, exist_ok=True)
        hf_cache.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=".lct-storage-check-", dir=storage_root):
            pass
    except OSError as error:
        log(f"storage.status=unavailable error={type(error).__name__} root={storage_root}")
        return False

    log("storage.status=available_and_writable")
    return True


def get_download_plan(
    model_id: str,
    revision: str,
    hf_cache: Path,
    token: str | bool,
    allow_patterns: list[str] | None,
) -> list:
    plan = snapshot_download(
        repo_id=model_id,
        revision=revision,
        cache_dir=hf_cache,
        token=token,
        allow_patterns=allow_patterns,
        dry_run=True,
    )
    if not isinstance(plan, list) or not plan:
        raise RuntimeError("Hugging Face dry-run returned no model files")
    return plan


def main() -> int:
    if len(sys.argv) != 5 or sys.argv[4] not in {"full", "preflight"}:
        log("usage: model_snapshot.py MODEL_ID MODEL_REVISION STORAGE_ROOT full|preflight")
        return 64

    model_id, revision, root_value, mode = sys.argv[1:]
    root_input = Path(root_value).expanduser()
    if not root_input.is_absolute():
        log("storage.status=invalid reason=LCT_MODEL_STORAGE_ROOT must be an absolute path")
        return 64

    storage_root = root_input.resolve()
    hf_home = storage_root / "huggingface"
    hf_cache = hf_home / "hub"
    allow_patterns = list(PREFLIGHT_FILES) if mode == "preflight" else None
    hub_token: str | bool = os.environ.get("HF_TOKEN") or False

    log(f"model.source={model_id}")
    log(f"model.revision={revision}")
    log(f"storage.root={storage_root}")
    log(f"hf.cache={hf_cache}")
    log(f"snapshot.mode={mode}")
    if not prepare_storage(storage_root, hf_cache):
        log("snapshot.status=storage_unavailable")
        return 73

    # Keep Hub's own diagnostics quiet: debug request logs can contain auth headers.
    disable_progress_bars()
    set_verbosity_error()

    common_args = {
        "repo_id": model_id,
        "revision": revision,
        "cache_dir": hf_cache,
        "token": hub_token,
        "force_download": False,
    }

    log("snapshot.status=checking_cache_and_available_space")
    try:
        plan = get_download_plan(model_id, revision, hf_cache, hub_token, allow_patterns)
        pending_files = [file for file in plan if file.will_download]
        cached_files = sum(1 for file in plan if file.is_cached)
        required_bytes = sum(file.file_size for file in pending_files)
        available_bytes = shutil.disk_usage(storage_root).free
    except Exception as error:
        log(f"snapshot.status=preflight_failed error={type(error).__name__}")
        return 1

    log(f"snapshot.files_total={len(plan)}")
    log(f"snapshot.files_cached={cached_files}")
    log(f"snapshot.bytes_required={required_bytes}")
    log(f"storage.bytes_available={available_bytes}")
    if required_bytes > available_bytes:
        log("snapshot.status=insufficient_disk_space")
        return 73
    if not pending_files:
        status = "reusing_preflight_assets" if mode == "preflight" else "reusing_cached_snapshot"
        log(f"snapshot.status={status}")
    elif cached_files:
        status = "resuming_preflight_assets" if mode == "preflight" else "resuming_partial_snapshot"
        log(f"snapshot.status={status}")
    elif mode == "preflight":
        log("snapshot.status=materializing_preflight_assets")
    else:
        log("snapshot.status=downloading_snapshot")

    try:
        snapshot_path = Path(
            snapshot_download(
                **common_args,
                allow_patterns=allow_patterns,
            )
        )
    except Exception as error:
        # Hub exceptions may include signed download URLs; don't print their messages.
        log(f"snapshot.status=failed error={type(error).__name__}")
        return 1

    if not snapshot_path.is_dir():
        log("snapshot.status=failed reason=snapshot path is not a directory")
        return 1

    if mode == "preflight":
        missing = [name for name in REQUIRED_PREFLIGHT_FILES if not (snapshot_path / name).is_file()]
        if missing:
            log(f"snapshot.status=failed missing_preflight_files={','.join(missing)}")
            return 1

    log(f"snapshot.path={snapshot_path}")
    log("snapshot.status=ready")
    # stdout is reserved for the path captured by entrypoint.sh.
    print(snapshot_path, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
