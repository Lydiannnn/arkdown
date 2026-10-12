// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { SCREENSHOT_OCR_MEDIUM_ARTIFACTS } from '../../src/shared/screenshot-ocr-manifest'
import { verifyScreenshotOcrArchiveInWorker } from '../../src/main/screenshot-translation/screenshot-ocr-validation'

let workerRoot: string
let workerFile: string
beforeAll(async () => {
  workerRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-ocr-worker-'))
  workerFile = path.join(workerRoot, 'screenshot-ocr-validation-worker.cjs')
  await build({ configFile: false, logLevel: 'silent', build: {
    outDir: workerRoot, emptyOutDir: false,
    lib: { entry: path.resolve('src/main/screenshot-translation/screenshot-ocr-validation-worker.ts'),
      formats: ['cjs'], fileName: () => 'screenshot-ocr-validation-worker.cjs' },
    rollupOptions: { external: ['node:worker_threads', 'node:crypto'] },
  } })
})
afterAll(async () => { if (workerRoot) await rm(workerRoot, { recursive: true, force: true }) })

function archive(configuration = 'Global:\n  model_name: PP-OCRv6_medium_det\n'): Uint8Array {
  const directory = 'PP-OCRv6_medium_det_onnx_infer'
  const entries: Array<[string, string, string]> = [
    [`${directory}/`, '', '5'], [`${directory}/inference.onnx`, 'model', '0'],
    [`${directory}/inference.yml`, configuration, '0'],
  ]
  const blocks: Buffer[] = []
  for (const [name, content, type] of entries) {
    const header = Buffer.alloc(512)
    const body = Buffer.from(content)
    header.write(name)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write(type, 156)
    header.write('ustar ', 257)
    header[263] = 0x20
    header.fill(0x20, 148, 156)
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return new Uint8Array(Buffer.concat(blocks))
}

function artifact(bytes: Uint8Array) {
  return { ...SCREENSHOT_OCR_MEDIUM_ARTIFACTS[0], bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') }
}

describe('OCR archive worker validation', () => {
  it('validates the exact bytes in a worker and returns them without corrupting the caller buffer', async () => {
    const bytes = archive()
    const result = await verifyScreenshotOcrArchiveInWorker(artifact(bytes), bytes, workerFile)
    expect(result).toEqual(bytes)
    expect(bytes.byteLength).toBeGreaterThan(1024)
  })

  it('rejects same-size corruption even when the file length still matches', async () => {
    const bytes = archive()
    const pinned = artifact(bytes)
    bytes[1024] ^= 1
    await expect(verifyScreenshotOcrArchiveInWorker(pinned, bytes, workerFile)).rejects.toThrow('OCR_MODEL_INVALID')
  })

  it.each(['checksum', 'terminator', 'traversal', 'model-name'])('rejects a trusted hash with invalid %s content', async defect => {
    const bytes = archive(defect === 'model-name' ? 'Global:\n  model_name: unrelated\n' : undefined)
    if (defect === 'checksum') bytes[148] = 0
    if (defect === 'terminator') bytes[bytes.length - 1] = 1
    if (defect === 'traversal') {
      bytes[0] = '.'.charCodeAt(0)
      bytes[1] = '.'.charCodeAt(0)
      bytes[2] = '/'.charCodeAt(0)
      bytes.fill(0x20, 148, 156)
      const checksum = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
      bytes.set(Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 '), 148)
    }
    await expect(verifyScreenshotOcrArchiveInWorker(artifact(bytes), bytes, workerFile)).rejects.toThrow('OCR_MODEL_INVALID')
  })

  it('fails closed if the worker cannot start', async () => {
    const bytes = archive()
    await expect(verifyScreenshotOcrArchiveInWorker(artifact(bytes), bytes, `${workerFile}.missing`)).rejects.toThrow()
  })
})
