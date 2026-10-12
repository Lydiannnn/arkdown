"""Build a complete portable worker; never modify the source environment."""
import argparse
import os
from pathlib import Path
import shutil

MODELS = ("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", "--modelDir", required=True, type=Path)
    parser.add_argument("--output-dir", "--outputDir", required=True, type=Path)
    parser.add_argument("--licenses-dir", type=Path, default=Path(__file__).resolve().parents[1] / "licenses")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    models = args.model_dir.resolve()
    output = args.output_dir.resolve()
    for name in MODELS:
        if not (models / name).is_file():
            raise FileNotFoundError(name)
    if not args.licenses_dir.is_dir():
        raise FileNotFoundError("Missing release licenses")
    os.environ["PYINSTALLER_CONFIG_DIR"] = str(root / "build/cache")
    import PyInstaller.__main__
    options = [str(root / "engine/worker.py"), "--noconfirm", "--onedir", "--console",
               "--name", "ArkTranslateEngine", "--distpath", str(output),
               "--workpath", str(root / "build/work"), "--specpath", str(root / "build"),
               "--collect-all", "rapidocr", "--collect-all", "onnxruntime", "--collect-data", "omegaconf"]
    for module in ("matplotlib", "torch", "paddle", "IPython", "pytest"):
        options += ["--exclude-module", module]
    for name in MODELS:
        options += ["--add-data", str(models / name) + ";models"]
    PyInstaller.__main__.run(options)
    shutil.copytree(args.licenses_dir, output / "ArkTranslateEngine/licenses", dirs_exist_ok=True)


if __name__ == "__main__":
    main()
