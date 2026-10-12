import { describe, expect, it, vi } from 'vitest'
import {
  buildApplicationMenuModel,
  formatWindowsAccelerator,
  type ApplicationMenuRuntimeState,
  type ApplicationMenuSection,
} from '../../src/shared/application-menu-model'
import {
  buildApplicationMenuTemplate,
  executeApplicationMenuModelItem,
  executeApplicationMenuRole,
  type ApplicationMenuActions,
} from '../../src/main/application-menu'
import * as applicationMenuModule from '../../src/main/application-menu'
import { SCREENSHOT_TRANSLATION_ACCELERATOR } from '../../src/shared/screenshot-translation'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

const runtimeState = (
  overrides: Partial<ApplicationMenuRuntimeState> = {},
): ApplicationMenuRuntimeState => ({
  recentDocuments: [{
    id: 'file.recent.opaque-one',
    absolutePath: 'C:\\Docs\\one.md',
  }],
  hasPrintableDocument: true,
  spellCheckEnabled: false,
  showEditIndicators: true,
  editorZoomPercent: 100,
  fullscreen: false,
  ...overrides,
})

function findItem(
  sections: readonly ApplicationMenuSection[],
  id: string,
): Record<string, unknown> | null {
  const visit = (items: readonly unknown[]): Record<string, unknown> | null => {
    for (const candidate of items) {
      if (!candidate || typeof candidate !== 'object') continue
      const item = candidate as Record<string, unknown>
      if (item.id === id) return item
      if (Array.isArray(item.items)) {
        const nested = visit(item.items)
        if (nested) return nested
      }
    }
    return null
  }
  return visit(sections.flatMap((section) => section.items))
}

function actions(): ApplicationMenuActions {
  return {
    createNewWindow: vi.fn(),
    openDocument: vi.fn(),
    closeWindow: vi.fn(),
    openAbout: vi.fn(),
    openGuide: vi.fn(),
    openBackgroundSettings: vi.fn(),
    reviewDrafts: vi.fn(),
  }
}

it('routes manual draft review through its main-owned menu action', () => {
  const menuActions = actions()
  const model = buildApplicationMenuModel(runtimeState())
  const item = model.flatMap((section) => section.items).find((entry) => entry.id === 'file.review-drafts')!
  const owner = {} as Parameters<typeof executeApplicationMenuModelItem>[0]
  const send = vi.fn()
  expect(executeApplicationMenuModelItem(owner, item, send, menuActions)).toBe(true)
  expect(menuActions.reviewDrafts).toHaveBeenCalledWith(owner)
  expect(send).not.toHaveBeenCalled()
})

const nativeOwner = {
  name: 'native-owner',
  webContents: {},
} as unknown as Electron.BrowserWindow

function clickNative(item: Electron.MenuItemConstructorOptions | undefined): void {
  item?.click?.(null as never, nativeOwner, {} as never)
}

