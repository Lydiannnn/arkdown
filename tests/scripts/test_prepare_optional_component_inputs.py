"""Verify Pandoc staging against a synthetic upstream ZIP, without network access."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location(
    "component_inputs", Path(__file__).resolve().parents[2] / "scripts/prepare-optional-component-inputs.py"
)
PREPARER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARER)


class StopAfterPandoc(Exception):
    pass


class PandocStagingTest(unittest.TestCase):
    def test_upstream_manual_is_not_staged_but_program_and_notices_are_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="arkdown-pandoc-staging-") as folder:
            components = Path(folder) / ".components"
            inputs = components / "optional-component-inputs"
            inputs.mkdir(parents=True)
            payload = {"pandoc.exe": b"synthetic converter", "COPYING.rtf": b"synthetic license",
                       "COPYRIGHT.txt": b"synthetic copyright", "MANUAL.html": b"synthetic manual"}
            with zipfile.ZipFile(inputs / PREPARER.INPUTS[0][0], "w") as archive:
                for name, data in payload.items():
                    archive.writestr("pandoc-3.10.1/" + name, data)
            # Stop before unrelated Codex/OCR staging; Pandoc uses the real ZIP and filesystem.
            with patch.object(PREPARER, "ROOT", inputs), patch.object(
                PREPARER.tarfile, "open", side_effect=StopAfterPandoc
            ):
                with self.assertRaises(StopAfterPandoc):
                    PREPARER.stage()
            self.assertEqual(list(components.rglob("MANUAL.html")), [])
            programs = list(components.glob("*/runtime/pandoc.exe"))
            self.assertEqual(len(programs), 1)
            runtime = programs[0].parent
            for name in ("pandoc.exe", "COPYING.rtf", "COPYRIGHT.txt"):
                self.assertEqual((runtime / name).read_bytes(), payload[name])


if __name__ == "__main__":
    unittest.main()
