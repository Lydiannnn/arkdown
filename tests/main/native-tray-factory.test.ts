import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  configureNativeTrayObserver,
  observeNativeTray,
} from '../../src/main/native-tray-observer'

async function mainTypeScriptSources(): Promise<Array<{ file: string; source: string }>> {
  const root = path.join(process.cwd(), 'src', 'main')
  const sources: Array<{ file: string; source: string }> = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        sources.push({
          file: path.relative(root, absolute).split(path.sep).join('/'),
          source: await readFile(absolute, 'utf8'),
        })
      }
    }
  }
  await visit(root)
  return sources
}

it('routes every native Tray allocation through the process-observed factory', async () => {
  const sources = await mainTypeScriptSources()
  const allocations = sources.flatMap(({ file, source }) => (
    [...source.matchAll(/\bnew\s+Tray\s*\(/gu)].map(({ index }) => ({ file, index }))
  ))
  expect(allocations.map(({ file }) => file)).toEqual(['native-tray-factory.ts'])

  const arkdown = sources.find(({ file }) => file === 'arkdown-main.ts')?.source ?? ''
  const arknote = sources.find(({ file }) => file === 'arknote-main.ts')?.source ?? ''
  expect(arkdown).toContain('configureNativeTrayObserver(trayProbe)')
  expect(arknote).toContain('configureNativeTrayObserver(trayProbe)')
})


it('observes one create and one destroy for each native tray allocation', () => {
  let destroyed = false
  const tray = {
    destroy: vi.fn(() => { destroyed = true }),
    isDestroyed: vi.fn(() => destroyed),
  }
  const observer = {
    created: vi.fn(),
    destroyed: vi.fn(),
  }
  configureNativeTrayObserver(observer)

  const observed = observeNativeTray(tray)
  observed.destroy()
  observed.destroy()

  expect(observer.created).toHaveBeenCalledTimes(1)
  expect(observer.destroyed).toHaveBeenCalledTimes(1)
  expect(tray.destroy).toHaveBeenCalledTimes(1)
  configureNativeTrayObserver({ created: () => undefined, destroyed: () => undefined })
})
