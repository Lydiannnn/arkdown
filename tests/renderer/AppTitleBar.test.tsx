import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { AppTitleBar } from '../../src/renderer/chrome/AppTitleBar'
import {
  buildApplicationMenuModel,
  type ApplicationMenuSection,
} from '../../src/shared/application-menu-model'
import type { WindowStateSnapshot } from '../../src/shared/contracts'

const applicationMenuStyle = document.createElement('style')
applicationMenuStyle.textContent = readFileSync(
  path.join(process.cwd(), 'src/renderer/chrome/application-menu-popover.css'),
  'utf8',
)

beforeAll(() => document.head.append(applicationMenuStyle))
afterAll(() => applicationMenuStyle.remove())

const normalWindowState = { maximized: false, fullscreen: false, revision: 0 }

const nestedMenuModel = [{
  id: 'file',
  label: '文件',
  items: [
    {
      kind: 'command',
      id: 'file.save-as',
      label: '另存为…',
      command: 'save-as',
      accelerator: 'CmdOrCtrl+Shift+S',
    },
    {
      kind: 'submenu',
      id: 'file.recent',
      label: '最近编辑的文档…',
      items: [{
        kind: 'recent-document',
        id: 'file.recent.0',
        label: 'C:\\Docs\\one.md',
        absolutePath: 'C:\\Docs\\one.md',
      }],
    },
  ],
}, {
  id: 'edit',
  label: '编辑',
  items: [{ kind: 'command', id: 'edit.find', label: '在文档中搜索', command: 'find-in-document' }],
}] as unknown as readonly ApplicationMenuSection[]

const deepMenuModel = [{
  id: 'file',
  label: '文件',
  items: [
    { kind: 'command', id: 'file.first', label: '第一个命令', command: 'save' },
    {
      kind: 'submenu',
      id: 'file.outer',
      label: '外层菜单',
      items: [
        { kind: 'command', id: 'file.outer.first', label: '外层命令', command: 'save' },
        {
          kind: 'submenu',
          id: 'file.inner',
          label: '内层菜单',
          items: [{ kind: 'command', id: 'file.inner.leaf', label: '叶子命令', command: 'save' }],
        },
      ],
    },
    { kind: 'command', id: 'file.disabled', label: '禁用命令', command: 'save', disabled: true },
  ],
}] as unknown as readonly ApplicationMenuSection[]

const hairlineMenuModel = [{
  id: 'file',
  label: 'File',
  items: [
    { kind: 'command', id: 'file.before', label: 'Before', command: 'save' },
    { kind: 'separator', id: 'file.separator' },
    {
      kind: 'submenu',
      id: 'file.more',
      label: 'More',
      items: [
        { kind: 'command', id: 'file.more.before', label: 'Nested before', command: 'save' },
        { kind: 'separator', id: 'file.more.separator' },
        { kind: 'command', id: 'file.more.after', label: 'Nested after', command: 'save' },
      ],
    },
  ],
}] as unknown as readonly ApplicationMenuSection[]

