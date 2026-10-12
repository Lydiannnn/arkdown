"""Write human-readable public component notices; never include product source or user state."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / ".components"

def write(component, description, license_text, source_text):
    runtime_directory = "pandoc-3.10.1-r2" if component == "pandoc" else component
    directory = ROOT / ("public-" + runtime_directory + "-release")
    directory.mkdir(exist_ok=True)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    tree = (ROOT / runtime_directory / "runtime/component-manifest.json").read_bytes()
    (directory / "README.md").write_text("# " + description + "\n\n"
        + "Windows x64 optional component for Arkdown Full and Lite. The runtime archive has no enclosing directory. "
        + "Its exact byte size and SHA-256 are recorded in manifest.json. Arkdown also pins the raw component-manifest.json "
        + "SHA-256 at compile time and verifies every regular payload file before use.\n\n"
        + "Version: " + manifest["version"] + "\n\nRaw tree manifest SHA-256: `" + hashlib.sha256(tree).hexdigest() + "`\n\n"
        + license_text + "\n\n" + source_text + "\n\n"
        + "This release contains no Arkdown application source, credentials, user documents, authentication tokens, or user settings. "
        + "Third-party components are provided under their included licenses, without warranty.\n", encoding="utf-8")

if __name__ == "__main__":
    import sys
    component = sys.argv[1]
    if component == "ocr-base":
        write(component, "OCR base 1.0.0", "Includes PaddleOCR JS 0.4.2 and Small models (Apache-2.0), ONNX Runtime Web 1.27.0 "
            "(MIT with bundled third-party notices), OpenCV.js (Apache-2.0), js-yaml (MIT), and Clipper (Boost-1.0 plus JSBN notice). "
            "All runtime licenses are under licenses/. The worker is the redistributable OCR adapter bundle; product UI and application source are absent.",
            "The attached ocr-base-1.0.0-third-party-sources.tar.gz contains the actual Eigen source archive at commit "
            "1d8b82b0740839c0de7f1242a3585e3390ff5f33, as pinned by ONNX Runtime v1.27.0 cmake/deps.txt. "
            "Eigen's MPL-2.0 terms and other source notices are included. Source-inventory.json records its upstream URL, bytes and SHA-256.")
    elif component == "ocr-medium":
        text = (ROOT / "ocr-medium/runtime/licenses/PaddleOCR-LICENSE.txt").read_text(encoding="utf-8")
        (ROOT / "public-ocr-medium-release/THIRD_PARTY_LICENSES.txt").write_text(text, encoding="utf-8")
        write(component, "PaddleOCR Medium models 6.0.0", "Contains the official PP-OCRv6 Medium detection and recognition model tar files, "
            "byte-for-byte unchanged, under Apache-2.0. The complete license is included under licenses/ and attached separately.",
            "The two model archives contain the model data and inference configuration. Their original filenames are "
            "PP-OCRv6_medium_det_onnx_infer.tar and PP-OCRv6_medium_rec_onnx_infer.tar, from "
            "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/. "
            "No additional copyleft source component is introduced by these model data archives.")
    elif component == "codex-cli":
        files = [ROOT / "codex-cli/runtime/licenses" / name for name in ["THIRD_PARTY_LICENSES.txt", "ripgrep-COPYING", "ripgrep-LICENSE-MIT", "ripgrep-UNLICENSE"]]
        (ROOT / "public-codex-cli-release/THIRD_PARTY_LICENSES.txt").write_bytes(b"\n\n".join(file.read_bytes() for file in files))
        write(component, "Codex CLI 0.144.1", "Includes the complete unmodified official Windows x64 package from OpenAI's "
            "rust-v0.144.1 release. The executables and relative directories are preserved, including command runner, Windows sandbox setup, "
            "code mode host and ripgrep. CLI authentication is performed separately on the user's computer. "
            "OpenAI LICENSE/NOTICE and collected dependency licenses are included under licenses/.",
            "The attached codex-cli-0.144.1-third-party-sources.tar.gz includes the actual upstream Codex source, all 1,200 external "
            "Cargo.lock source archives (including fixed Git revisions and MPL-2.0 nucleo), and full collected notices. Registry crates "
            "are verified against Cargo.lock checksums. source-inventory.json records URL, byte count and SHA-256 for every archive. "
            "The upstream source retains Cargo.lock, Rust toolchain selection and release/build scripts.")
    elif component == "pandoc":
        write(component, "Pandoc 3.10.1 (packaging revision 3.10.1-r2)", "Includes the unmodified official Windows x64 pandoc.exe, COPYRIGHT.txt and COPYING.rtf. "
            "The offline MANUAL.html is omitted in this packaging revision; the executable and legal notices are unchanged. "
            "Pandoc is GPL-2.0-or-later; included dependencies retain their individual licenses. Collected dependency licenses are under licenses/.",
            "The attached pandoc-3.10.1-third-party-sources.tar.gz contains the actual Pandoc 3.10.1 source repository including "
            "Cabal projects, release workflow and Windows build scripts, plus the Hackage source archives for linked package versions "
            "identified from the official executable's GHC unit IDs. For shortened GHC IDs all matching published package versions are "
            "included. source-inventory.json records the exact upstream URL, bytes and SHA-256 of each source archive. "
            "Build the upstream source with its Windows release workflow: GHC 9.10 and Cabal 3.14, cabal build "
            "-fembed_data_files -fserver -flua pandoc-cli. No Arkdown modifications were made to the executable.")
