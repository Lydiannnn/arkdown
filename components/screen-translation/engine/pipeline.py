"""Resident local OCR, fixed-target translation and per-line LRU cache."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import time
import os
import numpy as np

TARGETS = {
    "简体中文": "zh", "中文": "zh", "繁體中文": "cht", "繁体中文": "cht",
    "English": "en", "英语": "en", "日本語": "jp", "日语": "jp",
    "한국어": "kor", "韩语": "kor", "Français": "fra", "法语": "fra",
    "Deutsch": "de", "德语": "de", "Español": "spa", "西班牙语": "spa",
    "Русский": "ru", "俄语": "ru", "العربية": "ara", "阿拉伯语": "ara",
    "Português": "pt", "葡萄牙语": "pt", "Italiano": "it", "意大利语": "it",
    "ไทย": "th", "泰语": "th", "Tiếng Việt": "vie", "越南语": "vie",
}


def resolve_target(target):
    target = target.strip()
    if target in TARGETS:
        return TARGETS[target]
    if target in TARGETS.values():
        return target
    raise ValueError("百度快译请选择列表中的目标语言；其他目标语言可切换 Luna。")


class Pipeline:
    def __init__(self, engine=None, client=None, model_dir=None):
        if engine is None:
            from rapidocr import RapidOCR, OCRVersion, ModelType
            root = Path(model_dir or os.environ.get("ARKDOWN_SCREEN_TRANSLATION_MODEL_DIR") or (Path(__file__).resolve().parent / "models"))
            for name in ("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx"):
                if not (root / name).is_file():
                    raise FileNotFoundError("OCR 模型文件缺失，请重新解压完整程序包。")
            engine = RapidOCR(params={
                "Global.model_root_dir": str(root), "Global.log_level": "error", "Global.use_cls": False,
                "Det.ocr_version": OCRVersion.PPOCRV6, "Det.model_type": ModelType.SMALL,
                "Rec.ocr_version": OCRVersion.PPOCRV6, "Rec.model_type": ModelType.SMALL,
                "Det.limit_type": "max", "Det.limit_side_len": 960,
                "EngineConfig.onnxruntime.intra_op_num_threads": 4,
                "EngineConfig.onnxruntime.inter_op_num_threads": 1,
                "EngineConfig.onnxruntime.use_cuda": False,
            })
        self.engine, self.client = engine, client
        self.pool = ThreadPoolExecutor(max_workers=3)
        self.cache = OrderedDict()

    def recognize(self, image):
        """Local OCR only: never create a Baidu client or access credentials."""
        start = time.perf_counter()
        ocr = self.engine(image, use_cls=False)
        ocr_ms = (time.perf_counter() - start) * 1000
        texts = list(ocr.txts or [])
        if len(texts) > 256:
            raise ValueError("选区文字块过多，请缩小范围。")
        blocks = []
        polygons = [] if ocr.boxes is None else ocr.boxes.tolist()
        h, w = image.shape[:2]
        for text, points in zip(texts, polygons):
            left = max(0, int(min(p[0] for p in points)))
            top = max(0, int(min(p[1] for p in points)))
            right = min(w, int(np.ceil(max(p[0] for p in points))))
            bottom = min(h, int(np.ceil(max(p[1] for p in points))))
            box = [round(left / w * 1000), round(top / h * 1000), round(right / w * 1000), round(bottom / h * 1000)]
            if right <= left or bottom <= top or box[2] <= box[0] or box[3] <= box[1]:
                continue
            # Text strokes usually occupy less than half of the tight box. Median
            # sampling retains flat light/dark UI backgrounds without remote vision.
            pixels = image[top:bottom, left:right].reshape(-1, 3)
            rgb = np.median(pixels[::max(1, len(pixels) // 2048)], axis=0)[::-1].astype(int)
            background = "#" + "".join(f"{c:02X}" for c in rgb)
            foreground = "#182030" if np.dot(rgb, [0.2126, 0.7152, 0.0722]) > 140 else "#FFFFFF"
            blocks.append({"text": text, "box": box, "background": background, "foreground": foreground})
        return {"blocks": blocks, "ocr_ms": round(ocr_ms, 1),
                "total_ms": round((time.perf_counter() - start) * 1000, 1), "api_requests": 0}

    def reset_client(self):
        # Called between serial requests after credentials change.
        self.client = None
        self.cache.clear()

    def translate(self, image, target="zh", cache=True):
        target = resolve_target(target)
        start = time.perf_counter()
        recognized = self.recognize(image)
        texts = [block["text"] for block in recognized["blocks"]]
        if not texts:
            return dict(recognized, target=target)
        if self.client is None:
            from baidu_api import BaiduClient
            self.client = BaiduClient()
        before = self.client.requests
        translated, futures = {}, {}
        # Source recognition is independent per line; the selected target never changes.
        for text in texts:
            key = (target, text)
            if text in translated or text in futures:
                continue
            if cache and key in self.cache:
                translated[text] = self.cache[key]
                self.cache.move_to_end(key)
            else:
                futures[text] = self.pool.submit(self.client.translate, text, target)
        failure = None
        for text, future in futures.items():
            try:
                response = future.result()
                if response.get("target") != target:
                    raise ValueError("百度返回的目标语言不匹配，请重试。")
                translated[text] = response["text"]
                self.cache[(target, text)] = response["text"]
            except Exception as error:
                # Drain this frame before accepting another so failures cannot leave
                # background requests consuming quota after a reported completion.
                failure = error
        while len(self.cache) > 2048:
            self.cache.popitem(last=False)
        if failure is not None:
            raise failure
        blocks = [dict(block, text=translated[block["text"]]) for block in recognized["blocks"]]
        return {"target": target, "blocks": blocks, "ocr_ms": recognized["ocr_ms"],
                "total_ms": round((time.perf_counter() - start) * 1000, 1),
                "api_requests": self.client.requests - before}

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)
