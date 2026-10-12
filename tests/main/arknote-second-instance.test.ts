import { describe, expect, it, vi } from 'vitest'
import {
  acquireArknoteSingleInstance,
  arknoteSingleInstanceData,
  parseArknoteLaunchCommand,
  parseArknoteSingleInstanceData,
} from '../../src/main/arknote/arknote-second-instance'

describe('Arknote second instance commands', () => {
  it.each([
    [['Arknote.exe', '--new-note'], 'new-note'],
    [['Arknote.exe', '--open-box'], 'open-box'],
    [['Arknote.exe', '--open-settings'], 'open-settings'],
    [['Arknote.exe'], 'open-box'],
    [['Arknote.exe', '--unknown', 'C:\\secret.txt'], 'open-box'],
  ] as const)('maps %j to the only allowed launch command %s', (argv, expected) => {
    expect(parseArknoteLaunchCommand(argv)).toBe(expected)
  })

  it('serializes only the parsed whitelist command into Electron additional data', () => {
    expect(arknoteSingleInstanceData(['Arknote.exe', '--new-note', 'C:\\secret.txt']))
      .toEqual({ arknoteCommand: 'new-note' })
  })

  it('serializes Arkdown internal startup as ensure-service without changing public fallback', () => {
    expect(arknoteSingleInstanceData(['Arknote.exe', '--arkdown-autostart']))
      .toEqual({ arknoteCommand: 'ensure-service' })
    expect(parseArknoteLaunchCommand(['Arknote.exe'])).toBe('open-box')
  })

  it('rejects malformed or extended second-instance data', () => {
    expect(parseArknoteSingleInstanceData({ arknoteCommand: 'open-box' })).toBe('open-box')
    expect(parseArknoteSingleInstanceData({ arknoteCommand: 'quit' })).toBeUndefined()
    expect(parseArknoteSingleInstanceData({ arknoteCommand: 'open-box', path: 'C:\\secret.txt' }))
      .toBeUndefined()
  })

  it('registers the primary instance and forwards only validated second-instance data', () => {
    let secondInstance:
      | ((event: unknown, argv: string[], cwd: string, data: unknown) => void)
      | undefined
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((event: string, listener: typeof secondInstance) => {
        if (event === 'second-instance') secondInstance = listener
      }),
      quit: vi.fn(),
    }
    const onCommand = vi.fn()

    expect(acquireArknoteSingleInstance(
      app,
      ['Arknote.exe', '--open-box'],
      onCommand,
    )).toBe(true)
    secondInstance?.({}, [], '', { arknoteCommand: 'new-note' })
    secondInstance?.({}, [], '', { arknoteCommand: 'ensure-service' })
    secondInstance?.({}, [], '', { arknoteCommand: 'quit' })

    expect(app.requestSingleInstanceLock).toHaveBeenCalledWith({
      arknoteCommand: 'open-box',
    })
    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith('new-note')
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('quits a secondary instance without registering listeners', () => {
    const app = {
      requestSingleInstanceLock: vi.fn(() => false),
      on: vi.fn(),
      quit: vi.fn(),
    }

    expect(acquireArknoteSingleInstance(
      app,
      ['Arknote.exe', '--new-note'],
      vi.fn(),
    )).toBe(false)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.on).not.toHaveBeenCalled()
  })
})
