# Third-party notices — Arkdown floating translation engine 1.0.0

This component contains third-party software and OCR model files. The full applicable notices are retained in `licenses/` and the dependency license files under `_internal/` inside the binary archive. Third-party rights and licenses are unchanged.

Major components include Python 3.12.14 (PSF license), RapidOCR 3.9.2 and PaddleOCR models (Apache-2.0), ONNX Runtime 1.29.0 (MIT), NumPy 2.5.3 (BSD and bundled notices), OpenCV Python 5.0.0.93 (Apache-2.0 and bundled notices), Pillow 12.3.0 (HPND and bundled notices), Shapely 2.1.2 (BSD-3-Clause), GEOS 3.13.1 (LGPL-2.1), and certifi 2026.7.22's CA certificate bundle (MPL-2.0). Other runtime notices, including Requests, urllib3, PyYAML, OmegaConf, pyclipper, psutil, and the PyInstaller bootloader exception, remain in the supplied license files.

The optional OpenCV FFmpeg video I/O plugin is omitted from this image OCR component. The upstream OpenCV notice files are preserved in full, including notices for its optional video dependencies.

The separate third-party source archive includes:

- `geos-3.13.1.tar.bz2`, the unmodified release source with build scripts, obtained from https://download.osgeo.org/geos/geos-3.13.1.tar.bz2. SHA-256: `df2c50503295f325e7c8d7b783aca8ba4773919cde984193850cf9e361dfd28c`.
- The exact `cacert.pem` distributed with this component, in its preferred human-readable PEM source form, together with its notice.
- License texts copied from the verified runtime, including GEOS LGPL terms.

GEOS build instructions are contained in the source and available at https://libgeos.org/usage/download/. Its library version was checked against the distributed GEOS C API. The GEOS DLLs are unmodified upstream Shapely wheel dependencies; their filename suffixes are wheel loader identifiers.

No Arkdown application source, user settings, credentials, screenshots, or private paths are part of the third-party source archive.
