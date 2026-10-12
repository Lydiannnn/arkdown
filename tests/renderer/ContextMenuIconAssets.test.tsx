import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'
import {
  ContextMenuProvider,
  useContextMenu,
} from '../../src/renderer/context-menu/ContextMenuProvider'
import { buildVisualEditorMenu } from '../../src/renderer/editor/context-menu/editor-menu-model'

const contextMenuCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/context-menu/context-menu.css'),
  'utf8',
)

function Harness() {
  const menu = useContextMenu()
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <button
      ref={buttonRef}
      onClick={() => menu.openMenu({
        x: 40,
        y: 50,
        execute: () => undefined,
        restoreFocus: () => buttonRef.current?.focus(),
        items: buildVisualEditorMenu({
          kind: 'text',
          selectionText: '图标',
          activeBlocks: {
            blockquote: false,
            codeBlock: false,
            bulletList: false,
            orderedList: false,
            taskList: false,
            paragraphStyle: null,
          },
        }),
      })}
    >
      打开图标菜单
    </button>
  )
}

describe('ContextMenu icon assets', () => {
  it('renders a unified submenu icon in the leading icon column', () => {
    const originalDevicePixelRatio = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1.25,
    })

    try {
      render(
        <ContextMenuProvider>
          <Harness />
        </ContextMenuProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: '打开图标菜单' }))
      const paragraph = screen.getByRole('menuitem', { name: '段落' })
      fireEvent.mouseEnter(paragraph.parentElement!)

      const body = screen.getByRole('menuitem', { name: /^正文/ })
      const icon = body.querySelector('.app-icon')
      expect(icon).toHaveAttribute('width', '16')
      expect(icon).toHaveAttribute('height', '16')
      expect(icon?.parentElement).toHaveClass('context-menu-icon')
      expect(body.querySelector('.context-menu-label')).toHaveTextContent('正文')
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value: originalDevicePixelRatio,
      })
    }
  })

  it('moves only text-bearing menu icons 7px left at 70% opacity', () => {
    const style = document.createElement('style')
    style.textContent = contextMenuCss
    document.head.append(style)

    try {
      render(
        <ContextMenuProvider>
          <Harness />
        </ContextMenuProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: '打开图标菜单' }))
      const paragraph = screen.getByRole('menuitem', { name: '段落' })
      fireEvent.mouseEnter(paragraph.parentElement!)

      const bodyIcon = screen.getByRole('menuitem', { name: /^正文/ })
        .querySelector<HTMLElement>('.context-menu-icon')!
      expect(getComputedStyle(bodyIcon).transform).toBe('translateX(-7px)')
      expect(getComputedStyle(bodyIcon).opacity).toBe('0.7')

      const cutIcon = screen.getByRole('menuitem', { name: /^剪切/ })
        .querySelector<HTMLElement>('.context-menu-icon')!
      expect(getComputedStyle(cutIcon).transform).not.toBe('translateX(-7px)')
      expect(getComputedStyle(cutIcon).opacity).not.toBe('0.7')
    } finally {
      style.remove()
    }
  })
})
