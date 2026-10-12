"""Fetch fixed upstream release inputs; never execute downloaded programs."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request
import tarfile
import zipfile
import shutil

ROOT = Path(__file__).resolve().parents[1] / ".components" / "optional-component-inputs"
INPUTS = [
    ("pandoc-3.10.1-windows-x86_64.zip", "https://github.com/jgm/pandoc/releases/download/3.10.1/pandoc-3.10.1-windows-x86_64.zip", "4725a1883e2171c2e181e6fd45003acb59ca4e9cbe031fdd3b79ef0d697d36aa"),
    ("pandoc-3.10.1-source.tar.gz", "https://codeload.github.com/jgm/pandoc/tar.gz/refs/tags/3.10.1", "faee98f42ed1592b2feb8da7fdfa87a23b679ca27ff883e06030f89c25c91ba9"),
    ("codex-package-0.144.1-windows-x64.tar.gz", "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-package-x86_64-pc-windows-msvc.tar.gz", "ce94e1fb84693d3f7332ceeab5be73e93de38725da4b82dff863cd2c795b4730"),
    ("codex-0.144.1-source.tar.gz", "https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v0.144.1", "c11868501ef0e67c90759deaf2c0933cd07e4bea4f47a47186ee6de046c57ef6"),
    ("medium-det.tar", "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_det_onnx_infer.tar", "c5adb0b15de1b1838934eba1dd72e7529e7d80132216c6ee6d26eba6fa054fcf"),
    ("medium-rec.tar", "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_rec_onnx_infer.tar", "d8cc46c7163c83a151aef8fce5856b965860df90a875029216d605b0f607eaec"),
    ("ripgrep-15.1.0-windows.zip", "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip", "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a"),
]

def fetch(item):
    name, url, expected = item
    target = ROOT / name
    if not target.is_file():
        partial = ROOT / (name + ".download")
        with urllib.request.urlopen(url, timeout=90) as response, partial.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        partial.replace(target)
    data = target.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if expected and digest != expected:
        raise RuntimeError("Upstream input hash mismatch: " + name)
    result = {"name": name, "url": url, "bytes": len(data), "sha256": digest}
    print(json.dumps(result), flush=True)
    return result

def write(root, name, data):
    parts = name.split("/")
    if any(part in ("", ".", "..") or ":" in part or "\\" in part for part in parts):
        raise ValueError("Noncanonical archive member")
    target = root.joinpath(*parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

def stage_pandoc():
    with zipfile.ZipFile(ROOT / INPUTS[0][0]) as archive:
        root = ROOT.parent / "pandoc-3.10.1-r2" / "runtime"
        if (root / "MANUAL.html").exists():
            raise ValueError("Pandoc MANUAL.html must be omitted; use a clean runtime")
        for item in archive.infolist():
            name = item.filename.removeprefix("pandoc-3.10.1/")
            if name not in ("pandoc.exe", "COPYING.rtf", "COPYRIGHT.txt", "MANUAL.html"):
                raise ValueError("Unexpected Pandoc archive member")
            # Offline user documentation is not a runtime dependency. Keep all legal notices.
            if name == "MANUAL.html":
                continue
            write(root, name, archive.read(item))

def stage():
    repo = ROOT.parents[1]
    stage_pandoc()
    with tarfile.open(ROOT / INPUTS[2][0]) as archive:
        root = ROOT.parent / "codex-cli" / "runtime"
        for item in archive.getmembers():
            if item.isdir():
                continue
            if not item.isfile():
                raise ValueError("Unexpected Codex archive member")
            write(root, item.name, archive.extractfile(item).read())
    with tarfile.open(ROOT / INPUTS[3][0]) as archive:
        for name in ("LICENSE", "NOTICE"):
            write(ROOT.parent / "codex-cli/runtime/licenses", name, archive.extractfile("codex-rust-v0.144.1/" + name).read())
    with zipfile.ZipFile(ROOT / INPUTS[6][0]) as archive:
        prefix = "ripgrep-15.1.0-x86_64-pc-windows-msvc/"
        if archive.read(prefix + "rg.exe") != (ROOT.parent / "codex-cli/runtime/codex-path/rg.exe").read_bytes():
            raise ValueError("Codex ripgrep upstream mismatch")
        for name in ("COPYING", "LICENSE-MIT", "UNLICENSE"):
            write(ROOT.parent / "codex-cli/runtime/licenses", "ripgrep-" + name, archive.read(prefix + name))
    licenses = ROOT.parent / "ocr-base/licenses"
    for source, name in [
        ("components/screen-translation/licenses/PaddleOCR-models-LICENSE.txt", "PaddleOCR-LICENSE.txt"),
        ("node_modules/@techstark/opencv-js/LICENSE", "OpenCV-LICENSE.txt"),
        ("node_modules/js-yaml/LICENSE", "js-yaml-LICENSE.txt"),
    ]:
        write(licenses, name, (repo / source).read_bytes())
    clipper = (repo / "node_modules/clipper-lib/clipper.js").read_text(encoding="utf-8")
    write(licenses, "clipper-lib-NOTICE.txt", clipper.split("(function ()", 1)[0].encode("utf-8"))
    remote_licenses = {
        "ONNX-Runtime-LICENSE.txt": "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/LICENSE",
        "ONNX-Runtime-ThirdPartyNotices.txt": "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/ThirdPartyNotices.txt",
        "Boost-LICENSE.txt": "https://www.boost.org/LICENSE_1_0.txt",
        "JSBN-LICENSE.txt": "https://raw.githubusercontent.com/andyperlitch/jsbn/v1.1.0/LICENSE",
    }
    for name, url in remote_licenses.items():
        target = licenses / name
        if not target.is_file():
            write(licenses, name, urllib.request.urlopen(url, timeout=45).read())
    medium = ROOT.parent / "ocr-medium/runtime"
    artifacts = []
    for name, _, expected in INPUTS[4:6]:
        data = (ROOT / name).read_bytes()
        write(medium, name, data)
        artifacts.append({"name": name, "bytes": len(data), "sha256": expected})
    write(medium, "manifest.json", (json.dumps({"version": "6.0.0", "artifacts": artifacts}, indent=2) + "\n").encode())
    write(medium, "licenses/PaddleOCR-LICENSE.txt", (licenses / "PaddleOCR-LICENSE.txt").read_bytes())
    for component, source in [("pandoc", INPUTS[1][0]), ("codex-cli", INPUTS[3][0])]:
        public_name = "public-pandoc-3.10.1-r2-release" if component == "pandoc" else "public-" + component + "-release"
        public = ROOT.parent / public_name
        public.mkdir(exist_ok=True)
        shutil.copyfile(ROOT / source, public / source)

if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(fetch, INPUTS))
    (ROOT / "input-manifest.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    stage()
