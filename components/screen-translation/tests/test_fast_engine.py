import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from pipeline import Pipeline, resolve_target


class FakeOCR:
    texts = ["Hello", "你好", "Hello"]

    def __call__(self, image, **kwargs):
        boxes = np.array([[[10, 10 + i * 20], [90, 10 + i * 20],
                           [90, 25 + i * 20], [10, 25 + i * 20]] for i in range(len(self.texts))])
        return SimpleNamespace(txts=self.texts, boxes=boxes)


class FakeClient:
    requests = 0

    def translate(self, text, target):
        self.requests += 1
        return {"text": target + ":" + text, "target": target}


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.ocr = FakeOCR()
        self.client = FakeClient()
        self.pipeline = Pipeline(engine=self.ocr, client=self.client)
        self.image = np.full((100, 200, 3), 255, dtype=np.uint8)

    def tearDown(self):
        self.pipeline.close()

    def test_fixed_target_mixed_source_and_duplicate_lines(self):
        result = self.pipeline.translate(self.image, "English")
        self.assertEqual(result["api_requests"], 2)
        self.assertEqual([b["text"] for b in result["blocks"]], ["en:Hello", "en:你好", "en:Hello"])

    def test_cache_only_changed_lines_and_target_partition(self):
        self.pipeline.translate(self.image, "简体中文")
        self.assertEqual(self.pipeline.translate(self.image, "简体中文")["api_requests"], 0)
        self.ocr.texts = ["New text", "你好", "Hello"]
        self.assertEqual(self.pipeline.translate(self.image, "简体中文")["api_requests"], 1)
        self.assertEqual(self.pipeline.translate(self.image, "Français")["api_requests"], 3)

    def test_blank_frame_does_not_call_remote(self):
        self.ocr.texts = []
        result = self.pipeline.translate(self.image, "English")
        self.assertEqual(result["blocks"], [])
        self.assertEqual(self.client.requests, 0)

    def test_source_position_and_background_retained(self):
        result = self.pipeline.translate(self.image)
        self.assertEqual(result["blocks"][0]["box"], [50, 100, 450, 250])
        self.assertEqual(result["blocks"][0]["background"], "#FFFFFF")
        self.image[:] = 20
        self.assertEqual(self.pipeline.translate(self.image)["blocks"][0]["foreground"], "#FFFFFF")

    def test_target_never_accepts_auto_or_invents_code(self):
        self.assertEqual(resolve_target("繁體中文"), "cht")
        self.assertEqual(resolve_target("日本語"), "jp")
        for target in ("auto", "", "unknown-language"):
            with self.assertRaises(ValueError):
                self.pipeline.translate(self.image, target)
        self.assertEqual(self.client.requests, 0)


if __name__ == "__main__":
    unittest.main()
