import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ScreenshotOcrDownloadArtifact } from '../../shared/screenshot-ocr-manifest'

/** An unavailable validator says nothing about whether on-disk archives are corrupt. */
export class ScreenshotOcrValidationUnavailableError extends Error {
  constructor() { super('OCR_MODEL_VALIDATION_UNAVAILABLE') }
}

/** The caller retains its exact bytes; the worker validates a dedicated transferred copy. */
export async function verifyScreenshotOcrArchiveInWorker(
  artifact: ScreenshotOcrDownloadArtifact,
  bytes: Uint8Array,
  workerFile = path.join(__dirname, 'screenshot-ocr-validation-worker.js'),
): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes)
  let worker: Worker
  try {
    worker = new Worker(workerFile, {
      workerData: { artifact, bytes: copy }, transferList: [copy.buffer],
    })
  } catch { throw new ScreenshotOcrValidationUnavailableError() }
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (message: unknown) => {
        if (typeof message === 'object' && message !== null && 'valid' in message && message.valid === true) resolve()
        else reject(new Error('OCR_MODEL_INVALID'))
      })
      worker.once('error', () => reject(new ScreenshotOcrValidationUnavailableError()))
      worker.once('exit', () => reject(new ScreenshotOcrValidationUnavailableError()))
    })
    return bytes
  } finally {
    await worker.terminate()
  }
}
