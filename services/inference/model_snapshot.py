#!/usr/bin/env python3
"""Resolve and validate an immutable Hugging Face model snapshot."""

from __future__ import annotations

import json
import os
import re
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
WEIGHT_INDEX_FILES = ("model.safetensors.index.json", "pytorch_model.bin.index.json")
SINGLE_WEIGHT_FILES = ("model.safetensors", "pytorch_model.bin")
MODEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
REVISION_PATTERN = re.compile(r"^[A-Fa-f0-9]{40}$")


def redact_secret_values(value: str) -> str:
    for name, secret in os.environ.items():
        if any(marker in name.upper() for marker in SECRET_NAME_MARKERS) and len(secret) >= 4:
            value = value.replace(secret, "[REDACTED]")
    return value


def log(message: str) -> None:
    print(f"[lct-model-snapshot] {redact_secret_values(message)}", file=sys.stderr, flush=True)


def expected_snapshot_path(hf_cache: Path, model_id: str, revision: str) -> Path:
    repo_folder = f"models--{model_id.replace('/', '--')}"
    return hf_cache / repo_folder / "snapshots" / revision


def prepare_storage(storage_root: Path, hf_cache: Path, *, create: bool) -> bool:
    try:
        if create:
            storage_root.mkdir(parents=True, exist_ok=True)
            hf_cache.mkdir(parents=True, exist_ok=True)
        elif not storage_root.is_dir():
            log(f"storage.status=unavailable reason=root_not_mounted root={storage_root}")
            return False

        if hf_cache.exists() and not hf_cache.is_dir():
            log(f"storage.status=unavailable reason=cache_path_not_directory path={hf_cache}")
            return False

        for directory in (storage_root, hf_cache if hf_cache.is_dir() else None):
            if directory is None:
                continue
            with tempfile.NamedTemporaryFile(prefix=".lct-storage-check-", dir=directory):
                pass
    except OSError as error:
        log(f"storage.status=unavailable error={type(error).__name__} root={storage_root}")
        return False

    log("storage.status=available_and_writable")
    return True


def weight_inventory(snapshot_path: Path) -> tuple[list[str], str | None]:
    for index_name in WEIGHT_INDEX_FILES:
        index_path = snapshot_path / index_name
        if not index_path.is_file():
            continue
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return [], f"invalid_weight_index:{index_name}"

        weight_map = index.get("weight_map") if isinstance(index, dict) else None
        if not isinstance(weight_map, dict) or not weight_map:
            return [], f"invalid_weight_index:{index_name}"

        shards: set[str] = set()
        for shard in weight_map.values():
            if (not isinstance(shard, str) or Path(shard).name != shard
                    or shard in {".", ".."} or not shard.endswith((".safetensors", ".bin"))):
                return [], f"invalid_weight_shard_name:{index_name}"
            shards.add(shard)
        return [index_name, *sorted(shards)], None

    for weight_name in SINGLE_WEIGHT_FILES:
        if (snapshot_path / weight_name).is_file():
            return [weight_name], None

    return [], None


def inspect_local_snapshot(snapshot_path: Path, *, include_weights: bool) -> dict[str, object]:
    required = list(REQUIRED_PREFLIGHT_FILES)
    inventory_error = None
    if include_weights:
        weights, inventory_error = weight_inventory(snapshot_path)
        required.extend(weights)
        if not weights and inventory_error is None:
            # This is a missing inventory marker, not a claim about the remote filename.
            required.append("<model-weight-index-or-single-shard>")

    missing = [name for name in required if name.startswith("<") or not (snapshot_path / name).is_file()]
    return {
        "path": snapshot_path,
        "required": required,
        "missing": missing,
        "cached_count": len(required) - len(missing),
        "missing_count": len(missing),
        "inventory_error": inventory_error,
    }


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


def report_inventory(inventory: dict[str, object]) -> None:
    log(f"snapshot.local_required_files_total={len(inventory['required'])}")
    log(f"snapshot.local_required_files_cached={inventory['cached_count']}")
    log(f"snapshot.local_required_files_missing={inventory['missing_count']}")
    missing = inventory["missing"]
    if missing:
        log(f"snapshot.local_missing_names={','.join(str(name) for name in missing[:20])}")
    if inventory["inventory_error"]:
        log(f"snapshot.inventory_error={inventory['inventory_error']}")


