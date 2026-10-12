import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SCREENSHOT_OCR_PACKAGE_MANIFEST } from '../../src/shared/screenshot-ocr-manifest'

describe('build dependency contract', () => {
  it('pins MIT-licensed ExcelJS for main-process XLSX export only', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string; license?: string }>
    }
    const installed = JSON.parse(await readFile('node_modules/exceljs/package.json', 'utf8')) as {
      version?: string
      license?: string
    }

    expect(packageJson.dependencies?.exceljs).toBe('4.4.0')
    expect(packageLock.packages['node_modules/exceljs']).toMatchObject({
      version: '4.4.0',
      license: 'MIT',
    })
    expect(installed).toMatchObject({ version: '4.4.0', license: 'MIT' })
    const exporter = await readFile('src/main/xlsx/xlsx-export-service.ts', 'utf8')
    expect(exporter).toContain("import('exceljs')")
    expect(exporter).not.toContain("from 'exceljs'")
    for (const file of ['src/preload/arkdown-api.ts', 'src/renderer/app/App.tsx']) {
      expect(await readFile(file, 'utf8')).not.toContain("'exceljs'")
    }
  })

  it('declares the React Vite plugin imported by the renderer and tests', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      devDependencies?: Record<string, string>
    }

    expect(packageJson.devDependencies?.['@vitejs/plugin-react']).toBe('6.0.4')
  })

  it('pins the official PaddleOCR.js SDK required by packaged screenshot OCR', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(packageJson.dependencies?.['@paddleocr/paddleocr-js']).toBe('0.4.2')
    const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string; integrity?: string }>
    }
    expect(packageLock.packages['node_modules/@paddleocr/paddleocr-js']).toMatchObject({
      version: '0.4.2',
      integrity: 'sha512-vpwSaFVKcpTaRaNXIXL7R76lyvGjqQ8K17d7L/gsugQZYkNfwMR+yesAkLwzZtXmQVdMhVGtQmqBAQNkjvQ3EQ==',
    })
  })

  it('packages the exact JSEP module and WASM selected by the locked ORT browser bundle', async () => {
    const packageLock = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string }>
    }
    expect(packageLock.packages['node_modules/onnxruntime-web']?.version).toBe('1.27.0')
    const packageJson = JSON.parse(await readFile('node_modules/onnxruntime-web/package.json', 'utf8')) as {
      exports: { '.': { import: { default: string } } }
    }
    expect(packageJson.exports['.'].import.default).toBe('./dist/ort.bundle.min.mjs')
    const browserBundle = await readFile('node_modules/onnxruntime-web/dist/ort.bundle.min.mjs', 'utf8')
    expect(browserBundle).toContain('ort-wasm-simd-threaded.jsep.mjs')
    expect(browserBundle).toContain('ort-wasm-simd-threaded.jsep.wasm')

    const expected = [
      ['ort/ort-wasm-simd-threaded.jsep.mjs', 46614, '3ee381d20a80f51a788a1c4a5872f6f1d047538dd4342f4af00062de5f9ea4c6'],
      ['ort/ort-wasm-simd-threaded.jsep.wasm', 26827543, '78feeeb3d08f6bcee94d938ed322f69073bb8076b5f9d34697a574ffba8deb48'],
    ] as const
    const actual = SCREENSHOT_OCR_PACKAGE_MANIFEST.artifacts
      .filter(({ name }) => name.startsWith('ort/'))
      .map(({ name, bytes, sha256 }) => [name, bytes, sha256])
    expect(actual).toEqual(expected)
    for (const [name, bytes, sha256] of expected) {
      const installed = await readFile(`node_modules/onnxruntime-web/dist/${name.slice('ort/'.length)}`)
      expect(installed.byteLength).toBe(bytes)
      expect(createHash('sha256').update(installed).digest('hex')).toBe(sha256)
    }
  })
})
