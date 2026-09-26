"""Behavior tests for model_snapshot.py with a fully mocked Hub client."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODEL_ID = "Qwen/Qwen3.8-27B"
REVISION = "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0"
OTHER_REVISION = "2d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0"
SCRIPT_PATH = Path(__file__).with_name("model_snapshot.py")


def import_snapshot_module():
    hub = types.ModuleType("huggingface_hub")
    hub.__path__ = []
    hub.snapshot_download = lambda **_kwargs: (_ for _ in ()).throw(AssertionError("unexpected Hub call"))
    hub_utils = types.ModuleType("huggingface_hub.utils")
    hub_utils.__path__ = []
    hub_utils.disable_progress_bars = lambda: None
    hub_logging = types.ModuleType("huggingface_hub.utils.logging")
    hub_logging.set_verbosity_error = lambda: None
    hub.utils = hub_utils
    hub_utils.logging = hub_logging
    with patch.dict(sys.modules, {
        "huggingface_hub": hub,
        "huggingface_hub.utils": hub_utils,
        "huggingface_hub.utils.logging": hub_logging,
    }):
        spec = importlib.util.spec_from_file_location("lct_model_snapshot_tested", SCRIPT_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
    return module


SNAPSHOT = import_snapshot_module()


def seed_complete_snapshot(root: Path, revision: str = REVISION) -> Path:
    cache = root / "huggingface" / "hub"
    snapshot = SNAPSHOT.expected_snapshot_path(cache, MODEL_ID, revision)
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "config.json").write_text('{"model_type":"qwen3_5"}', encoding="utf-8")
    (snapshot / "tokenizer_config.json").write_text('{"tokenizer_class":"Qwen2Tokenizer"}', encoding="utf-8")
    (snapshot / "tokenizer.json").write_text('{"version":"1.0"}', encoding="utf-8")
    (snapshot / "model.safetensors.index.json").write_text(json.dumps({
        "weight_map": {"layer.weight": "model-00001-of-00001.safetensors"},
    }), encoding="utf-8")
    (snapshot / "model-00001-of-00001.safetensors").write_bytes(b"synthetic shard")
    return snapshot


def execute(root: Path, mode: str = "full") -> tuple[int, str, str]:
    output, errors = io.StringIO(), io.StringIO()
    old_argv = sys.argv
    old_environment = os.environ.copy()
    sys.argv = [str(SCRIPT_PATH), MODEL_ID, REVISION, str(root), mode]
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = SNAPSHOT.main()
    finally:
        sys.argv = old_argv
        os.environ.clear()
        os.environ.update(old_environment)
    return code, output.getvalue(), errors.getvalue()


class SnapshotBehaviorTests(unittest.TestCase):
    def test_complete_exact_snapshot_skips_all_hub_materialization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = seed_complete_snapshot(root)
            with patch.object(SNAPSHOT, "get_download_plan", side_effect=AssertionError("complete cache must not query Hub")), \
                    patch.object(SNAPSHOT, "snapshot_download", side_effect=AssertionError("complete cache must not download")):
                code, output, logs = execute(root)
            self.assertEqual(code, 0, logs)
            self.assertEqual(Path(output.strip()), expected.resolve())
            self.assertIn("snapshot.local_required_files_missing=0", logs)
            self.assertIn("snapshot.bytes_required=0", logs)
            self.assertIn("snapshot.download_decision=use_exact_local_snapshot_no_hub_request", logs)

    def test_incomplete_snapshot_resumes_missing_pinned_files_without_force_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = seed_complete_snapshot(root)
            missing_shard = expected / "model-00001-of-00001.safetensors"
            missing_shard.unlink()
            plan = [
                SimpleNamespace(is_cached=True, will_download=False, file_size=100),
                SimpleNamespace(is_cached=False, will_download=True, file_size=4096),
            ]
            calls = []

            def materialize(**kwargs):
                calls.append(kwargs)
                missing_shard.write_bytes(b"resumed synthetic shard")
                return str(expected)

            with patch.object(SNAPSHOT, "get_download_plan", return_value=plan) as plan_call, \
                    patch.object(SNAPSHOT, "snapshot_download", side_effect=materialize):
                code, output, logs = execute(root)
            self.assertEqual(code, 0, logs)
            self.assertEqual(Path(output.strip()), expected.resolve())
            plan_call.assert_called_once_with(MODEL_ID, REVISION, (root / "huggingface" / "hub").resolve(), False, None)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["repo_id"], MODEL_ID)
            self.assertEqual(calls[0]["revision"], REVISION)
            self.assertFalse(calls[0]["force_download"])
            self.assertIn("snapshot.files_missing=1", logs)
            self.assertIn("snapshot.bytes_required=4096", logs)
            self.assertTrue(missing_shard.is_file())

    def test_other_revision_is_never_selected_and_correct_revision_is_materialized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wrong = seed_complete_snapshot(root, OTHER_REVISION)
            expected = SNAPSHOT.expected_snapshot_path(root / "huggingface" / "hub", MODEL_ID, REVISION)
            plan = [SimpleNamespace(is_cached=False, will_download=True, file_size=1024)]
            calls = []

            def materialize(**kwargs):
                calls.append(kwargs)
                complete = seed_complete_snapshot(root, kwargs["revision"])
                return str(complete)

            with patch.object(SNAPSHOT, "get_download_plan", return_value=plan), \
                    patch.object(SNAPSHOT, "snapshot_download", side_effect=materialize):
                code, output, logs = execute(root)
            self.assertEqual(code, 0, logs)
            self.assertEqual(Path(output.strip()), expected.resolve())
            self.assertEqual(calls[0]["revision"], REVISION)
            self.assertTrue(wrong.is_dir(), "a different cached revision must not be silently deleted")

    def test_offline_preflight_fails_closed_without_network_for_missing_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.mkdir(exist_ok=True)
            with patch.object(SNAPSHOT, "get_download_plan", side_effect=AssertionError("offline mode called Hub")), \
                    patch.object(SNAPSHOT, "snapshot_download", side_effect=AssertionError("offline mode downloaded")):
                code, output, logs = execute(root, "offline")
            self.assertNotEqual(code, 0)
            self.assertEqual(output, "")
            self.assertIn("snapshot.bytes_required=unknown (network disabled)", logs)
            self.assertIn("snapshot.download_decision=fail_if_incomplete_no_network", logs)
            self.assertIn("snapshot.status=offline_validation_failed", logs)

    def test_offline_preflight_accepts_complete_snapshot_without_hub_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = seed_complete_snapshot(root)
            with patch.object(SNAPSHOT, "get_download_plan", side_effect=AssertionError("offline mode called Hub")), \
                    patch.object(SNAPSHOT, "snapshot_download", side_effect=AssertionError("offline mode downloaded")):
                code, output, logs = execute(root, "offline")
            self.assertEqual(code, 0, logs)
            self.assertEqual(Path(output.strip()), expected.resolve())
            self.assertIn("snapshot.download_decision=use_exact_local_snapshot_no_network", logs)
            self.assertIn("snapshot.status=ready_offline", logs)

    def test_unwritable_storage_fails_before_any_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(SNAPSHOT.tempfile, "NamedTemporaryFile", side_effect=PermissionError("read-only volume")), \
                    patch.object(SNAPSHOT, "snapshot_download", side_effect=AssertionError("unwritable storage downloaded")):
                code, _output, logs = execute(root, "offline")
            self.assertEqual(code, 73)
            self.assertIn("storage.status=unavailable", logs)
            self.assertIn("error=PermissionError", logs)

    def test_hub_errors_and_logs_never_expose_token_value(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = "hf_lct_test_secret_value"

            def fail_with_secret(*_args, **_kwargs):
                raise RuntimeError(f"authorization bearer {secret}")

            old_token = os.environ.get("HF_TOKEN")
            os.environ["HF_TOKEN"] = secret
            try:
                with patch.object(SNAPSHOT, "get_download_plan", side_effect=fail_with_secret):
                    code, _output, logs = execute(root)
            finally:
                if old_token is None:
                    os.environ.pop("HF_TOKEN", None)
                else:
                    os.environ["HF_TOKEN"] = old_token
            self.assertNotEqual(code, 0)
            self.assertNotIn(secret, logs)
            self.assertNotIn("authorization bearer", logs)
            self.assertIn("error=RuntimeError", logs)


if __name__ == "__main__":
    unittest.main(verbosity=2)
