"""Collect upstream corresponding sources and verbatim dependency notices without execution.

Cargo crates are verified against Cargo.lock checksums. Fixed upstream Git revisions
and Hackage versions are recorded with SHA-256 in the source-bundle inventory.
"""
import concurrent.futures
import gzip
import hashlib
import io
import json
import re
import tarfile
import time
import tomllib
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CACHE = REPO / ".components/optional-component-sources"
CACHE.mkdir(exist_ok=True)

def fetch(item):
    name, url, checksum = item
    output = CACHE / name
    output.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        try:
            if not output.exists():
                request = urllib.request.Request(url, headers={"User-Agent": "Arkdown-component-source-preparation"})
                with urllib.request.urlopen(request, timeout=90) as response:
                    data = response.read()
                output.write_bytes(data)
            data = output.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if checksum and digest != checksum:
                raise ValueError("Source checksum mismatch: " + name)
            return {"name": name, "url": url, "bytes": len(data), "sha256": digest}
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt)

def notice_text(file):
    result = []
    if str(file).endswith(".zip"):
        with zipfile.ZipFile(file) as archive:
            for item in archive.infolist():
                if not item.is_dir() and re.search(r"(?:^|/)(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$", item.filename, re.I) and item.file_size < 2_000_000:
                    result.append((item.filename, archive.read(item).decode("utf-8", "replace")))
    else:
        with tarfile.open(file) as archive:
            for item in archive:
                if item.isfile() and re.search(r"(?:^|/)(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$", item.name, re.I) and item.size < 2_000_000:
                    result.append((item.name, archive.extractfile(item).read().decode("utf-8", "replace")))
    return result

