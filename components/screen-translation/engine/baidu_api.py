"""Baidu Cloud general text translation, using encrypted per-user credentials."""
import threading
import time
import requests
from baidu_credentials import load


class BaiduError(RuntimeError):
    pass


class BaiduClient:
    def __init__(self):
        self.local = threading.local()
        self.token = None
        self.expires = 0
        self.auth_lock = threading.Lock()
        self.rate_lock = threading.Lock()
        self.next_request = 0
        self.auth_ms = None
        self.requests = 0

    def session(self):
        if not hasattr(self.local, "session"):
            self.local.session = requests.Session()
        return self.local.session

    def request(self, endpoint, **kwargs):
        try:
            response = self.session().post(endpoint, timeout=(10, 20), allow_redirects=False, **kwargs)
        except requests.RequestException:
            # Exception strings may include URLs containing credentials/tokens.
            raise BaiduError("无法连接百度翻译，请检查网络") from None
        if response.status_code != 200:
            raise BaiduError(f"百度接口 HTTP {response.status_code}")
        if len(response.content) > 2000000:
            raise BaiduError("百度返回内容过大")
        try:
            data = response.json()
        except ValueError:
            raise BaiduError("百度返回了非 JSON 响应") from None
        if data.get("error_code") or data.get("error"):
            code = str(data.get("error_code", ""))
            safe_code = code if code.isascii() and code.isdigit() and len(code) <= 12 else "unknown"
            raise BaiduError("百度接口错误：" + safe_code)
        return data

    def authenticate(self):
        with self.auth_lock:
            if self.token and self.expires > time.monotonic():
                return
            credentials = load()
            started = time.perf_counter()
            data = self.request("https://aip.baidubce.com/oauth/2.0/token", params={"grant_type": "client_credentials", "client_id": credentials["api_key"], "client_secret": credentials["secret_key"]})
            self.auth_ms = (time.perf_counter() - started) * 1000
            if not data.get("access_token"):
                raise BaiduError("百度鉴权没有返回 access_token")
            self.token = data["access_token"]
            self.expires = time.monotonic() + max(0, int(data.get("expires_in", 3600)) - 120)

    def translate(self, text, target="zh", source="auto"):
        self.authenticate()
        if not text.strip():
            return {"source": text, "text": "", "target": target, "network_ms": 0, "queue_ms": 0}
        if len(text.encode("utf-8")) > 5500:
            raise BaiduError("文本块过长，请缩小选区")
        queue_start = time.perf_counter()
        with self.rate_lock:
            delay = self.next_request - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self.next_request = time.monotonic() + 0.16
            self.requests += 1
        queue_ms = (time.perf_counter() - queue_start) * 1000
        started = time.perf_counter()
        data = self.request("https://aip.baidubce.com/rpc/2.0/mt/texttrans/v1", params={"access_token": self.token}, json={"from": source, "to": target, "q": text})
        elapsed = (time.perf_counter() - started) * 1000
        result = data.get("result", {})
        parts = result.get("trans_result")
        if not isinstance(parts, list) or not parts or any(not isinstance(part.get("dst"), str) for part in parts):
            raise BaiduError("百度没有返回完整译文")
        return {"source": text, "text": "\n".join(part["dst"] for part in parts), "detected_source": result.get("from"), "target": result.get("to", target), "network_ms": round(elapsed, 1), "queue_ms": round(queue_ms, 1)}
