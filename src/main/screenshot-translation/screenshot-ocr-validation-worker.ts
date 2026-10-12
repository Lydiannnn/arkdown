import { parentPort, workerData } from 'node:worker_threads'
import { verifyScreenshotOcrArchive } from './screenshot-ocr-archive-validation.ts'

if (!parentPort) throw new Error('OCR_MODEL_INVALID')
try {
  const bytes: Uint8Array = workerData.bytes
  // Keep the validator's original Buffer view semantics for large TAR members.
  verifyScreenshotOcrArchive(workerData.artifact, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  parentPort.postMessage({ valid: true })
} catch {
  parentPort.postMessage({ valid: false })
}
parentPort.close()
