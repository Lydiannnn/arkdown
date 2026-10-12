import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildWindowOptions } from '../../src/main/create-main-window'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { restoreWindowBounds } from '../../src/main/settings/window-bounds'

const roots: string[] = []
const workAreas = [{ x: 0, y: 0, width: 1920, height: 1040 }]

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

it('rejects fractional and unsafe persisted dimensions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)

  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ windowBounds: { width: 900.5, height: 700 } }), 'utf8')
  await expect(new SettingsStore(root).load()).resolves.toMatchObject({ windowBounds: undefined })

  await writeFile(
    path.join(root, 'settings.json'),
    JSON.stringify({ windowBounds: { width: Number.MAX_SAFE_INTEGER + 1, height: 700 } }),
    'utf8',
  )
  await expect(new SettingsStore(root).load()).resolves.toMatchObject({ windowBounds: undefined })
})

it('retains safe dimensions but drops both coordinates when either coordinate is invalid', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'settings.json'),
    JSON.stringify({ windowBounds: { width: 900, height: 700, x: 20.5, y: 50 } }),
    'utf8',
  )

  await expect(new SettingsStore(root).load()).resolves.toMatchObject({
    windowBounds: { width: 900, height: 700 },
  })
  expect(restoreWindowBounds({ width: 900, height: 700, x: 20, y: 50.5 }, workAreas)).toEqual({
    width: 900,
    height: 700,
  })
})

it('defensively rejects non-integer dimensions and preserves secure defaults', () => {
  const unsafe = {
    width: 900.5,
    height: 700,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: true },
  }
  const options = buildWindowOptions('C:\\app\\preload.js', unsafe as never)

  expect(options).toMatchObject({ width: 1800, height: 1080 })
  expect(options.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  })
})

it('defensively drops coordinates when one supplied coordinate is not a safe integer', () => {
  const options = buildWindowOptions('C:\\app\\preload.js', {
    width: 900,
    height: 700,
    x: 20,
    y: 50.5,
  })

  expect(options).toMatchObject({ width: 900, height: 700 })
  expect(options).not.toHaveProperty('x')
  expect(options).not.toHaveProperty('y')
})
