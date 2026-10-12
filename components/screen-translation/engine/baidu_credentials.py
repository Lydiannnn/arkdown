"""Windows DPAPI storage for the current user's Baidu translation credentials."""
import base64
import ctypes
from ctypes import wintypes
import json
import os
import tempfile
from pathlib import Path

ENTROPY = b"ArkTranslate.BaiduCredentials.v1"



class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.c_void_p)]


def crypt(value, decrypt=False):
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    source_buffer = ctypes.create_string_buffer(value)
    entropy_buffer = ctypes.create_string_buffer(ENTROPY)
    source = Blob(len(value), ctypes.cast(source_buffer, ctypes.c_void_p))
    entropy = Blob(len(ENTROPY), ctypes.cast(entropy_buffer, ctypes.c_void_p))
    output = Blob()
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if not function(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 1, ctypes.byref(output)):
        raise OSError("Windows could not access the current user's encrypted credentials")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel32.LocalFree(output.data)


ENV_PATH = "ARKDOWN_SCREEN_TRANSLATION_CREDENTIALS_FILE"


def credential_path(path=None):
    value = path if path is not None else os.environ.get(ENV_PATH)
    if value is None or not str(value).strip():
        raise FileNotFoundError("No explicit host credential path configured")
    result = Path(value)
    if not result.is_absolute():
        raise ValueError("Credential path must be absolute")
    return result


def validate_fields(document):
    if not isinstance(document, dict):
        raise ValueError("Invalid credential fields")
    for name in ("api_key", "secret_key"):
        value = document.get(name)
        if not isinstance(value, str) or not value.strip() or len(value) > 4096:
            raise ValueError("Invalid credential fields")
    return document


def save(api_key, secret_key, path=None):
    path = credential_path(path)
    fields = validate_fields({"api_key": api_key, "secret_key": secret_key})
    payload = json.dumps(fields, separators=(",", ":")).encode("utf-8")
    encrypted = crypt(payload)
    if crypt(encrypted, decrypt=True) != payload:
        raise OSError("Encrypted credential verification failed")
    document = json.dumps({"version": 1, "protected": base64.b64encode(encrypted).decode("ascii")})
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(document)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load(path=None):
    path = credential_path(path)
    if path.stat().st_size > 65536:
        raise ValueError("Invalid credential document")
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    if document.get("version") != 1:
        raise ValueError("Invalid credential version")
    payload = crypt(base64.b64decode(document["protected"], validate=True), decrypt=True)
    return validate_fields(json.loads(payload.decode("utf-8-sig")))


def status():
    try:
        load()
        return True
    except Exception:
        return False
