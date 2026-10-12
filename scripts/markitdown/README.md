# MarkItDown component verification

Run the opt-in Windows x64 release verification with a prewarmed artifact cache:

```text
npm run verify:markitdown
```

The command is offline by default. It reads only artifacts already present and verified in `.components/cache`; a missing or corrupt cache entry fails closed without a network request. On the first run, when the locked cache is not yet populated, explicitly allow the pinned downloads:

```text
npm run verify:markitdown -- --allow-download
```

Every outbound request and redirect hop remains restricted to the component allowlist, and the downloaded bytes must match the lock. The verifier performs two isolated full builds against logically equivalent LF and CRLF component sources, compares archive byte count and SHA-256, safely reopens the final archive, reconciles both manifests and the installed distribution/license inventory, and runs PDF/PPTX/XLSX/EPUB conversions with the extracted embedded runtime.

Each invocation writes a new success or failure report under `.components/verification/reports/`; previous reports are not overwritten. This command is deliberately separate from the fast `npm test` suite.