def bundle(component, version, inputs, main_source=None):
    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        futures = {executor.submit(fetch, item): item for item in inputs}
        for future in concurrent.futures.as_completed(futures):
            records.append(future.result())
            if len(records) % 100 == 0:
                print(component + " source downloads " + str(len(records)), flush=True)
    records.sort(key=lambda r: r["name"])
    public_name = "public-pandoc-3.10.1-r2-release" if component == "pandoc" else "public-" + component + "-release"
    output = REPO / ".components" / public_name
    output.mkdir(exist_ok=True)
    inventory = (json.dumps(records, indent=2) + "\n").encode()
    notices = []
    for record in records:
        for name, text in notice_text(CACHE / record["name"]):
            notices.append("\n===== " + record["name"] + " : " + name + " =====\n" + text)
    runtime_directory = "pandoc-3.10.1-r2" if component == "pandoc" else component
    license_path = REPO / (".components/" + runtime_directory + "/runtime/licenses/THIRD_PARTY_LICENSES.txt")
    # Base payload licenses are already frozen; the source companion supplies its extra notices.
    if component != "ocr-base":
        license_path.parent.mkdir(parents=True, exist_ok=True)
        license_path.write_text("".join(notices), encoding="utf-8")
    (output / "THIRD_PARTY_LICENSES.txt").write_text("".join(notices), encoding="utf-8")
    archive_path = output / (component + "-" + version + "-third-party-sources.tar.gz")
    with archive_path.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="", compresslevel=6) as zipped, tarfile.open(fileobj=zipped, mode="w") as archive:
        def add(name, data):
            item = tarfile.TarInfo(name); item.size = len(data); item.mode = 0o644; item.mtime = 0
            archive.addfile(item, io.BytesIO(data))
        add("source-inventory.json", inventory)
        add("THIRD_PARTY_LICENSES.txt", "".join(notices).encode())
        if main_source:
            add(main_source.name, main_source.read_bytes())
        for record in records:
            add(record["name"], (CACHE / record["name"]).read_bytes())
    print(json.dumps({"component": component, "sources": len(records), "bytes": archive_path.stat().st_size, "sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest()}), flush=True)

def codex():
    main = REPO / ".components/optional-component-inputs/codex-0.144.1-source.tar.gz"
    with tarfile.open(main) as source:
        lock = tomllib.loads(source.extractfile("codex-rust-v0.144.1/codex-rs/Cargo.lock").read().decode())
    inputs = {}
    for package in lock["package"]:
        origin = package.get("source", "")
        name, version = package["name"], package["version"]
        if origin.startswith("registry+"):
            filename = "crates/" + name + "-" + version + ".crate"
            inputs[filename] = (filename, "https://static.crates.io/crates/" + name + "/" + name + "-" + version + ".crate", package["checksum"])
        elif origin.startswith("git+https://github.com/"):
            repo, revision = origin.removeprefix("git+https://github.com/").split("#")
            repo = repo.split("?")[0].removesuffix(".git")
            filename = "git/" + repo.replace("/", "-") + "-" + revision + ".tar.gz"
            inputs[filename] = (filename, "https://codeload.github.com/" + repo + "/tar.gz/" + revision, None)
        elif origin:
            raise ValueError("Unsupported source origin")
    bundle("codex-cli", "0.144.1", list(inputs.values()), main)

def pandoc():
    binary = (REPO / ".components/pandoc-3.10.1-r2/runtime/pandoc.exe").read_bytes()
    units = set(x.decode() for x in re.findall(rb"([A-Za-z][A-Za-z0-9_-]*-[0-9][0-9._]*)-[a-f0-9]{20,}", binary))
    units = {unit for unit in units if not any(unit != other and unit.endswith(other) for other in units)}
    # GHC shortens unit IDs to 13 characters. Resolve these against the upstream
    # release's package universe; include every matching source when ambiguous.
    snapshot = urllib.request.urlopen("https://raw.githubusercontent.com/commercialhaskell/stackage-snapshots/master/lts/24/51.yaml", timeout=90).read().decode()
    names = set(re.findall(r"hackage: ([A-Za-z0-9-]+)-[0-9]", snapshot))
    names.update("hslua-module-doclayout hslua-module-path hslua-module-system hslua-module-text hslua-module-version hslua-module-zip hslua-module-math hslua-module-utf8 crypton-asn1-types crypton-asn1-encoding crypton-x509-store crypton-x509-system crypton-x509-validation skylighting-format-ansi skylighting-format-blaze-html skylighting-format-context skylighting-format-latex unicode-collation pandoc-lua-marshal hslua-objectorientation hslua-packaging network-control network-byte-order".split())
    inputs = []
    for unit in sorted(units):
        name, version = re.match(r"(.+)-([0-9].*)$", unit).groups()
        candidates = sorted(n for n in names if n.startswith(name[:-1])) if name.endswith("_") else [name]
        if not candidates:
            raise ValueError("Unknown shortened Haskell unit: " + unit)
        for name in candidates:
            # GHC also shortens the version part; preserve every published matching
            # version at this release-input review, rather than guess the suffix.
            versions = {"cryptohash-md5-0.11.10_": ["0.11.101.0", "0.11.100.1", "0.11.100.0"],
                        "yaml-0.11.11_": ["0.11.11.2", "0.11.11.1", "0.11.11.0"]}.get(unit, [version])
            for resolved_version in versions:
                value = name + "-" + resolved_version
                url = "https://hackage.haskell.org/package/" + value + "/" + value + ".tar.gz"
                inputs.append(("hackage/" + value + ".tar.gz", url, None))
    resolved = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        futures = {executor.submit(fetch, item): item for item in inputs}
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result(); resolved.append(futures[future])
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
    # Every unit must have at least one complete corresponding source archive.
    for unit in units:
        name, version = re.match(r"(.+)-([0-9].*)$", unit).groups()
        if not any(("-" + version.rstrip("_") in item[0] if version.endswith("_") else item[0].endswith("-" + version + ".tar.gz"))
                   and Path(item[0]).name.startswith(name.rstrip("_")) for item in resolved):
            raise ValueError("Unresolved Haskell source: " + unit)
    bundle("pandoc", "3.10.1", resolved, REPO / ".components/optional-component-inputs/pandoc-3.10.1-source.tar.gz")

def ocr():
    eigen = ("eigen-1d8b82b0740839c0de7f1242a3585e3390ff5f33.zip", "https://github.com/eigen-mirror/eigen/archive/1d8b82b0740839c0de7f1242a3585e3390ff5f33/eigen-1d8b82b0740839c0de7f1242a3585e3390ff5f33.zip", None)
    bundle("ocr-base", "1.0.0", [eigen])

if __name__ == "__main__":
    import sys
    {"pandoc": pandoc, "codex-cli": codex, "ocr-base": ocr}[sys.argv[1]]()