describe('Chinese application menu', () => {
  it('routes native command, checkbox, and action callbacks to Electron\'s owner window', () => {
    const first = { name: 'first', webContents: {}, commands: [] as string[], actions: [] as string[] }
    const second = { name: 'second', webContents: {}, commands: [] as string[], actions: [] as string[] }
    let focused = second
    const send = vi.fn((ownerOrCommand: unknown, possibleCommand?: unknown) => {
      const owner = typeof possibleCommand === 'string'
        ? ownerOrCommand as typeof first
        : focused
      const command = typeof possibleCommand === 'string' ? possibleCommand : ownerOrCommand
      owner.commands.push(String(command))
    })
    const ownedActions = actions()
    ownedActions.openDocument = vi.fn((owner?: unknown) => {
      const target = owner && typeof owner === 'object' ? owner as typeof first : focused
      target.actions.push('open-document')
    })
    const model = buildApplicationMenuModel(runtimeState({ spellCheckEnabled: true }))
    const template = buildApplicationMenuTemplate(send, ownedActions, model)
    const fileItems = template.find((section) => section.id === 'file')
      ?.submenu as Electron.MenuItemConstructorOptions[]
    const editItems = template.find((section) => section.id === 'edit')
      ?.submenu as Electron.MenuItemConstructorOptions[]

    fileItems.find((item) => item.id === 'file.save')?.click?.(
      null as never,
      first as never,
      {} as never,
    )
    editItems.find((item) => item.id === 'edit.spell-check')?.click?.(
      null as never,
      first as never,
      {} as never,
    )
    fileItems.find((item) => item.id === 'file.open-document')?.click?.(
      null as never,
      first as never,
      {} as never,
    )

    expect(first.commands).toEqual(['save', 'toggle-spell-check'])
    expect(first.actions).toEqual(['open-document'])
    expect(second.commands).toEqual([])
    expect(second.actions).toEqual([])
    focused = first
  })

  it('keeps a native recent error flow attached to its owner after focus changes', async () => {
    const validation = deferred<void>()
    const first = { name: 'first', webContents: {} }
    const second = { name: 'second', webContents: {} }
    let focused = first
    const shownFor: unknown[] = []
    const openRecentDocument = vi.fn(async (
      ownerOrPath: unknown,
      possiblePath?: unknown,
    ) => {
      const explicitOwner = typeof possiblePath === 'string' ? ownerOrPath : null
      await validation.promise
      shownFor.push(explicitOwner ?? focused)
    })
    const template = buildApplicationMenuTemplate(
      vi.fn(),
      { ...actions(), openRecentDocument: openRecentDocument as never },
      buildApplicationMenuModel(runtimeState()),
    )
    const recent = (
      (template.find((section) => section.id === 'file')
        ?.submenu as Electron.MenuItemConstructorOptions[])
        .find((item) => item.id === 'file.recent')
        ?.submenu as Electron.MenuItemConstructorOptions[]
    )[0]

    recent.click?.(null as never, first as never, {} as never)
    focused = second
    validation.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(shownFor).toEqual([first])
  })

  it('executes a custom item directly against its sender-owned window', () => {
    const execute = (applicationMenuModule as unknown as {
      executeApplicationMenuModelItem?: (...args: unknown[]) => boolean
    }).executeApplicationMenuModelItem
    expect(execute).toBeTypeOf('function')
    if (!execute) return
    const first = { name: 'first' }
    const second = { name: 'second' }
    let focused = second
    const sent: Array<{ owner: unknown; command: unknown }> = []
    const send = (ownerOrCommand: unknown, possibleCommand?: unknown) => {
      sent.push({
        owner: possibleCommand === undefined ? focused : ownerOrCommand,
        command: possibleCommand ?? ownerOrCommand,
      })
    }
    const model = buildApplicationMenuModel(runtimeState())
    const ownedActions = actions()
    ownedActions.openDocument = vi.fn()
    const saveItem = findItem(model, 'file.save')
    const checkboxItem = findItem(model, 'edit.spell-check')
    const actionItem = findItem(model, 'file.open-document')

    expect(execute(first, saveItem, send, ownedActions)).toBe(true)
    expect(execute(first, checkboxItem, send, ownedActions)).toBe(true)
    expect(execute(first, actionItem, send, ownedActions)).toBe(true)
    expect(sent).toEqual([
      { owner: first, command: 'save' },
      { owner: first, command: 'toggle-spell-check' },
    ])
    expect(ownedActions.openDocument).toHaveBeenCalledWith(first)
    focused = first
  })

  it('routes native and custom fullscreen items through the same fixed owner action', () => {
    const first = { name: 'first', webContents: {} } as unknown as Electron.BrowserWindow
    const second = { name: 'second', webContents: {} } as unknown as Electron.BrowserWindow
    const executeRole = vi.fn()
    const ownedActions = { ...actions(), executeRole }
    const model = buildApplicationMenuModel(runtimeState())
    const fullscreenModelItem = findItem(model, 'view.fullscreen')
    const template = buildApplicationMenuTemplate(vi.fn(), ownedActions, model)
    const fullscreenNativeItem = (
      template.find((section) => section.id === 'view')
        ?.submenu as Electron.MenuItemConstructorOptions[]
    ).find((item) => item.id === 'view.fullscreen')

    expect(fullscreenNativeItem).toMatchObject({
      label: fullscreenModelItem?.label,
      accelerator: fullscreenModelItem?.accelerator,
      type: 'checkbox',
      checked: false,
      enabled: true,
    })
    expect(fullscreenNativeItem).not.toHaveProperty('role')
    fullscreenNativeItem?.click?.(null as never, first, {} as never)
    expect(executeApplicationMenuModelItem(
      first,
      fullscreenModelItem as never,
      vi.fn(),
      ownedActions,
    )).toBe(true)

    expect(executeRole.mock.calls).toEqual([
      [first, 'togglefullscreen'],
      [first, 'togglefullscreen'],
    ])
    expect(executeRole).not.toHaveBeenCalledWith(second, expect.anything())
  })

  it('routes native and custom screenshot translation through the exact invoking owner', () => {
    const first = { name: 'first', webContents: {} } as unknown as Electron.BrowserWindow
    const second = { name: 'second', webContents: {} } as unknown as Electron.BrowserWindow
    const beginScreenshotTranslation = vi.fn()
    const ownedActions = { ...actions(), beginScreenshotTranslation }
    const model = buildApplicationMenuModel(runtimeState())
    const modelItem = findItem(model, 'tools.screenshot-translation')
    const template = buildApplicationMenuTemplate(vi.fn(), ownedActions, model)
    const nativeItem = (
      template.find((section) => section.id === 'tools')
        ?.submenu as Electron.MenuItemConstructorOptions[]
    ).find((item) => item.id === 'tools.screenshot-translation')

    expect(nativeItem).toMatchObject({
      label: '截图翻译',
      accelerator: SCREENSHOT_TRANSLATION_ACCELERATOR,
      registerAccelerator: false,
      enabled: true,
    })
    nativeItem?.click?.(null as never, first, {} as never)
    expect(executeApplicationMenuModelItem(
      second,
      modelItem as never,
      vi.fn(),
      ownedActions,
    )).toBe(true)

    expect(beginScreenshotTranslation.mock.calls).toEqual([[first], [second]])
  })

  it('routes native and renderer background settings actions through the exact invoking owner', () => {
    const first = { name: 'first', webContents: {} } as unknown as Electron.BrowserWindow
    const second = { name: 'second', webContents: {} } as unknown as Electron.BrowserWindow
    const openBackgroundSettings = vi.fn()
    const ownedActions = { ...actions(), openBackgroundSettings }
    const model = buildApplicationMenuModel(runtimeState())
    const modelItem = findItem(model, 'theme.background')
    const template = buildApplicationMenuTemplate(vi.fn(), ownedActions, model)
    const nativeItem = (
      template.find((section) => section.id === 'theme')
        ?.submenu as Electron.MenuItemConstructorOptions[]
    ).find((item) => item.id === 'theme.background')

    expect(nativeItem).toMatchObject({ label: '设置背景...', enabled: true })
    nativeItem?.click?.(null as never, first, {} as never)
    expect(executeApplicationMenuModelItem(
      second,
      modelItem as never,
      vi.fn(),
      ownedActions,
    )).toBe(true)

    expect(openBackgroundSettings.mock.calls).toEqual([[first], [second]])
  })

  it('uses the owner coordinator cache for repeated fullscreen intent and isolates windows', () => {
    const firstCoordinator = { controlWindow: vi.fn(() => ({
      maximized: false, fullscreen: false, revision: 0,
    })) }
    const secondCoordinator = { controlWindow: vi.fn(() => ({
      maximized: false, fullscreen: true, revision: 1,
    })) }
    const createOwner = () => ({
      webContents: {
        isDestroyed: vi.fn(() => false),
        undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(),
        selectAll: vi.fn(), setZoomFactor: vi.fn(), getZoomFactor: vi.fn(() => 1),
      },
      isDestroyed: vi.fn(() => false),
      isFullScreen: vi.fn(() => { throw new Error('fullscreen bypass') }),
      setFullScreen: vi.fn(() => { throw new Error('fullscreen bypass') }),
    }) as unknown as Electron.BrowserWindow
    const first = createOwner()
    const second = createOwner()
    const coordinators = new WeakMap<Electron.BrowserWindow, typeof firstCoordinator>()
    coordinators.set(first, firstCoordinator)
    coordinators.set(second, secondCoordinator)

    executeApplicationMenuRole(first, 'togglefullscreen', (owner) => coordinators.get(owner))
    executeApplicationMenuRole(first, 'togglefullscreen', (owner) => coordinators.get(owner))

    expect(firstCoordinator.controlWindow.mock.calls).toEqual([
      ['toggle-fullscreen'],
      ['toggle-fullscreen'],
    ])
    expect(secondCoordinator.controlWindow).not.toHaveBeenCalled()
    expect(first.isFullScreen).not.toHaveBeenCalled()
    expect(first.setFullScreen).not.toHaveBeenCalled()
  })

  it('safely ignores fullscreen roles without a live owner coordinator', () => {
    const owner = {
      webContents: { isDestroyed: vi.fn(() => false) },
      isDestroyed: vi.fn(() => false),
    } as unknown as Electron.BrowserWindow
    const lookup = vi.fn(() => undefined)

    expect(() => executeApplicationMenuRole(owner, 'togglefullscreen', lookup)).not.toThrow()
    expect(lookup).toHaveBeenCalledWith(owner)

    owner.isDestroyed = vi.fn(() => true)
    lookup.mockClear()
    expect(() => executeApplicationMenuRole(owner, 'togglefullscreen', lookup)).not.toThrow()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('builds runtime recent, print, spelling, indicator, zoom, and fullscreen entries', () => {
    const model = buildApplicationMenuModel(runtimeState())

    expect(findItem(model, 'file.recent')).toMatchObject({
      kind: 'submenu',
      label: '最近编辑的文档…',
    })
    expect(findItem(model, 'file.recent.opaque-one')).toMatchObject({
      kind: 'recent-document',
      absolutePath: 'C:\\Docs\\one.md',
    })
    expect(findItem(model, 'file.print')).toMatchObject({ disabled: false })
    expect(findItem(model, 'edit.spell-check')).toMatchObject({
      kind: 'checkbox', checked: false,
    })
    expect(findItem(model, 'view.edit-indicators')).toMatchObject({
      kind: 'checkbox', checked: true,
    })
    expect(findItem(model, 'view.editor-zoom-in')).toMatchObject({ disabled: false })
    expect(findItem(model, 'view.editor-zoom-out')).toMatchObject({ disabled: false })
    expect(findItem(model, 'view.editor-zoom-reset')).toMatchObject({ disabled: true })
    expect(findItem(model, 'view.fullscreen')).toMatchObject({ label: '全屏', checked: false })

    const constrained = buildApplicationMenuModel(runtimeState({
      hasPrintableDocument: false,
      editorZoomPercent: 200,
      fullscreen: true,
    }))
    expect(findItem(constrained, 'file.print')).toMatchObject({ disabled: true })
    expect(findItem(constrained, 'view.editor-zoom-in')).toMatchObject({ disabled: true })
    expect(findItem(constrained, 'view.fullscreen')).toMatchObject({
      label: '退出全屏',
      checked: true,
    })

    const fullscreenTemplate = buildApplicationMenuTemplate(vi.fn(), actions(), constrained)
    const fullscreenItem = (
      fullscreenTemplate.find((section) => section.id === 'view')?.submenu as Array<{
        id?: string
        type?: string
        checked?: boolean
      }>
    ).find((item) => item.id === 'view.fullscreen')
    expect(fullscreenItem).toMatchObject({ type: 'checkbox', checked: true })
  })

  it('formats Electron accelerator aliases for Windows custom menus', () => {
    expect(formatWindowsAccelerator('CmdOrCtrl+Shift+S')).toBe('Ctrl+Shift+S')
    expect(formatWindowsAccelerator('CmdOr+O')).toBe('Ctrl+O')
    expect(formatWindowsAccelerator('Ctrl+1')).toBe('Ctrl+1')
  })

  it('uses the approved Typora-style top-level labels', () => {
    const template = buildApplicationMenuTemplate(vi.fn(), actions())
    expect(template.map((item) => item.id)).toEqual([
      'file', 'edit', 'paragraph', 'format', 'view', 'theme', 'tools', 'help',
    ])
    expect(template.map((item) => item.label)).toEqual([
      '文件', '编辑', '段落', '格式', '视图', '主题', '工具', '帮助',
    ])
  })

  it('keeps existing file commands while exposing runtime entries', () => {
    const send = vi.fn()
    const template = buildApplicationMenuTemplate(send, actions())
    const fileMenu = template[0].submenu
    expect(Array.isArray(fileMenu)).toBe(true)
    expect((fileMenu as Array<{ label?: string }>).map((item) => item.label).filter(Boolean)).toEqual([
      '新建文档', '新建窗口', '打开文档…', '打开文件夹…', '查看保留的草稿', '最近编辑的文档…',
      '保存', '另存为…', '导出...', '打印…', '偏好设置…', '关闭窗口',
    ])

    const exportMenu = (fileMenu as Electron.MenuItemConstructorOptions[])
      .find((item) => item.id === 'file.export')?.submenu as Electron.MenuItemConstructorOptions[]
    expect(exportMenu.map(({ label }) => label)).toEqual(['DOCX...', 'XLSX...'])
    clickNative(exportMenu[0])
    clickNative(exportMenu[1])
    expect(send).toHaveBeenNthCalledWith(1, nativeOwner, 'export-docx')
    expect(send).toHaveBeenNthCalledWith(2, nativeOwner, 'export-xlsx')

    const newDocument = (fileMenu as Electron.MenuItemConstructorOptions[])[0]
    clickNative(newDocument)
    expect(send).toHaveBeenNthCalledWith(3, nativeOwner, 'new-document')
  })

  it('maps Ctrl+Shift+S to the save-as command', () => {
    const send = vi.fn()
    const template = buildApplicationMenuTemplate(send, actions())
    const fileMenu = template[0].submenu as Array<{
      label?: string
      accelerator?: string
      click?: () => void
    }>
    const saveAs = fileMenu.find((item) => item.label === '另存为…')

    expect(saveAs?.accelerator).toBe('CmdOrCtrl+Shift+S')
    clickNative(saveAs)
    expect(send).toHaveBeenCalledWith(nativeOwner, 'save-as')
  })

  it('maps Ctrl+F to current-document search', () => {
    const send = vi.fn()
    const template = buildApplicationMenuTemplate(send, actions())
    const editMenu = template.find((item) => item.id === 'edit')?.submenu as Array<{
      label?: string
      accelerator?: string
      click?: () => void
    }>
    const findInDocument = editMenu.find((item) => item.label === '在文档中搜索')

    expect(findInDocument?.accelerator).toBe('CmdOrCtrl+F')
    clickNative(findInDocument)
    expect(send).toHaveBeenCalledWith(nativeOwner, 'find-in-document')
  })

  it('keeps all paragraph levels and structural commands consistent with context menus', () => {
    const send = vi.fn()
    const template = buildApplicationMenuTemplate(send, actions())
    const paragraph = template.find((item) => item.label === '段落')
    const items = paragraph?.submenu as Electron.MenuItemConstructorOptions[]
    expect(items.map((item) => item.label).filter(Boolean)).toEqual(expect.arrayContaining([
      '正文',
      '一级标题',
      '二级标题',
      '三级标题',
      '四级标题',
      '五级标题',
      '六级标题',
      '提升标题级别',
      '降低标题级别',
      '增加列表缩进',
      '减少列表缩进',
    ]))
    clickNative(items.find((item) => item.label === '六级标题'))
    expect(send).toHaveBeenCalledWith(nativeOwner, 'heading-6')
  })

  it('routes the checked Minimal radio idempotently to its exact owner window', () => {
    const send = vi.fn()
    const template = buildApplicationMenuTemplate(send, actions())
    const theme = template.find((item) => item.label === '主题')
    expect(theme?.submenu).toEqual([
      expect.objectContaining({ id: 'theme.system', label: '跟随系统', type: 'radio', checked: true }),
      expect.objectContaining({
        id: 'theme.minimal',
        label: '浅色模式',
        type: 'radio',
        checked: false,
        enabled: true,
        click: expect.any(Function),
      }),
      expect.objectContaining({ id: 'theme.dark', label: '深色模式', type: 'radio', checked: false }),
      { id: 'theme.separator.background', type: 'separator' },
      expect.objectContaining({
        id: 'theme.background',
        label: '设置背景...',
        enabled: true,
      }),
    ])
    const radio = (theme?.submenu as Electron.MenuItemConstructorOptions[])[1]
    clickNative(radio)
    clickNative(radio)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(1, nativeOwner, 'select-editor-theme-minimal')
    expect(send).toHaveBeenNthCalledWith(2, nativeOwner, 'select-editor-theme-minimal')
    expect(executeApplicationMenuModelItem(
      nativeOwner,
      buildApplicationMenuModel(runtimeState()).find((section) => section.id === 'theme')!.items[0]!,
      send,
      actions(),
    )).toBe(true)
  })

  it('recursively maps submenu, checkbox, recent-document, and disabled state', () => {
    const send = vi.fn()
    const openRecentDocument = vi.fn()
    const model = [{
      id: 'file',
      label: '文件',
      items: [
        {
          kind: 'submenu',
          id: 'file.recent',
          label: '最近编辑的文档…',
          items: [
            {
              kind: 'recent-document',
              id: 'file.recent.0',
              label: 'C:\\Docs\\one.md',
              absolutePath: 'C:\\Docs\\one.md',
            },
            {
              kind: 'checkbox',
              id: 'file.example-checkbox',
              label: '示例开关',
              checked: true,
              command: 'toggle-spell-check',
            },
          ],
        },
        {
          kind: 'command',
          id: 'file.disabled',
          label: '不可用命令',
          command: 'save',
          disabled: true,
        },
      ],
    }] as unknown as readonly ApplicationMenuSection[]

    const template = buildApplicationMenuTemplate(
      send,
      { ...actions(), openRecentDocument },
      model,
    )
    const fileItems = template[0]?.submenu as Electron.MenuItemConstructorOptions[]
    const recentItems = fileItems[0]?.submenu as Electron.MenuItemConstructorOptions[]

    expect(Array.isArray(recentItems), 'nested native submenu items').toBe(true)
    if (!Array.isArray(recentItems)) return
    expect(recentItems[0]).toMatchObject({
      id: 'file.recent.0', label: 'C:\\Docs\\one.md', enabled: true,
    })
    clickNative(recentItems[0])
    expect(openRecentDocument).toHaveBeenCalledWith(nativeOwner, 'C:\\Docs\\one.md')
    expect(recentItems[1]).toMatchObject({ type: 'checkbox', checked: true, enabled: true })
    clickNative(recentItems[1])
    expect(send).toHaveBeenCalledWith(nativeOwner, 'toggle-spell-check')
    expect(fileItems[1]).toMatchObject({ id: 'file.disabled', enabled: false })
  })

  it.each([
    { percent: 70, enabled: { in: true, out: false, reset: true } },
    { percent: 100, enabled: { in: true, out: true, reset: false } },
    { percent: 200, enabled: { in: false, out: true, reset: true } },
  ])('maps the $percent percent editor bounds to native enabled state', ({ percent, enabled }) => {
    const send = vi.fn()
    const template = buildApplicationMenuTemplate(
      send,
      actions(),
      buildApplicationMenuModel(runtimeState({ editorZoomPercent: percent })),
    )
    const viewItems = template.find((section) => section.id === 'view')
      ?.submenu as Electron.MenuItemConstructorOptions[]
    const zoomIn = viewItems.find((item) => item.id === 'view.editor-zoom-in')
    const zoomOut = viewItems.find((item) => item.id === 'view.editor-zoom-out')
    const reset = viewItems.find((item) => item.id === 'view.editor-zoom-reset')

    expect({
      in: zoomIn?.enabled,
      out: zoomOut?.enabled,
      reset: reset?.enabled,
    }).toEqual(enabled)
    clickNative(zoomIn)
    clickNative(zoomOut)
    clickNative(reset)
    expect(send.mock.calls.map(([, command]) => command)).toEqual([
      ...(enabled.in ? ['editor-zoom-in'] : []),
      ...(enabled.out ? ['editor-zoom-out'] : []),
      ...(enabled.reset ? ['editor-zoom-reset'] : []),
    ])
  })
})
