"""Extract only pinned regular payload files from previously published components."""
import hashlib
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = [
    ("markitdown", ".components/markitdown/arkdown-markitdown-0.1.7-py3.12.10-win-x64.tar.gz", "d375e42d98cdecdce653b35f2e94a97a0844cf872da0b1fb629eff9c5bd2edec"),
    ("screen-translation-curated", ".components/public-screen-translation-release/arkdown-screen-translation-engine-1.0.0-win-x64.tar.gz", "7feff5127df97869e3752130251f58e25be6cd391b57bceeeffbc8f6196d65c7"),
]

def stage(component, relative, expected):
    archive_path = ROOT / relative
    if hashlib.sha256(archive_path.read_bytes()).hexdigest() != expected:
        raise ValueError("Archive hash mismatch: " + component)
    target = ROOT / ".components" / component / "runtime"
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        records = {}
        for item in members:
            if item.isdir():
                continue  # Empty directories are deliberately not runtime payload.
            parts = item.name.split("/")
            if not item.isfile() or any(p in ("", ".", "..") or ":" in p or "\\" in p for p in parts):
                raise ValueError("Invalid archive member")
            if item.name.casefold() in records:
                raise ValueError("Duplicate archive member")
            data = archive.extractfile(item).read()
            records[item.name.casefold()] = (item.name, data)
        tree_bytes = records["component-manifest.json"][1]
        tree = json.loads(tree_bytes)
        expected_files = {f["path"]: f for f in tree["files"]}
        if set(expected_files) != {name for name, _ in records.values()} - {"component-manifest.json"}:
            raise ValueError("Payload inventory mismatch")
        for name, data in records.values():
            if name != "component-manifest.json":
                record = expected_files[name]
                if len(data) != record["bytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
                    raise ValueError("Payload hash mismatch")
            output = target.joinpath(*name.split("/"))
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)
        print(json.dumps({"component": component, "files": len(records), "bytes": sum(len(d) for _, d in records.values()), "treeManifestSha256": hashlib.sha256(tree_bytes).hexdigest()}))

if __name__ == "__main__":
    for component in COMPONENTS:
        stage(*component)
