#!/usr/bin/env python3
"""Report the runtime tokenizer environment and load only tokenizer assets."""

from __future__ import annotations

import importlib
import importlib.metadata
import importlib.util
import json
import os
import platform
import shutil
import sys
import traceback


PACKAGES = (
    ("transformers", "transformers"),
    ("tokenizers", "tokenizers"),
    ("tiktoken", "tiktoken"),
    ("sentencepiece", "sentencepiece"),
)
SECRET_NAME_MARKERS = ("TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")


def redact_secret_values(value: str) -> str:
    for name in os.environ:
        if not any(marker in name.upper() for marker in SECRET_NAME_MARKERS):
            continue
        secret = os.environ.get(name, "")
        if len(secret) >= 4:
            value = value.replace(secret, "[REDACTED]")
    return value


def log(message: str) -> None:
    print(f"[lct-tokenizer-preflight] {redact_secret_values(message)}", flush=True)


def report_packages() -> None:
    for module_name, distribution_name in PACKAGES:
        try:
            spec = importlib.util.find_spec(module_name)
            log(f"find_spec[{module_name}]={spec!r}")
        except Exception:
            log(f"find_spec[{module_name}]=ERROR")
            log(redact_secret_values(traceback.format_exc()))

        try:
            module = importlib.import_module(module_name)
        except Exception:
            log(f"package[{module_name}].version=unavailable file=unavailable")
            log(redact_secret_values(traceback.format_exc()))
            continue

        try:
            version = importlib.metadata.version(distribution_name)
        except importlib.metadata.PackageNotFoundError:
            version = "unavailable"
        module_file = getattr(module, "__file__", "unavailable")
        log(f"package[{module_name}].version={version} file={module_file}")


def align_sys_path_with_vllm_launcher() -> None:
    launcher = shutil.which("vllm")
    if launcher is None:
        return
    launcher_directory = os.path.dirname(os.path.realpath(launcher))
    if sys.path:
        sys.path[0] = launcher_directory
    else:
        sys.path.insert(0, launcher_directory)


def main() -> int:
    if len(sys.argv) != 4:
        log("usage: tokenizer_preflight.py MODEL_LOCAL_PATH MODEL_ID MODEL_REVISION")
        return 64

    align_sys_path_with_vllm_launcher()
    model_path, model_id, revision = sys.argv[1:]
    log(f"python.executable={sys.executable}")
    log(f"python.version={platform.python_version()} ({sys.version.splitlines()[0]})")
    log(f"python.sys_path={json.dumps(sys.path)}")
    report_packages()
    log(f"snapshot.source={model_id}@{revision}")
    log(f"snapshot.local_path={model_path}")

    try:
        from transformers import AutoConfig
        from transformers import AutoTokenizer

        config = AutoConfig.from_pretrained(model_path, local_files_only=True)
        tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
        backend = getattr(tokenizer, "backend_tokenizer", None)
        if backend is None:
            backend = getattr(tokenizer, "_tokenizer", None)
        if backend is None:
            raise RuntimeError("AutoTokenizer returned no backend tokenizer")
    except Exception:
        log("tokenizer.result=FAIL")
        log("tokenizer.traceback follows (credential values redacted):")
        log(traceback.format_exc())
        return 1

    tokenizer_class = f"{type(tokenizer).__module__}.{type(tokenizer).__qualname__}"
    backend_class = f"{type(backend).__module__}.{type(backend).__qualname__}"
    config_class = f"{type(config).__module__}.{type(config).__qualname__}"
    log(f"config.class={config_class}")
    log(f"config.model_type={getattr(config, 'model_type', 'unavailable')}")
    log(f"tokenizer.class={tokenizer_class}")
    log(f"tokenizer.backend_class={backend_class}")
    log("tokenizer.result=SUCCESS")
    log("tokenizer.traceback=none (success)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
