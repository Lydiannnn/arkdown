"""Version 2 UTF-8 JSON lines. Stdout contains only protocol responses."""
import base64
import contextlib
import io
import json
import sys

MAX_LINE = 32_000_000


def handle_request(request, pipeline):
    if not isinstance(request, dict) or type(request.get("id")) is not int:
        raise ValueError("Invalid request")
    mode = request.get("mode")
    if mode == "credentials-status":
        from baidu_credentials import status
        return {"configured": status()}
    if mode == "configure-credentials":
        from baidu_credentials import save
        save(request.get("api_key"), request.get("secret_key"))
        pipeline.reset_client()
        return {"configured": True}
    if mode not in ("ocr", "translate"):
        raise ValueError("Invalid mode")
    from pipeline import resolve_target
    target = request.get("target")
    if not isinstance(target, str):
        raise ValueError("Invalid target")
    target = resolve_target(target)
    encoded = request.get("image")
    if not isinstance(encoded, str) or len(encoded) > MAX_LINE:
        raise ValueError("Invalid image")
    from PIL import Image
    import numpy as np
    payload = base64.b64decode(encoded, validate=True)
    with Image.open(io.BytesIO(payload)) as image:
        if image.format != "PNG" or image.width * image.height > 20_000_000:
            raise ValueError("Invalid PNG dimensions")
        pixels = np.array(image.convert("RGB"))[:, :, ::-1].copy()
    if mode == "ocr":
        return dict(pipeline.recognize(pixels), target=target)
    return pipeline.translate(pixels, target)


def response(request, pipeline):
    request_id = request.get("id") if isinstance(request, dict) and type(request.get("id")) is int else None
    try:
        return {"id": request_id, "ok": True, "result": handle_request(request, pipeline)}
    except (FileNotFoundError, PermissionError):
        return {"id": request_id, "ok": False, "error": "无法读取或保存本机百度密钥，请在翻译设置中配置。", "needs_settings": True}
    except ValueError:
        return {"id": request_id, "ok": False, "error": "请求格式、图片或固定目标语言无效。", "needs_settings": False}
    except Exception:
        # No exception text, traceback, URL, credential, token or remote body.
        return {"id": request_id, "ok": False, "error": "处理失败，请检查引擎资源、网络或百度密钥配置。", "needs_settings": False}


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8")
    wire = sys.stdout

    def emit(value):
        wire.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        wire.flush()

    with contextlib.redirect_stdout(sys.stderr):
        try:
            from pipeline import Pipeline
            pipeline = Pipeline()
        except Exception:
            emit({"ready": False, "protocol": 2, "error": "OCR 引擎启动失败，请重新解压完整程序包。"})
            return 1
        emit({"ready": True, "protocol": 2})
        try:
            while True:
                line = sys.stdin.readline(MAX_LINE + 1)
                if not line:
                    break
                if len(line) > MAX_LINE or not line.endswith("\n"):
                    return 2
                try:
                    request = json.loads(line.lstrip("\ufeff"))
                except (ValueError, RecursionError):
                    emit({"id": None, "ok": False, "error": "请求 JSON 无效。", "needs_settings": False})
                    continue
                emit(response(request, pipeline))
        finally:
            pipeline.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
