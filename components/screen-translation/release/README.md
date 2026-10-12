# Arkdown floating translation engine 1.0.0

Windows x64 optional component for Arkdown. Arkdown downloads and installs this component when floating translation is first enabled. No separate Python installation is required.

Release files:

- `arkdown-screen-translation-engine-1.0.0-win-x64.tar.gz`: the executable, its runtime dependencies, OCR models, third-party licenses, and a complete SHA-256 file inventory.
- `manifest.json`: the six-field HTTPS download descriptor pinned by Arkdown.
- `THIRD_PARTY_NOTICES.md`: third-party attribution and source information.
- `arkdown-screen-translation-engine-1.0.0-third-party-sources.tar.gz`: GEOS source, the distributed certificate bundle in source form, and license texts. This contains third-party material only.

OCR runs locally. Online translation is used only when requested by the user and requires the configured translation provider. No credentials or user screenshots are included in these release assets.

The installer verifies the archive byte count and SHA-256, then verifies every extracted payload file against `component-manifest.json`. The SHA-256 of that inventory is also pinned in the application. Keep the complete installed directory together.

The distributed GEOS libraries are dynamically linked and replaceable. The supplied source archive includes the unmodified GEOS 3.13.1 source with CMake build files and LGPL terms. Users may modify or replace that library under its license, including debugging those modifications. Arkdown's integrity check protects its managed installation; a separately extracted component may be used for modified-library testing.
