import { describe, expect, it, vi } from 'vitest'
import {
  ArknoteTray,
  StickyNoteTray,
  type StickyNoteTrayMenuItem,
} from '../../src/main/sticky-notes/sticky-note-tray'

function trayHarness() {
  let doubleClick: (() => void) | undefined
  const tray = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'double-click') doubleClick = listener
    }),
  }
  const createTray = vi.fn(() => tray)
  const buildMenu = vi.fn((template: StickyNoteTrayMenuItem[]) => template)
  return { tray, createTray, buildMenu, doubleClick: () => doubleClick?.() }
}

describe('StickyNoteTray', () => {
  it('keeps the existing Arkdown sticky-note menu and forwards every action', () => {
    const calls: string[] = []
    const { tray, createTray, buildMenu } = trayHarness()
    const controller = new StickyNoteTray({
      createTray,
      buildMenu,
      showApp: () => calls.push('show'),
      openNoteBox: () => calls.push('box'),
      createNote: () => calls.push('create'),
      showAllNotes: () => calls.push('show-all'),
      hideAllNotes: () => calls.push('hide-all'),
      quit: () => calls.push('quit'),
    })

    controller.initialize()
    const template = buildMenu.mock.calls[0]![0]
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      'Arkdown',
      'separator',
      '显示 Arkdown',
      '打开便签盒子',
      '创建便签',
      'separator',
      '显示全部便签',
      '隐藏全部便签',
      'separator',
      '退出',
    ])
    for (const item of template) item.click?.()
    expect(calls).toEqual(['show', 'box', 'create', 'show-all', 'hide-all', 'quit'])
    expect(tray.setToolTip).toHaveBeenCalledWith('Arkdown')
  })

  it('initializes at most one Arkdown tray and destroys it once', () => {
    const { tray, createTray, buildMenu } = trayHarness()
    const controller = new StickyNoteTray({
      createTray,
      buildMenu,
      showApp: vi.fn(),
      openNoteBox: vi.fn(),
      createNote: vi.fn(),
      showAllNotes: vi.fn(),
      hideAllNotes: vi.fn(),
      quit: vi.fn(),
    })

    controller.initialize()
    controller.initialize()
    expect(createTray).toHaveBeenCalledTimes(1)

    controller.destroy()
    controller.destroy()
    expect(tray.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('ArknoteTray', () => {
  it('serializes taskbar changes and drains an accepted toggle before quit', async () => {
    const { createTray, buildMenu } = trayHarness()
    let hidden = false, finish!: () => void
    const setHidden = vi.fn((value: boolean) => new Promise<void>(resolve => { finish = () => { hidden = value; resolve() } }))
    const controller = new ArknoteTray({ createTray, buildMenu, openNoteBox: vi.fn(), createNote: vi.fn(), openArkdown: vi.fn(), openSettings: vi.fn(), quit: vi.fn(),
      taskbar: { hidden: () => hidden, setHidden } })
    controller.initialize()
    const item = () => buildMenu.mock.lastCall![0].find(entry => entry.label === '不显示任务栏图标')!
    expect(item()).toMatchObject({ type: 'checkbox', checked: false, enabled: true })
    const staleClick = item().click!
    staleClick(); staleClick()
    expect(setHidden).toHaveBeenCalledExactlyOnceWith(true)
    expect(item()).toMatchObject({ checked: false, enabled: false })
    let drained = false
    const drain = controller.pauseAndDrain().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    finish(); await drain
    expect(item()).toMatchObject({ checked: true, enabled: false })
    staleClick(); expect(setHidden).toHaveBeenCalledTimes(1)
    controller.resume()
    expect(item()).toMatchObject({ checked: true, enabled: true })
    item().click?.(); expect(setHidden).toHaveBeenLastCalledWith(false)
    finish(); await vi.waitFor(() => expect(item()).toMatchObject({ checked: false, enabled: true }))
    controller.destroy()
  })
  it('restores the persisted taskbar check after save failure and ignores clicks after destroy', async () => {
    const { createTray, buildMenu } = trayHarness(), reportError = vi.fn()
    const failure = new Error('save failed'), setHidden = vi.fn(async () => { throw failure })
    const controller = new ArknoteTray({ createTray, buildMenu, openNoteBox: vi.fn(), createNote: vi.fn(), openArkdown: vi.fn(), openSettings: vi.fn(), quit: vi.fn(), reportError,
      taskbar: { hidden: () => true, setHidden } })
    controller.initialize()
    const item = () => buildMenu.mock.lastCall![0].find(entry => entry.label === '不显示任务栏图标')!
    item().click?.()
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(failure))
    expect(item()).toMatchObject({ checked: true, enabled: true })
    const staleClick = item().click!
    controller.destroy(); staleClick()
    expect(setHidden).toHaveBeenCalledTimes(1)
  })
  it('reports exactly one create and destroy transition to the controlled tray observer', () => {
    const { createTray, buildMenu } = trayHarness()
    const onTrayCreated = vi.fn()
    const onTrayDestroyed = vi.fn()
    const controller = new ArknoteTray({
      createTray,
      buildMenu,
      openNoteBox: vi.fn(),
      createNote: vi.fn(),
      openSettings: vi.fn(),
      quit: vi.fn(),
      onTrayCreated,
      onTrayDestroyed,
    } as never)

    controller.initialize()
    controller.initialize()
    expect(onTrayCreated).toHaveBeenCalledTimes(1)
    controller.destroy()
    controller.destroy()
    expect(onTrayDestroyed).toHaveBeenCalledTimes(1)
  })

  it('builds the standalone Arknote menu without Arkdown-wide show or hide actions', () => {
    const calls: string[] = []
    const { tray, createTray, buildMenu, doubleClick } = trayHarness()
    const controller = new ArknoteTray({
      createTray,
      buildMenu,
      openNoteBox: () => calls.push('box'),
      createNote: () => calls.push('create'),
      openSettings: () => calls.push('settings'),
      openArkdown: () => calls.push('arkdown'),
      quit: () => calls.push('quit'),
    })

    controller.initialize()
    const template = buildMenu.mock.calls[0]![0]
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      '打开便签盒子',
      '创建新便签',
      '活动中的便签',
      '打开 Arkdown',
      'separator',
      '不显示任务栏图标',
      '设置…',
      '退出 Arknote',
    ])
    for (const item of template) item.click?.()
    doubleClick()
    expect(calls).toEqual(['box', 'create', 'arkdown', 'settings', 'quit', 'box'])
    expect(tray.setToolTip).toHaveBeenCalledWith('Arknote')
  })

  it('lists notes in box order, marks only displayed notes, and opens a clicked note without toggling it closed', async () => {
    const { createTray, buildMenu } = trayHarness()
    let changed: () => void = () => undefined
    let notes = [{ id: 'one', name: 'A&B', displayed: true }, { id: 'two', name: '第二篇', displayed: false }]
    const open = vi.fn(async () => undefined)
    const unsubscribe = vi.fn()
    const controller = new ArknoteTray({
      createTray, buildMenu, openNoteBox: vi.fn(), createNote: vi.fn(), openArkdown: vi.fn(), openSettings: vi.fn(), quit: vi.fn(),
      activeNotes: { list: async () => notes, open, subscribe: (listener) => { changed = listener; return unsubscribe }, checkIcon: 'red-check.png' },
    })
    controller.initialize()
    const items = () => buildMenu.mock.lastCall![0].find((item) => item.label === '活动中的便签')!.submenu!
    await vi.waitFor(() => expect(items().map((item) => item.label)).toEqual(['A&&B', '第二篇']))
    expect(items()[0].icon).toBe('red-check.png')
    expect(items()[1].icon).toBeUndefined()
    items()[0].click?.()
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('one'))
    notes = [{ id: 'two', name: '新名称', displayed: true }]
    changed()
    await vi.waitFor(() => expect(items()).toHaveLength(1))
    expect(items()[0]).toMatchObject({ label: '新名称', icon: 'red-check.png' })
    controller.destroy()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps the most recent note snapshot and ignores refreshes after destruction', async () => {
    const { tray, createTray, buildMenu } = trayHarness()
    let changed: () => void = () => undefined
    const pending: Array<(notes: { id: string; name: string; displayed: boolean }[]) => void> = []
    const controller = new ArknoteTray({
      createTray, buildMenu, openNoteBox: vi.fn(), createNote: vi.fn(), openArkdown: vi.fn(), openSettings: vi.fn(), quit: vi.fn(),
      activeNotes: {
        list: () => new Promise((resolve) => pending.push(resolve)), open: vi.fn(),
        subscribe: (listener) => { changed = listener; return vi.fn() }, checkIcon: 'red-check.png',
      },
    })
    controller.initialize()
    changed()
    pending[1]([{ id: 'new', name: '新', displayed: true }])
    await vi.waitFor(() => expect(buildMenu.mock.lastCall![0].find((item) => item.submenu)?.submenu?.[0].label).toBe('新'))
    pending[0]([{ id: 'old', name: '旧', displayed: false }])
    await Promise.resolve()
    expect(buildMenu.mock.lastCall![0].find((item) => item.submenu)?.submenu?.[0].label).toBe('新')
    changed()
    controller.destroy()
    const calls = tray.setContextMenu.mock.calls.length
    pending[2]([])
    await Promise.resolve()
    expect(tray.setContextMenu).toHaveBeenCalledTimes(calls)
  })
})
