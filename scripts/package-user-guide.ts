import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const ENTRY_FILE = '使用说明书.html'
const ASSET_DIRECTORY = '使用说明书'

async function assertGuideExists(guideRoot: string): Promise<void> {
  try {
    const [entry, assets] = await Promise.all([
      stat(join(guideRoot, ENTRY_FILE)),
      stat(join(guideRoot, ASSET_DIRECTORY)),
    ])
    if (!entry.isFile() || !assets.isDirectory()) throw new Error('invalid guide output')
  } catch {
    throw new Error(`Built user guide is missing: ${guideRoot}`)
  }
}

export async function copyUserGuideToPackages(
  outputPaths: string[],
  guideRoot = resolve('user-guide', 'dist'),
): Promise<void> {
  await assertGuideExists(guideRoot)

  for (const outputPath of outputPaths) {
    const packageRoot = resolve(outputPath)
    const destinationAssets = resolve(packageRoot, ASSET_DIRECTORY)
    if (
      dirname(destinationAssets) !== packageRoot
      || basename(destinationAssets) !== ASSET_DIRECTORY
    ) {
      throw new Error(`Unsafe user-guide destination: ${destinationAssets}`)
    }

    await mkdir(packageRoot, { recursive: true })
    await rm(destinationAssets, { recursive: true, force: true })
    await cp(
      join(guideRoot, ENTRY_FILE),
      join(packageRoot, ENTRY_FILE),
      { force: true },
    )
    await cp(
      join(guideRoot, ASSET_DIRECTORY),
      destinationAssets,
      { recursive: true, force: true },
    )
  }
}
