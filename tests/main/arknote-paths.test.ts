import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { arknotePaths } from '../../src/main/arknote/arknote-paths'

describe('Arknote portable paths', () => {
  it('keeps settings, notes, token, and Chromium profile under portable-data/arknote', () => {
    expect(arknotePaths('C:\\Portable\\Arkdown')).toEqual({
      root: path.resolve('C:\\Portable\\Arkdown', 'portable-data', 'arknote'),
      notes: path.resolve('C:\\Portable\\Arkdown', 'portable-data', 'arknote', 'notes'),
      settings: path.resolve('C:\\Portable\\Arkdown', 'portable-data', 'arknote', 'settings.json'),
      token: path.resolve('C:\\Portable\\Arkdown', 'portable-data', 'arknote', 'service-token'),
      profile: path.resolve('C:\\Portable\\Arkdown', 'portable-data', 'arknote', 'electron-profile'),
    })
  })

  it('rejects a relative application directory', () => {
    expect(() => arknotePaths('relative/app')).toThrow('Arknote 程序目录必须是绝对路径')
  })

  it('rejects a non-normalized absolute application directory', () => {
    const directory = `${path.parse(process.cwd()).root}Portable${path.sep}child${path.sep}..`
    expect(() => arknotePaths(directory)).toThrow('规范化')
  })
})
