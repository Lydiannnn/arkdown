from __future__ import annotations

import argparse
import base64
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo


FIXED_TIME = (1980, 1, 1, 0, 0, 0)
PIXEL_PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
)

ENTRIES = [
    ('mimetype', 'application/epub+zip', ZIP_STORED),
    ('META-INF/container.xml', '''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
''', ZIP_DEFLATED),
    ('OEBPS/content.opf', '''<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:arkdown-deterministic-epub</dc:identifier>
    <dc:title>Arkdown Conversion Fixture</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pixel" href="images/pixel.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="chapter1"/><itemref idref="chapter2"/></spine>
</package>
''', ZIP_DEFLATED),
    ('OEBPS/nav.xhtml', '''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Contents</title></head><body>
<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>
<li><a href="chapter1.xhtml">First Chapter</a></li><li><a href="chapter2.xhtml">Second Chapter</a></li>
</ol></nav></body></html>
''', ZIP_DEFLATED),
    ('OEBPS/chapter1.xhtml', '''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First Chapter</title></head><body>
<h1>First Chapter</h1><p>A deterministic paragraph with <em>emphasis</em> and an image.</p>
<ul><li>First item</li><li>Second item</li></ul><img src="images/pixel.png" alt="One pixel"/>
</body></html>
''', ZIP_DEFLATED),
    ('OEBPS/chapter2.xhtml', '''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second Chapter</title></head><body>
<h2>Second Chapter</h2><p>Visit <a href="https://example.com/">the example link</a>.</p>
</body></html>
''', ZIP_DEFLATED),
    ('OEBPS/images/pixel.png', PIXEL_PNG, ZIP_DEFLATED),
]


def write_entry(book: ZipFile, name: str, content: str | bytes, compression: int) -> None:
    info = ZipInfo(name, FIXED_TIME)
    info.compress_type = compression
    info.create_system = 0
    info.external_attr = 0
    payload = content.encode('utf-8') if isinstance(content, str) else content
    book.writestr(info, payload, compress_type=compression, compresslevel=9)


def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    output: Path = args.output.resolve(strict=False)
    if output.suffix.lower() != '.epub' or output.exists() or not output.parent.is_dir():
        return 2
    with ZipFile(output, mode='x') as book:
        for name, content, compression in ENTRIES:
            write_entry(book, name, content, compression)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
