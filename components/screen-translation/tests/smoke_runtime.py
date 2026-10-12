"""Offline end-to-end test with synthetic images and no credential path."""
import base64
import argparse
import io
import json
import hashlib
import os
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--runtime-dir', type=Path, default=ROOT.parents[1] / '.components/screen-translation/runtime/ArkTranslateEngine')
runtime = parser.parse_args().runtime_dir
image = Image.new("RGB", (900, 240), "white")
draw = ImageDraw.Draw(image)
font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 40)
draw.text((30, 30), "Hello Arkdown", font=font, fill="black")
draw.text((30, 110), "Local OCR without network", font=font, fill="black")
buffer = io.BytesIO()
image.save(buffer, format="PNG")
encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
# The wire protocol intentionally accepts PNG only. Exercise the image-array
# path with JPEG-decoded pixels too; no video backend is involved.
jpeg = io.BytesIO()
image.save(jpeg, format="JPEG", quality=95)
jpeg_png = io.BytesIO()
with Image.open(io.BytesIO(jpeg.getvalue())) as decoded:
    decoded.save(jpeg_png, format="PNG")
requests = [{"id": 1, "mode": "credentials-status"},
            {"id": 2, "mode": "ocr", "target": "zh", "image": encoded},
            {"id": 3, "mode": "invalid"},
            {"id": 4, "mode": "ocr", "target": "auto", "image": encoded},
            {"id": 5, "mode": "ocr", "target": "zh", "image": base64.b64encode(jpeg_png.getvalue()).decode("ascii")},
            {"id": 6, "mode": "ocr", "target": "zh", "image": base64.b64encode(jpeg.getvalue()).decode("ascii")}]
env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
env.pop("ARKDOWN_SCREEN_TRANSLATION_CREDENTIALS_FILE", None)
env.pop("ARKDOWN_SCREEN_TRANSLATION_MODEL_DIR", None)
completed = subprocess.run([str(runtime / "ArkTranslateEngine.exe")],
                           input="".join(json.dumps(r) + "\n" for r in requests),
                           capture_output=True, encoding="utf-8", env=env, timeout=90,
                           creationflags=subprocess.CREATE_NO_WINDOW)
assert completed.returncode == 0, "Runtime failed"
messages = [json.loads(line) for line in completed.stdout.splitlines()]
assert messages[0] == {"ready": True, "protocol": 2}, messages[0]
assert messages[1]["result"] == {"configured": False}
assert messages[2]["ok"] and messages[2]["result"]["api_requests"] == 0
texts = " ".join(b["text"] for b in messages[2]["result"]["blocks"])
assert "Hello" in texts and "Arkdown" in texts and "Local" in texts, texts
assert not messages[3]["ok"] and not messages[4]["ok"]
assert messages[5]["ok"] and messages[5]["result"]["api_requests"] == 0
jpeg_texts = " ".join(b["text"] for b in messages[5]["result"]["blocks"])
assert "Hello" in jpeg_texts and "Arkdown" in jpeg_texts and "Local" in jpeg_texts, jpeg_texts
assert not messages[6]["ok"], "Raw JPEG must still be rejected by the PNG-only protocol"
manifest_path = runtime / "component-manifest.json"
if manifest_path.is_file():
    inventory = json.loads(manifest_path.read_text(encoding="utf-8"))
    actual = {p.relative_to(runtime).as_posix() for p in runtime.rglob("*") if p.is_file()}
    assert actual == {f["path"] for f in inventory["files"]} | {"component-manifest.json"}, "Runtime wrote unexpected files"
    for entry in inventory["files"]:
        data = (runtime / entry["path"]).read_bytes()
        assert len(data) == entry["bytes"] and hashlib.sha256(data).hexdigest() == entry["sha256"], entry["path"]
output = ROOT / "tests/smoke-output"
output.mkdir(exist_ok=True)
image.save(output / "synthetic.png")
(output / "runtime-results.json").write_text(json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"passed": True, "protocol": 2, "ocr_blocks": len(messages[2]["result"]["blocks"]),
                  "texts": texts, "jpeg_decoded_texts": jpeg_texts, "raw_jpeg_rejected": True,
                  "inventory_unchanged": manifest_path.is_file()}, ensure_ascii=False))
