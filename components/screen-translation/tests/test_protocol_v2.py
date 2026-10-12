import base64
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from pipeline import Pipeline
import baidu_credentials as credentials
from worker import handle_request, response
from test_fast_engine import FakeOCR, FakeClient


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.pipeline = Pipeline(engine=FakeOCR())
        buffer = io.BytesIO()
        Image.new("RGB", (200, 100), "white").save(buffer, format="PNG")
        self.request = {"id": 7, "mode": "ocr", "target": "en", "image": base64.b64encode(buffer.getvalue()).decode("ascii")}

    def tearDown(self):
        self.pipeline.close()

    def test_ocr_never_creates_client_reads_credentials_or_opens_network(self):
        with patch("baidu_api.BaiduClient", side_effect=AssertionError("client created")), patch("baidu_credentials.load", side_effect=AssertionError("credential read")), patch("requests.sessions.Session.request", side_effect=AssertionError("network")), patch("socket.socket", side_effect=AssertionError("network")):
            result = handle_request(self.request, self.pipeline)
        self.assertEqual([b["text"] for b in result["blocks"]], ["Hello", "你好", "Hello"])
        self.assertEqual(result["api_requests"], 0)
        self.assertIsNone(self.pipeline.client)

    def test_ocr_rejects_auto_even_without_remote(self):
        with self.assertRaises(ValueError):
            handle_request(dict(self.request, target="auto"), self.pipeline)

    def test_invalid_mode_and_boolean_id_do_not_process_image(self):
        with patch.object(self.pipeline, "recognize", side_effect=AssertionError("unexpected OCR")):
            for change in ({"mode": "unexpected"}, {"mode": None}, {"id": True}):
                self.assertFalse(response(dict(self.request, **change), self.pipeline)["ok"])

    def test_only_png_is_accepted(self):
        buffer = io.BytesIO()
        Image.new("RGB", (10, 10)).save(buffer, format="JPEG")
        self.assertFalse(response(dict(self.request, image=base64.b64encode(buffer.getvalue()).decode()), self.pipeline)["ok"])

    def test_exception_text_never_leaks(self):
        sensitive = "fake-secret-token-http-url"
        with patch.object(self.pipeline, "recognize", side_effect=RuntimeError(sensitive)):
            serialized = json.dumps(response(self.request, self.pipeline))
        self.assertNotIn(sensitive, serialized)

    def test_blank_translate_does_not_initialize_client(self):
        self.pipeline.engine.texts = []
        with patch("baidu_api.BaiduClient", side_effect=AssertionError("client created")):
            result = handle_request(dict(self.request, mode="translate"), self.pipeline)
        self.assertEqual(result["blocks"], [])

    def test_lru_limit_and_evicted_line_retranslated(self):
        self.pipeline.client = FakeClient()
        self.pipeline.cache.update({("en", str(i)): str(i) for i in range(2048)})
        self.pipeline.engine.texts = ["new"]
        self.pipeline.translate(np.full((100, 200, 3), 255, dtype=np.uint8), "en")
        self.assertEqual(len(self.pipeline.cache), 2048)
        self.assertNotIn(("en", "0"), self.pipeline.cache)
        self.assertIn(("en", "new"), self.pipeline.cache)


class CredentialTests(unittest.TestCase):
    def test_no_implicit_old_path_or_empty_path(self):
        for env in ({}, {credentials.ENV_PATH: ""}, {credentials.ENV_PATH: "   "}):
            with patch.dict(os.environ, env, clear=True), patch.object(Path, "read_text", side_effect=AssertionError("must not read any path")):
                self.assertFalse(credentials.status())
                with self.assertRaises(FileNotFoundError):
                    credentials.load()

    def test_status_handles_missing_corrupt_or_incomplete_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.credentials.json"
            with patch.dict(os.environ, {credentials.ENV_PATH: str(path)}):
                self.assertFalse(credentials.status())
                path.write_text("not json", encoding="utf-8")
                self.assertFalse(credentials.status())
                path.write_text(json.dumps({"version": 1, "protected": "e30="}), encoding="utf-8")
                with patch.object(credentials, "crypt", return_value=b'{"api_key":"dummy","secret_key":""}'):
                    self.assertFalse(credentials.status())

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI")
    def test_synthetic_dpapi_round_trip_and_protocol_redaction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.credentials.json"
            pipeline = Pipeline(engine=FakeOCR(), client=FakeClient())
            try:
                with patch.dict(os.environ, {credentials.ENV_PATH: str(path)}):
                    self.assertEqual(handle_request({"id": 1, "mode": "credentials-status"}, pipeline), {"configured": False})
                    result = response({"id": 2, "mode": "configure-credentials", "api_key": "synthetic-key-only", "secret_key": "synthetic-secret-only"}, pipeline)
                    self.assertEqual(result, {"id": 2, "ok": True, "result": {"configured": True}})
                    self.assertEqual(handle_request({"id": 3, "mode": "credentials-status"}, pipeline), {"configured": True})
                    self.assertNotIn("synthetic-key-only", path.read_text())
                    self.assertIsNone(pipeline.client)
                    old = path.read_bytes()
                    self.assertFalse(response({"id": 4, "mode": "configure-credentials", "api_key": "", "secret_key": ""}, pipeline)["ok"])
                    self.assertEqual(path.read_bytes(), old)
                    self.assertEqual(list(path.parent.glob("*.tmp")), [])
            finally:
                pipeline.close()


if __name__ == "__main__":
    unittest.main()