def main() -> int:
    if len(sys.argv) != 5 or sys.argv[4] not in {"full", "preflight", "offline"}:
        log("usage: model_snapshot.py MODEL_ID MODEL_REVISION STORAGE_ROOT full|preflight|offline")
        return 64

    model_id, revision, root_value, mode = sys.argv[1:]
    if not MODEL_ID_PATTERN.fullmatch(model_id) or not REVISION_PATTERN.fullmatch(revision):
        log("snapshot.status=invalid reason=model_id_or_revision_invalid")
        return 64

    root_input = Path(root_value).expanduser()
    if not root_input.is_absolute():
        log("storage.status=invalid reason=LCT_MODEL_STORAGE_ROOT must be an absolute path")
        return 64

    storage_root = root_input.resolve()
    hf_home = storage_root / "huggingface"
    hf_cache = hf_home / "hub"
    exact_snapshot = expected_snapshot_path(hf_cache, model_id, revision)
    allow_patterns = list(PREFLIGHT_FILES) if mode == "preflight" else None
    hub_token: str | bool = os.environ.get("HF_TOKEN") or False

    log(f"model.source={model_id}")
    log(f"model.revision={revision}")
    log(f"storage.root={storage_root}")
    log(f"hf.cache={hf_cache}")
    log(f"snapshot.path={exact_snapshot}")
    log(f"snapshot.mode={mode}")

    if not prepare_storage(storage_root, hf_cache, create=mode != "offline"):
        log("snapshot.status=storage_unavailable")
        return 73

    if mode == "offline":
        # No Hub API calls exist on this branch. These also protect the subsequent
        # AutoConfig/AutoTokenizer check invoked by the container entrypoint.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        inventory = inspect_local_snapshot(exact_snapshot, include_weights=True)
        report_inventory(inventory)
        if inventory["inventory_error"] or inventory["missing_count"]:
            log("snapshot.bytes_required=unknown (network disabled)")
            log("snapshot.download_decision=fail_if_incomplete_no_network")
            log("snapshot.status=offline_validation_failed")
            return 1
        log("snapshot.bytes_required=0")
        log("snapshot.download_decision=use_exact_local_snapshot_no_network")
        log("snapshot.status=ready_offline")
        print(exact_snapshot.resolve(), flush=True)
        return 0

    include_weights = mode == "full"
    inventory = inspect_local_snapshot(exact_snapshot, include_weights=include_weights)
    report_inventory(inventory)
    if inventory["inventory_error"]:
        log("snapshot.bytes_required=unknown")
        log("snapshot.download_decision=fail_invalid_local_inventory_without_deleting_cache")
        log("snapshot.status=local_inventory_invalid")
        return 1

    if inventory["missing_count"] == 0:
        log("snapshot.bytes_required=0")
        log("snapshot.download_decision=use_exact_local_snapshot_no_hub_request")
        log("snapshot.status=reusing_cached_snapshot" if include_weights else "snapshot.status=reusing_preflight_assets")
        print(exact_snapshot.resolve(), flush=True)
        return 0

    # The exact local snapshot is incomplete. Only now consult the pinned Hub
    # commit for an uncached-file plan; snapshot_download resumes missing files
    # without force_download and does not delete any existing cache entries.
    disable_progress_bars()
    set_verbosity_error()
    log("snapshot.status=checking_remote_plan_for_incomplete_snapshot")
    try:
        plan = get_download_plan(model_id, revision, hf_cache, hub_token, allow_patterns)
        pending_files = [file for file in plan if file.will_download]
        cached_files = sum(1 for file in plan if file.is_cached)
        required_bytes = sum(int(file.file_size or 0) for file in pending_files)
        available_bytes = shutil.disk_usage(storage_root).free
    except Exception as error:
        log(f"snapshot.status=preflight_failed error={type(error).__name__}")
        return 1

    log(f"snapshot.files_total={len(plan)}")
    log(f"snapshot.files_cached={cached_files}")
    log(f"snapshot.files_missing={len(pending_files)}")
    log(f"snapshot.bytes_required={required_bytes}")
    log(f"storage.bytes_available={available_bytes}")
    log("snapshot.download_decision=download_missing_pinned_files" if pending_files else "snapshot.download_decision=resolve_local_cache_inconsistency")
    if required_bytes > available_bytes:
        log("snapshot.status=insufficient_disk_space")
        return 73

    common_args = {
        "repo_id": model_id,
        "revision": revision,
        "cache_dir": hf_cache,
        "token": hub_token,
        "force_download": False,
    }
    try:
        snapshot_path = Path(snapshot_download(**common_args, allow_patterns=allow_patterns))
    except Exception as error:
        # Hub exceptions may include signed download URLs; don't print their messages.
        log(f"snapshot.status=failed error={type(error).__name__}")
        return 1

    if not snapshot_path.is_dir() or snapshot_path.resolve() != exact_snapshot.resolve():
        log("snapshot.status=failed reason=resolved_snapshot_does_not_match_pinned_revision")
        return 1

    inventory = inspect_local_snapshot(exact_snapshot, include_weights=include_weights)
    report_inventory(inventory)
    if inventory["inventory_error"] or inventory["missing_count"]:
        log("snapshot.status=post_materialization_validation_failed")
        return 1

    log(f"snapshot.path={exact_snapshot.resolve()}")
    log("snapshot.status=ready")
    print(exact_snapshot.resolve(), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
