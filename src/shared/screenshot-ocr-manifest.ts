export interface ScreenshotOcrPackageArtifact {
  source: string
  name: string
  bytes: number
  sha256: string
}

export interface ScreenshotOcrPackageManifest {
  release: string
  artifacts: readonly ScreenshotOcrPackageArtifact[]
}

export interface ScreenshotOcrDownloadArtifact {
  name: 'medium-det.tar' | 'medium-rec.tar'
  modelName: 'PP-OCRv6_medium_det' | 'PP-OCRv6_medium_rec'
  archiveDirectory: 'PP-OCRv6_medium_det_onnx_infer' | 'PP-OCRv6_medium_rec_onnx_infer'
  url: string
  bytes: number
  sha256: string
}

export const SCREENSHOT_OCR_PROTOCOL = 'arkdown-ocr'
export const SCREENSHOT_OCR_RESOURCE_URLS = Object.freeze({
  smallDetection: `${SCREENSHOT_OCR_PROTOCOL}://bundle/small-det.tar`,
  smallRecognition: `${SCREENSHOT_OCR_PROTOCOL}://bundle/small-rec.tar`,
  mediumDetection: `${SCREENSHOT_OCR_PROTOCOL}://bundle/medium-det.tar`,
  mediumRecognition: `${SCREENSHOT_OCR_PROTOCOL}://bundle/medium-rec.tar`,
  ortPrefix: `${SCREENSHOT_OCR_PROTOCOL}://bundle/ort/`,
})

export const SCREENSHOT_OCR_BUNDLED_VERSION = '6.0.0'
export const SCREENSHOT_OCR_MEDIUM_VERSION = '6.0.0'
export const SCREENSHOT_OCR_MEDIUM_ARTIFACTS = Object.freeze([
  {
    name: 'medium-det.tar',
    modelName: 'PP-OCRv6_medium_det',
    archiveDirectory: 'PP-OCRv6_medium_det_onnx_infer',
    url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_det_onnx_infer.tar',
    bytes: 62044160,
    sha256: 'c5adb0b15de1b1838934eba1dd72e7529e7d80132216c6ee6d26eba6fa054fcf',
  },
  {
    name: 'medium-rec.tar',
    modelName: 'PP-OCRv6_medium_rec',
    archiveDirectory: 'PP-OCRv6_medium_rec_onnx_infer',
    url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_rec_onnx_infer.tar',
    bytes: 76718080,
    sha256: 'd8cc46c7163c83a151aef8fce5856b965860df90a875029216d605b0f607eaec',
  },
] as const satisfies readonly ScreenshotOcrDownloadArtifact[])

/**
 * Production trust policy for installed Medium generations. Keep each still
 * supported prior release here with its original byte counts and hashes; a
 * version string alone must never make an installed generation trusted.
 */
export const SCREENSHOT_OCR_SUPPORTED_MEDIUM_MANIFESTS = Object.freeze([
  Object.freeze({
    version: SCREENSHOT_OCR_MEDIUM_VERSION,
    artifacts: SCREENSHOT_OCR_MEDIUM_ARTIFACTS,
  }),
] as const satisfies readonly {
  version: string
  artifacts: readonly ScreenshotOcrDownloadArtifact[]
}[])

export const SCREENSHOT_OCR_PACKAGE_MANIFEST = {
  release: 'PaddleOCR-3.7.0',
  artifacts: [
    {
      source: 'small-det.tar',
      name: 'small-det.tar',
      bytes: 9891840,
      sha256: 'd218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4',
    },
    {
      source: 'small-rec.tar',
      name: 'small-rec.tar',
      bytes: 21319680,
      sha256: 'd267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1',
    },
    {
      source: 'ort/ort-wasm-simd-threaded.jsep.mjs',
      name: 'ort/ort-wasm-simd-threaded.jsep.mjs',
      bytes: 46614,
      sha256: '3ee381d20a80f51a788a1c4a5872f6f1d047538dd4342f4af00062de5f9ea4c6',
    },
    {
      source: 'ort/ort-wasm-simd-threaded.jsep.wasm',
      name: 'ort/ort-wasm-simd-threaded.jsep.wasm',
      bytes: 26827543,
      sha256: '78feeeb3d08f6bcee94d938ed322f69073bb8076b5f9d34697a574ffba8deb48',
    },
    {
      source: 'opencv/opencv.js',
      name: 'opencv/opencv.js',
      bytes: 10378215,
      sha256: '19b46167b59efbef9cc3836264b0b657110833e4b1df84282004b8b3141c048d',
    },
  ],
} as const satisfies ScreenshotOcrPackageManifest

export function toPublicScreenshotOcrPackageManifest(manifest: ScreenshotOcrPackageManifest): {
  release: string
  artifacts: Array<Pick<ScreenshotOcrPackageArtifact, 'name' | 'bytes' | 'sha256'>>
} {
  return {
    release: manifest.release,
    artifacts: manifest.artifacts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  }
}
