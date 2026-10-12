import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUIDE_PAGES } from '../../user-guide/content'

const REQUIRED_SCREENSHOTS = [
  { file: 'app-start.png', minWidth: 900, minHeight: 500 },
  { file: 'app-workspace.png', minWidth: 900, minHeight: 500 },
  { file: 'file-tree.png', minWidth: 180, minHeight: 420 },
  { file: 'visual-mode.png', minWidth: 900, minHeight: 500 },
  { file: 'source-mode.png', minWidth: 900, minHeight: 500 },
  { file: 'save-states.png', minWidth: 900, minHeight: 500 },
  { file: 'save-conflict.png', minWidth: 900, minHeight: 500 },
  { file: 'portable-folder.png', minWidth: 700, minHeight: 400 },
  { file: 'sticky-note-box.png', minWidth: 900, minHeight: 500 },
] as const

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error('not a PNG file')
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

describe('real user-guide screenshots', () => {
  it.each(REQUIRED_SCREENSHOTS)('$file is a valid, readable PNG', async ({
    file,
    minWidth,
    minHeight,
  }) => {
    const path = join('user-guide', 'assets', 'images', file)
    await expect(stat(path)).resolves.toMatchObject({ isFile: expect.any(Function) })
    const dimensions = pngDimensions(await readFile(path))
    expect(dimensions.width).toBeGreaterThanOrEqual(minWidth)
    expect(dimensions.height).toBeGreaterThanOrEqual(minHeight)
  })

  it.each(REQUIRED_SCREENSHOTS)('$file is referenced with alt text and a caption', ({ file }) => {
    const copy = GUIDE_PAGES.flatMap((page) => page.sections)
      .map((section) => section.body)
      .join('\n')
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    expect(copy).toMatch(new RegExp(`data-image-src="[^"]*${escaped}"`))
    expect(copy).toMatch(new RegExp(`data-image-alt="[^"]+"[^>]*${escaped}|${escaped}"[^>]*data-image-alt="[^"]+"`))
    expect(copy).toMatch(new RegExp(`data-image-caption="[^"]+"[^>]*${escaped}|${escaped}"[^>]*data-image-caption="[^"]+"`))
  })
})
