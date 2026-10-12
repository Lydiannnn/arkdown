import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ApplicationUpdaterTrust } from './update-helper'

interface ExecutableLease { bytes: Buffer; close(): void }
export function pinTrustedUpdateExecutable(file: string, resourcesPath: string, trust: ApplicationUpdaterTrust): ExecutableLease {
  const addonPath = path.join(resourcesPath, 'sticky-note-native-surface', process.arch, 'surface.node')
  const addon = createRequire(addonPath)(addonPath) as { pinUpdateExecutable(path: string): ExecutableLease }
  const lease = addon.pinUpdateExecutable(file)
  try {
    if (!Buffer.isBuffer(lease.bytes) || lease.bytes.length !== trust.bytes
        || createHash('sha256').update(lease.bytes).digest('hex') !== trust.sha256)
      throw new Error('更新助手校验失败，请重新下载完整发布包。')
    return lease
  } catch (error) { lease.close(); throw error }
}
