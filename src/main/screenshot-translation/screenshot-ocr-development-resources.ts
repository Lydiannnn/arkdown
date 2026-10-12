import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const DEVELOPMENT_RESOURCES_NAMESPACE = 'arkdown-screenshot-ocr-development-v1'

export function screenshotOcrDevelopmentResourcesPath(
  developmentRoot: string,
  temporaryRoot = os.tmpdir(),
): string {
  const resolvedDevelopmentRoot = path.resolve(developmentRoot)
  const canonicalIdentity = process.platform === 'win32'
    ? resolvedDevelopmentRoot.toLocaleLowerCase('en-US')
    : resolvedDevelopmentRoot
  const sourceIdentity = createHash('sha256')
    .update(canonicalIdentity, 'utf8')
    .digest('hex')
  return path.join(temporaryRoot, DEVELOPMENT_RESOURCES_NAMESPACE, sourceIdentity, 'resources')
}
