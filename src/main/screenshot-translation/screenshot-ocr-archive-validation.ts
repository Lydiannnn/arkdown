import { createHash } from 'node:crypto'
import type { ScreenshotOcrDownloadArtifact } from '../../shared/screenshot-ocr-manifest.ts'

function tarMembers(bytes: Uint8Array): Array<{ name: string; contents: Uint8Array }> {
  const members: Array<{ name: string; contents: Uint8Array }> = []
  let offset = 0
  let terminated = false
  while (offset < bytes.byteLength) {
    if (offset + 512 > bytes.byteLength) throw new Error('OCR_MODEL_INVALID')
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) {
      const second = bytes.subarray(offset + 512, offset + 1024)
      if (second.byteLength !== 512 || !second.every((value) => value === 0)
        || !bytes.subarray(offset + 1024).every((value) => value === 0)) throw new Error('OCR_MODEL_INVALID')
      terminated = true
      break
    }
    const magic = header.subarray(257, 263)
    const version = header.subarray(263, 265)
    if (!magic.every((value, index) => value === [0x75, 0x73, 0x74, 0x61, 0x72, 0x20][index])
      || version[0] !== 0x20 || version[1] !== 0x00) throw new Error('OCR_MODEL_INVALID')
    const checksumText = Buffer.from(header.subarray(148, 156)).toString('ascii')
    if (!/^[0-7]{6}\0 $/u.test(checksumText)) throw new Error('OCR_MODEL_INVALID')
    const storedChecksum = Number.parseInt(checksumText.slice(0, 6), 8)
    const computedChecksum = header.reduce((sum, value, index) => (
      sum + (index >= 148 && index < 156 ? 0x20 : value)
    ), 0)
    if (storedChecksum !== computedChecksum) throw new Error('OCR_MODEL_INVALID')
    const field = (start: number, length: number) => Buffer.from(header.subarray(start, start + length))
      .toString('utf8').replace(/\0+$/u, '')
    const name = field(0, 100)
    const prefix = field(345, 155)
    const sizeText = field(124, 12).trim()
    const type = field(156, 1) || '0'
    const link = field(157, 100)
    const fullName = prefix ? `${prefix}/${name}` : name
    if (!name || !/^[0-7]*$/u.test(sizeText) || !['0', '5'].includes(type) || link
      || fullName.startsWith('/') || fullName.includes('\\')
      || fullName.split('/').some((segment, index, all) => (
        (index === all.length - 1 && segment === '') ? false : !segment || segment === '.' || segment === '..'
      ))) throw new Error('OCR_MODEL_INVALID')
    const size = Number.parseInt(sizeText || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0 || (type === '5') !== fullName.endsWith('/')) throw new Error('OCR_MODEL_INVALID')
    const padded = Math.ceil(size / 512) * 512
    if (offset + 512 + padded > bytes.byteLength) throw new Error('OCR_MODEL_INVALID')
    members.push({ name: fullName, contents: bytes.slice(offset + 512, offset + 512 + size) })
    offset += 512 + padded
  }
  if (!terminated) throw new Error('OCR_MODEL_INVALID')
  return members
}

export function verifyScreenshotOcrArchive(artifact: ScreenshotOcrDownloadArtifact, bytes: Uint8Array): void {
  if (bytes.byteLength !== artifact.bytes
    || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('OCR_MODEL_INVALID')
  const expected = [
    `${artifact.archiveDirectory}/`,
    `${artifact.archiveDirectory}/inference.onnx`,
    `${artifact.archiveDirectory}/inference.yml`,
  ]
  const actual = tarMembers(bytes)
  if (actual.length !== expected.length || actual.some((member, index) => member.name !== expected[index])) {
    throw new Error('OCR_MODEL_INVALID')
  }
  let configuration: string
  try { configuration = new TextDecoder('utf-8', { fatal: true }).decode(actual[2]!.contents) } catch { throw new Error('OCR_MODEL_INVALID') }
  const modelNames = [...configuration.matchAll(/^\s*model_name:\s*([^#\r\n]+?)\s*$/gmu)].map((match) => match[1])
  if (modelNames.length !== 1 || modelNames[0] !== artifact.modelName) throw new Error('OCR_MODEL_INVALID')
}