describe('AppTitleBar', () => {
  it('requires an authoritative window-state snapshot', () => {
    expectTypeOf<Pick<ComponentProps<typeof AppTitleBar>, 'windowState'>>()
      .toEqualTypeOf<{ windowState: WindowStateSnapshot }>()
  })

  it('rebuilds the edit-indicator check from the latest supplied menu state', () => {
    const onExecuteItem = vi.fn()
    const menuState = {
      hasPrintableDocument: false,
      spellCheckEnabled: false,
      showEditIndicators: false,
      editorZoomPercent: 100,
      fullscreen: false,
    }
    const view = render(
      <AppTitleBar
        menuState={menuState}
        onExecuteItem={onExecuteItem}
        windowState={normalWindowState}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '视图' }))
    expect(screen.getByRole('menuitemcheckbox', { name: '源码编辑提示' }))
      .toHaveAttribute('aria-checked', 'false')

    view.rerender(
      <AppTitleBar
        menuState={{ ...menuState, showEditIndicators: true }}
        onExecuteItem={onExecuteItem}
        windowState={normalWindowState}
      />,
    )
    expect(screen.getByRole('menuitemcheckbox', { name: '源码编辑提示' }))
      .toHaveAttribute('aria-checked', 'true')
    const checked = screen.getByRole('menuitemcheckbox', { name: '源码编辑提示' })
      .querySelector('.application-menu-check')
    expect(checked?.querySelector('svg')).toBeInTheDocument()
    expect(checked).not.toHaveTextContent('✓')
  })

  it('reserves trailing status checks for edit indicators and theme choices', () => {
    const menuState = {
      hasPrintableDocument: false,
      spellCheckEnabled: true,
      showEditIndicators: true,
      editorZoomPercent: 100,
      fullscreen: true,
    }
    render(
      <AppTitleBar
        menuState={menuState}
        onExecuteItem={vi.fn()}
        windowState={{ maximized: false, fullscreen: true, revision: 1 }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '视图' }))
    const editIndicators = screen.getByRole('menuitemcheckbox', { name: '源码编辑提示' })
    const editStatus = editIndicators.querySelector<HTMLElement>('.application-menu-trailing-status')
    expect(editStatus?.querySelector('.application-menu-check .app-icon')).toBeInTheDocument()
    expect(editStatus).toBe(editIndicators.lastElementChild)
    expect(getComputedStyle(editStatus!).width).toBe('18px')
    expect(getComputedStyle(editStatus!).justifySelf).toBe('end')
    expect(editIndicators.firstElementChild).not.toContainElement(editStatus)

    const fullscreen = screen.getByRole('menuitemcheckbox', { name: /退出全屏/ })
    expect(fullscreen.querySelector('.application-menu-trailing-status')).not.toBeInTheDocument()
    expect(fullscreen.firstElementChild?.querySelector('.application-menu-check .app-icon'))
      .toBeInTheDocument()

    fireEvent.pointerEnter(screen.getByRole('button', { name: '主题' }))
    const minimal = screen.getByRole('menuitemradio', { name: '跟随系统' })
    const minimalStatus = minimal.querySelector<HTMLElement>('.application-menu-trailing-status')
    expect(minimalStatus?.querySelector('.application-menu-check .app-icon')).toBeInTheDocument()
    expect(minimalStatus).toBe(minimal.lastElementChild)
    expect(minimal.firstElementChild).not.toContainElement(minimalStatus)
  })

  it('retains top-menu hairlines, open submenu, and focus while DPR changes', async () => {
    const dprDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    let currentDpr = 1.5
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => currentDpr,
    })
    try {
      render(
        <AppTitleBar
          menuModel={hairlineMenuModel}
          onExecuteItem={vi.fn()}
          windowState={normalWindowState}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'File' }))
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'More' }))
      const root = screen.getAllByRole('menu')
        .find((menu) => !menu.classList.contains('application-menu-submenu'))!
      const submenu = await screen.findByRole('menu', { name: /More/u })
      const rootSeparator = root.querySelector<HTMLElement>(':scope > .application-menu-separator')!
      const submenuSeparator = submenu.querySelector<HTMLElement>(':scope > .application-menu-separator')!
      const rootStroke = rootSeparator.querySelector<HTMLElement>('.menu-hairline-stroke')!
      const submenuStroke = submenuSeparator.querySelector<HTMLElement>('.menu-hairline-stroke')!
      const focused = screen.getByRole('menuitem', { name: 'Nested before' })
      focused.focus()

      expect(rootSeparator).toHaveClass('menu-hairline')
      expect(submenuSeparator).toHaveClass('menu-hairline')
      expect(rootSeparator.querySelectorAll('.menu-hairline-stroke')).toHaveLength(1)
      expect(submenuSeparator.querySelectorAll('.menu-hairline-stroke')).toHaveLength(1)
      expect(rootStroke.style.height).toBe('1px')
      expect(submenuStroke.style.height).toBe('1px')
      expect(rootStroke.style.transform).toContain(`scaleY(${2 / 3})`)
      expect(submenuStroke.style.transform).toContain(`scaleY(${2 / 3})`)

      currentDpr = 2
      act(() => window.dispatchEvent(new Event('resize')))

      expect(screen.getAllByRole('menu')).toEqual([root, submenu])
      expect(root.querySelector(':scope > .application-menu-separator')).toBe(rootSeparator)
      expect(submenu.querySelector(':scope > .application-menu-separator')).toBe(submenuSeparator)
      expect(screen.getByRole('menuitem', { name: 'More' })).toHaveAttribute('aria-expanded', 'true')
      expect(focused).toHaveFocus()
      expect(rootStroke.style.height).toBe('1px')
      expect(submenuStroke.style.height).toBe('1px')
      expect(rootStroke.style.transform).toContain('scaleY(0.5)')
      expect(submenuStroke.style.transform).toContain('scaleY(0.5)')
    } finally {
      if (dprDescriptor) Object.defineProperty(window, 'devicePixelRatio', dprDescriptor)
    }
  })

  it('routes the square title-bar control through the unified fullscreen action', async () => {
    const controlWindow = vi.fn(async (action: string) => ({
      ok: true as const,
      value: { maximized: false, fullscreen: action === 'toggle-fullscreen', revision: 0 },
    }))
    window.arkdown = {
      ...window.arkdown,
      controlWindow,
      getWindowState: vi.fn(async () => ({
        ok: true as const,
        value: { maximized: false, fullscreen: false, revision: 0 },
      })),
    }

    render(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={normalWindowState}
      />,
    )

    const minimize = screen.getByRole('button', { name: '最小化' })
    const fullscreen = screen.getByRole('button', { name: '全屏' })
    const close = screen.getByRole('button', { name: '关闭' })
    expect(minimize.querySelector('.app-icon')).toBeInTheDocument()
    expect(fullscreen.querySelector('.app-icon')).toBeInTheDocument()
    expect(close.querySelector('.app-icon')).toBeInTheDocument()

    fireEvent.click(minimize)
    fireEvent.click(fullscreen)
    fireEvent.click(close)
    expect(controlWindow.mock.calls.map(([action]) => action)).toEqual([
      'minimize', 'toggle-fullscreen', 'close',
    ])
  })

  it('owns title-bar double-clicks only while fullscreen so the renderer can exit fullscreen', () => {
    const controlWindow = vi.fn(async () => ({
      ok: true as const,
      value: { maximized: false, fullscreen: false, revision: 2 },
    }))
    window.arkdown = { ...window.arkdown, controlWindow }

    const { rerender } = render(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={normalWindowState}
      />,
    )
    const titlebar = screen.getByTestId('app-titlebar')

    fireEvent.doubleClick(titlebar)
    expect(controlWindow).not.toHaveBeenCalled()

    rerender(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={{ maximized: false, fullscreen: true, revision: 1 }}
      />,
    )
    expect(titlebar).toHaveClass('is-fullscreen')
    fireEvent.doubleClick(titlebar)
    expect(controlWindow).toHaveBeenCalledOnce()
    expect(controlWindow).toHaveBeenCalledWith('toggle-fullscreen')
  })

  it('opens a renderer menu and switches sections while hovering', () => {
    const onExecuteItem = vi.fn()
    render(
      <AppTitleBar
        onExecuteItem={onExecuteItem}
        windowState={normalWindowState}
      />,
    )

    expect(screen.getAllByRole('button').slice(0, 8).map((button) => button.textContent)).toEqual([
      '文件', '编辑', '段落', '格式', '视图', '主题', '工具', '帮助',
    ])
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
    expect(screen.getByRole('menu', { name: '文件菜单' })).toBeVisible()
    fireEvent.pointerEnter(screen.getByRole('button', { name: '编辑' }))
    expect(screen.queryByRole('menu', { name: '文件菜单' })).not.toBeInTheDocument()
    expect(screen.getByRole('menu', { name: '编辑菜单' })).toBeVisible()
    fireEvent.click(screen.getByRole('menuitem', { name: '在文档中搜索Ctrl+F' }))
    expect(onExecuteItem).toHaveBeenCalledWith('edit.find')
  })

  it('derives the fullscreen menu label from the current WindowState', async () => {
    const getWindowState = vi.fn(async () => ({
      ok: true as const,
      value: { maximized: false, fullscreen: true, revision: 1 },
    }))
    window.arkdown = { ...window.arkdown, getWindowState }

    render(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={{ maximized: false, fullscreen: true, revision: 1 }}
      />,
    )
    expect(getWindowState).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '视图' }))

    const fullscreen = screen.getByRole('menuitemcheckbox', { name: /退出全屏/ })
    expect(fullscreen).toBeVisible()
    expect(fullscreen).toHaveAttribute('aria-checked', 'true')
  })

  it('consumes complete native window snapshots only through prop rerenders', async () => {
    const unsubscribe = vi.fn()
    window.arkdown = {
      ...window.arkdown,
      getWindowState: vi.fn(async () => ({
        ok: true as const,
        value: { maximized: false, fullscreen: false, revision: 0 },
      })),
      onWindowStateChanged: vi.fn(() => unsubscribe),
    }

    const view = render(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={normalWindowState}
      />,
    )
    const fullscreenControl = screen.getByRole('button', { name: '全屏' })
    view.rerender(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={{ maximized: true, fullscreen: true, revision: 1 }}
      />,
    )
    expect(screen.getByRole('button', { name: '退出全屏' })).toBe(fullscreenControl)
    fireEvent.click(screen.getByRole('button', { name: '视图' }))
    expect(screen.getByRole('menuitemcheckbox', { name: /退出全屏/ }))
      .toHaveAttribute('aria-checked', 'true')
    expect(window.arkdown.onWindowStateChanged).not.toHaveBeenCalled()
    expect(window.arkdown.getWindowState).not.toHaveBeenCalled()

    view.unmount()
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('opens a clamped recent-document submenu by hover and navigates nested layers by keyboard', async () => {
    const originalWidth = window.innerWidth
    const originalHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 240 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 100 })
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('application-menu-submenu')) {
        return { left: 0, top: 0, right: 180, bottom: 100, width: 180, height: 100, x: 0, y: 0, toJSON: () => ({}) }
      }
      if (this.textContent?.includes('最近编辑的文档')) {
        return { left: 210, top: 40, right: 290, bottom: 68, width: 80, height: 28, x: 210, y: 40, toJSON: () => ({}) }
      }
      return { left: 0, top: 0, right: 80, bottom: 28, width: 80, height: 28, x: 0, y: 0, toJSON: () => ({}) }
    })

    try {
      render(<div className="app-shell"><AppTitleBar menuModel={nestedMenuModel} onExecuteItem={vi.fn()} windowState={normalWindowState} /></div>)
      fireEvent.click(screen.getByRole('button', { name: '文件' }))
      const recent = screen.getByRole('menuitem', { name: '最近编辑的文档…' })

      fireEvent.pointerEnter(recent)
      const submenu = await screen.findByRole('menu', { name: '最近编辑的文档…子菜单' })
      expect(submenu).toBeVisible()
      await waitFor(() => expect(submenu).toHaveStyle({ left: '30px', top: '8px' }))
      expect(submenu).toHaveAttribute('data-ui-selection-portal', 'true')

      const recentDocument = screen.getByRole('menuitem', { name: 'C:\\Docs\\one.md' })
      recentDocument.focus()
      fireEvent.keyDown(recentDocument, { key: 'ArrowLeft' })
      expect(screen.queryByRole('menu', { name: '最近编辑的文档…子菜单' })).not.toBeInTheDocument()
      expect(recent).toHaveFocus()

      fireEvent.keyDown(recent, { key: 'ArrowRight' })
      await waitFor(() => expect(screen.getByRole('menuitem', { name: 'C:\\Docs\\one.md' })).toHaveFocus())
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'C:\\Docs\\one.md' }), { key: 'Escape' })
      expect(screen.queryByRole('menu', { name: '最近编辑的文档…子菜单' })).not.toBeInTheDocument()
      expect(screen.getByRole('menu', { name: '文件菜单' })).toBeVisible()
      expect(recent).toHaveFocus()

      const saveAs = screen.getByRole('menuitem', { name: '另存为…Ctrl+Shift+S' })
      saveAs.focus()
      fireEvent.keyDown(saveAs, { key: 'ArrowDown' })
      expect(recent).toHaveFocus()
      expect(await screen.findByRole('menu', { name: '最近编辑的文档…子菜单' })).toBeVisible()

      fireEvent.keyDown(recent, { key: 'Escape' })
      expect(screen.queryByRole('menu', { name: '最近编辑的文档…子菜单' })).not.toBeInTheDocument()
      expect(screen.getByRole('menu', { name: '文件菜单' })).toBeVisible()
      fireEvent.keyDown(recent, { key: 'Escape' })
      expect(screen.queryByRole('menu', { name: '文件菜单' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '文件' })).toHaveFocus()
    } finally {
      bounds.mockRestore()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight })
    }
  })

  it('shows Windows accelerator labels without Electron aliases', () => {
    render(<AppTitleBar menuModel={nestedMenuModel} onExecuteItem={vi.fn()} windowState={normalWindowState} />)
    fireEvent.click(screen.getByRole('button', { name: '文件' }))

    expect(screen.getByRole('menuitem', { name: '另存为…Ctrl+Shift+S' })).toBeVisible()
    expect(screen.getByRole('menu', { name: '文件菜单' })).not.toHaveTextContent('CmdOr')
  })

  it('does not execute disabled custom rows', () => {
    const onExecuteItem = vi.fn()
    render(<AppTitleBar menuModel={deepMenuModel} onExecuteItem={onExecuteItem} windowState={normalWindowState} />)
    fireEvent.click(screen.getByRole('button', { name: '文件' }))

    const disabled = screen.getByRole('menuitem', { name: '禁用命令' })
    expect(disabled).toBeDisabled()
    fireEvent.click(disabled)
    expect(onExecuteItem).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: '文件菜单' })).toBeVisible()
  })

  it('preserves recursive focus navigation across three menu levels', async () => {
    render(<AppTitleBar menuModel={deepMenuModel} onExecuteItem={vi.fn()} windowState={normalWindowState} />)
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
    const first = screen.getByRole('menuitem', { name: '第一个命令' })
    const outer = screen.getByRole('menuitem', { name: '外层菜单' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(outer).toHaveFocus()
    expect(await screen.findByRole('menu', { name: '外层菜单子菜单' })).toBeVisible()

    fireEvent.keyDown(outer, { key: 'ArrowRight' })
    const outerFirst = screen.getByRole('menuitem', { name: '外层命令' })
    await waitFor(() => expect(outerFirst).toHaveFocus())
    fireEvent.keyDown(outerFirst, { key: 'ArrowDown' })
    const inner = screen.getByRole('menuitem', { name: '内层菜单' })
    expect(inner).toHaveFocus()
    expect(await screen.findByRole('menu', { name: '内层菜单子菜单' })).toBeVisible()

    fireEvent.keyDown(inner, { key: 'ArrowRight' })
    const leaf = screen.getByRole('menuitem', { name: '叶子命令' })
    await waitFor(() => expect(leaf).toHaveFocus())
    fireEvent.keyDown(leaf, { key: 'ArrowLeft' })
    expect(screen.queryByRole('menu', { name: '内层菜单子菜单' })).not.toBeInTheDocument()
    expect(inner).toHaveFocus()
    fireEvent.keyDown(inner, { key: 'ArrowLeft' })
    expect(screen.queryByRole('menu', { name: '外层菜单子菜单' })).not.toBeInTheDocument()
    expect(outer).toHaveFocus()
  })

  it('does not switch sections from hover before a menu is opened', () => {
    render(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={normalWindowState}
      />,
    )
    fireEvent.pointerEnter(screen.getByRole('button', { name: '编辑' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not duplicate the sidebar toggle in the application title bar', () => {
    render(<AppTitleBar onExecuteItem={vi.fn()} windowState={normalWindowState} />)

    expect(screen.queryByRole('button', { name: '隐藏侧边栏' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '显示侧边栏' })).not.toBeInTheDocument()
  })

  it('renders only from its window-state prop and never reads or subscribes itself', () => {
    const getWindowState = vi.fn(() => {
      throw new Error('AppTitleBar must not read window state')
    })
    const onWindowStateChanged = vi.fn(() => {
      throw new Error('AppTitleBar must not subscribe to window state')
    })
    window.arkdown = { ...window.arkdown, getWindowState, onWindowStateChanged }

    const view = render(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={normalWindowState}
      />,
    )
    const fullscreenControl = screen.getByRole('button', { name: '全屏' })

    view.rerender(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={{ maximized: true, fullscreen: false, revision: 1 }}
      />,
    )
    expect(screen.getByRole('button', { name: '全屏' })).toBe(fullscreenControl)
    view.rerender(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={{ maximized: false, fullscreen: true, revision: 2 }}
      />,
    )
    expect(screen.getByRole('button', { name: '退出全屏' })).toBe(fullscreenControl)
    expect(getWindowState).not.toHaveBeenCalled()
    expect(onWindowStateChanged).not.toHaveBeenCalled()
  })

  it('corrects only the open fullscreen row without replacing menu or focused nodes', () => {
    const builtModel = buildApplicationMenuModel({
      recentDocuments: [{
        id: 'file.recent.review-proof',
        absolutePath: 'C:\\Review\\nondefault.md',
      }],
      hasPrintableDocument: true,
      spellCheckEnabled: true,
      showEditIndicators: false,
      editorZoomPercent: 110,
      fullscreen: false,
    })
    const staleModel = builtModel.map((section) => section.id === 'view'
      ? {
          ...section,
          label: '自定义视图',
          items: [
            ...section.items,
            {
              kind: 'command' as const,
              id: 'view.review-disabled',
              label: '审查专用禁用项',
              command: 'save' as const,
              disabled: true,
            },
          ],
        }
      : section)
    const view = render(
      <div style={{ '--theme-color-rgb': '37 99 235' } as React.CSSProperties}>
        <AppTitleBar
          menuModel={staleModel}
          onExecuteItem={vi.fn()}
          windowState={normalWindowState}
        />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: '自定义视图' }))
    const menu = screen.getByRole('menu', { name: '自定义视图菜单' })
    const item = screen.getByRole('menuitemcheckbox', { name: /^全屏/ })
    item.focus()

    view.rerender(
      <div style={{ '--theme-color-rgb': '37 99 235' } as React.CSSProperties}>
        <AppTitleBar
          menuModel={staleModel}
          onExecuteItem={vi.fn()}
          windowState={{ maximized: false, fullscreen: true, revision: 1 }}
        />
      </div>,
    )

    expect(screen.getByRole('menu', { name: '自定义视图菜单' })).toBe(menu)
    const corrected = screen.getByRole('menuitemcheckbox', { name: /退出全屏/ })
    expect(corrected).toBe(item)
    expect(corrected).toHaveFocus()
    expect(corrected).toHaveAttribute('aria-checked', 'true')
    expect(corrected).toHaveClass('application-menu-theme-state')
    expect(corrected.style.color).toBe(
      'rgb(var(--theme-color-rgb, 198 40 40) / 100%)',
    )
    expect(screen.getByRole('menuitemcheckbox', { name: '源码编辑提示' }))
      .toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('menuitem', { name: '仅放大编辑区' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: '恢复编辑区大小' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: '审查专用禁用项' })).toBeDisabled()

    fireEvent.pointerEnter(screen.getByRole('button', { name: '文件' }))
    const recent = screen.getByRole('menuitem', { name: '最近编辑的文档…' })
    expect(recent).toBeVisible()
    fireEvent.pointerEnter(recent)
    expect(screen.getByRole('menuitem', { name: 'C:\\Review\\nondefault.md' })).toBeVisible()
  })

  it('keeps the rightmost control as Close while the adjacent control exits fullscreen', () => {
    const controlWindow = vi.fn(async (_action: string) => ({
      ok: true as const,
      value: normalWindowState,
    }))
    window.arkdown = { ...window.arkdown, controlWindow }
    const view = render(
      <AppTitleBar
        onExecuteItem={vi.fn()}
        windowState={{ maximized: false, fullscreen: true, revision: 1 }}
      />,
    )

    const exitFullscreen = screen.getByRole('button', { name: '退出全屏' })
    const close = screen.getByRole('button', { name: '关闭' })
    expect(close).toHaveAttribute('data-tooltip', '关闭')
    expect(close).toHaveClass('window-close-button')
    expect(close.querySelector('.window-restore-icon')).not.toBeInTheDocument()
    close.focus()
    fireEvent.click(exitFullscreen)
    fireEvent.click(close)
    expect(controlWindow.mock.calls.map(([action]) => action)).toEqual([
      'toggle-fullscreen', 'close',
    ])

    view.rerender(
      <AppTitleBar onExecuteItem={vi.fn()} windowState={normalWindowState} />,
    )
    expect(screen.getByRole('button', { name: '关闭' })).toBe(close)
    expect(close).toHaveFocus()
  })
})

it('toggles the sidebar from the titlebar with accessible state and keyboard activation', async () => {
  function Consumer() {
    const [visible, setVisible] = useState(true)
    return <><AppTitleBar windowState={normalWindowState} onExecuteItem={() => {}}
      sidebarVisible={visible} onToggleSidebar={() => setVisible(!visible)} />
      <aside hidden={!visible}>Workspace content</aside></>
  }
  render(<Consumer />)
  const user = userEvent.setup()
  const toggle = screen.getByRole('button', { name: '隐藏侧边栏' })
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(toggle.nextElementSibling).toBe(screen.getByRole('navigation', { name: '应用程序菜单' }))
  await user.click(toggle)
  expect(screen.getByText('Workspace content')).not.toBeVisible()
  expect(toggle).toHaveAttribute('aria-label', '显示侧边栏')
  expect(toggle).toHaveAttribute('data-tooltip', '显示侧边栏')
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await user.keyboard('{Enter}')
  expect(screen.getByText('Workspace content')).toBeVisible()
  expect(toggle).toHaveAttribute('data-tooltip', '隐藏侧边栏')
})
