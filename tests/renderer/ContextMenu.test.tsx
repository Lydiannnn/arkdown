import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ContextMenuProvider,
  useContextMenu,
} from '../../src/renderer/context-menu/ContextMenuProvider'
import { buildVisualEditorMenu } from '../../src/renderer/editor/context-menu/editor-menu-model'
import { ContextMenu } from '../../src/renderer/context-menu/ContextMenu'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { TooltipProvider } from '../../src/renderer/tooltip/TooltipProvider'
import {
  getMenuHairlineOffsetCssPx,
  getMenuHairlineThicknessCssPx,
} from '../../src/renderer/context-menu/menu-hairline'
import { installUiSelectionGuard } from '../../src/renderer/app/ui-selection-guard'
const contextMenuCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/context-menu/context-menu.css'),
  'utf8',
)
const contextMenuStyle = document.createElement('style')
contextMenuStyle.textContent = contextMenuCss
const systemDarkMenuSelector = ':root:not([data-arkdown-theme]) .context-menu-list'

beforeAll(() => document.head.append(contextMenuStyle))
afterAll(() => contextMenuStyle.remove())

const neutralCheckedTokens = {
  light: {
    '--context-menu-neutral-checked-surface': '#eef0f2',
    '--context-menu-neutral-checked-hover-surface': '#e5e8eb',
    '--context-menu-neutral-checked-pressed-surface': '#d9dde1',
    '--context-menu-neutral-checked-border': '#c5c9cd',
    '--context-menu-neutral-checked-inset': 'rgb(0 0 0 / 4%)',
    '--context-menu-neutral-checked-icon': '#444',
  },
  dark: {
    '--context-menu-neutral-checked-surface': 'rgb(255 255 255 / 12%)',
    '--context-menu-neutral-checked-hover-surface': 'rgb(255 255 255 / 18%)',
    '--context-menu-neutral-checked-pressed-surface': 'rgb(255 255 255 / 24%)',
    '--context-menu-neutral-checked-border': 'rgb(255 255 255 / 32%)',
    '--context-menu-neutral-checked-inset': 'rgb(255 255 255 / 8%)',
    '--context-menu-neutral-checked-icon': 'rgb(255 255 255 / 92%)',
  },
} as const

function neutralStateCss(mode: keyof typeof neutralCheckedTokens): string {
  let css = contextMenuCss
  for (const [token, value] of Object.entries(neutralCheckedTokens[mode])) {
    css = css.replaceAll(`var(${token})`, value)
  }
  return css
    // JSDOM does not expose interactive pseudo-class state. Attribute selectors
    // have equivalent specificity and exercise the browser's real cascade.
    .replaceAll(':hover', '[data-test-state~="hover"]')
    .replaceAll(':active', '[data-test-state~="active"]')
    .replaceAll(':focus-visible', '[data-test-state~="focus-visible"]')
}

function styleRule(
  rules: CSSRuleList,
  selector: string,
): CSSStyleRule {
  const rule = Array.from(rules).find((candidate) => (
    candidate instanceof CSSStyleRule && candidate.selectorText === selector
  ))
  if (!(rule instanceof CSSStyleRule)) throw new Error(`Missing CSS rule: ${selector}`)
  return rule
}

function normalizedCssValue(value: string): string {
  return value.replace(/\s*\/\s*/g, '/')
}

type CssColor = Readonly<{
  red: number
  green: number
  blue: number
  alpha: number
}>

type MenuPalette = Readonly<{
  surface: CssColor
  foreground: CssColor
  border: CssColor
  icon: CssColor
  defaultCheckIndicator: CssColor
  paragraphSelectedIcon: CssColor
  themeText: CssColor
  shortcut: CssColor
  gridSurface: CssColor
  gridBorder: CssColor
  selectedSurface: CssColor
  selectedBorder: CssColor
  selectedIcon: CssColor
}>

function activeThemeRules(mode: keyof typeof neutralCheckedTokens): CSSStyleRule[] {
  const rules = contextMenuStyle.sheet?.cssRules
  if (!rules) throw new Error('Context-menu stylesheet was not loaded')

  return Array.from(rules).flatMap((rule) => {
    if (rule instanceof CSSStyleRule) return [rule]
    if (
      mode === 'dark'
      && rule instanceof CSSMediaRule
      && rule.conditionText === '(prefers-color-scheme: dark)'
    ) {
      return Array.from(rule.cssRules).filter((nested): nested is CSSStyleRule => (
        nested instanceof CSSStyleRule
      ))
    }
    return []
  })
}

function selectorListIncludes(rule: CSSStyleRule, selector: string): boolean {
  return rule.selectorText.split(',').some((candidate) => candidate.trim() === selector)
}

function themeDeclaration(
  mode: keyof typeof neutralCheckedTokens,
  selector: string,
  property: string,
): string {
  let value = ''
  for (const rule of activeThemeRules(mode)) {
    if (!selectorListIncludes(rule, selector)) continue
    const candidate = rule.style.getPropertyValue(property).trim()
    if (candidate) value = candidate
  }
  if (!value) throw new Error(`Missing ${mode} ${selector} ${property}`)
  return value
}

function themeCustomProperties(mode: keyof typeof neutralCheckedTokens): ReadonlyMap<string, string> {
  const properties = new Map<string, string>()
  for (const rule of activeThemeRules(mode)) {
    if (rule.selectorText !== '.context-menu-list' && rule.selectorText !== systemDarkMenuSelector) continue
    for (let index = 0; index < rule.style.length; index += 1) {
      const property = rule.style.item(index)
      if (property.startsWith('--')) properties.set(property, rule.style.getPropertyValue(property).trim())
    }
  }
  return properties
}

function resolveThemeVariables(value: string, mode: keyof typeof neutralCheckedTokens): string {
  const properties = themeCustomProperties(mode)
  let resolvedValue = value
  for (let depth = 0; depth < 10; depth += 1) {
    const nextValue = resolvedValue.replace(
      /var\((--[\w-]+)(?:,\s*([^)]*))?\)/g,
      (_match, property: string, fallback?: string) => {
        const resolved = properties.get(property) ?? fallback?.trim()
        if (!resolved) throw new Error(`Missing ${mode} custom property: ${property}`)
        return resolved
      },
    )
    if (nextValue === resolvedValue) return resolvedValue
    resolvedValue = nextValue
  }
  throw new Error(`Circular ${mode} custom property in: ${value}`)
}

function parseCssColor(declaration: string): CssColor {
  const colorMix = declaration.match(
    /color-mix\(in srgb,\s*(#[\da-f]{3,8}\b|rgba?\([^)]*\))\s+([\d.]+)%,\s*(#[\da-f]{3,8}\b|rgba?\([^)]*\))\s+([\d.]+)%\s*\)/i,
  )
  if (colorMix) {
    const first = parseCssColor(colorMix[1]!)
    const firstWeight = Number.parseFloat(colorMix[2]!)
    const second = parseCssColor(colorMix[3]!)
    const secondWeight = Number.parseFloat(colorMix[4]!)
    const totalWeight = firstWeight + secondWeight
    if (first.alpha !== 1 || second.alpha !== 1 || Math.abs(totalWeight - 100) > 0.001) {
      throw new Error(`Unsupported color mix: ${colorMix[0]}`)
    }
    const mix = (firstChannel: number, secondChannel: number) => (
      (firstChannel * firstWeight + secondChannel * secondWeight) / totalWeight
    )
    return {
      red: mix(first.red, second.red),
      green: mix(first.green, second.green),
      blue: mix(first.blue, second.blue),
      alpha: 1,
    }
  }

  const color = declaration.match(/#[\da-f]{3,8}\b|rgba?\([^)]*\)/i)?.[0]
  if (!color) throw new Error(`Missing CSS color in: ${declaration}`)

  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const expanded = hex.length === 3
      ? Array.from(hex, (digit) => `${digit}${digit}`).join('')
      : hex
    if (expanded.length !== 6) throw new Error(`Unsupported hex color: ${color}`)
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
      alpha: 1,
    }
  }

  const body = color.slice(color.indexOf('(') + 1, -1).trim()
  const commaParts = body.split(',').map((part) => part.trim())
  const [channelText, alphaText] = commaParts.length >= 3
    ? [commaParts.slice(0, 3).join(' '), commaParts[3]]
    : body.split(/\s*\/\s*/, 2)
  const channels = channelText.split(/\s+/).map(Number)
  if (channels.length !== 3 || channels.some(Number.isNaN)) {
    throw new Error(`Unsupported rgb color: ${color}`)
  }
  const alpha = alphaText === undefined
    ? 1
    : alphaText.endsWith('%')
      ? Number.parseFloat(alphaText) / 100
      : Number.parseFloat(alphaText)
  if (Number.isNaN(alpha)) throw new Error(`Unsupported alpha channel: ${color}`)
  return { red: channels[0]!, green: channels[1]!, blue: channels[2]!, alpha }
}

function themedColor(
  mode: keyof typeof neutralCheckedTokens,
  selector: string,
  property: string,
): CssColor {
  return parseCssColor(resolveThemeVariables(themeDeclaration(mode, selector, property), mode))
}

function composite(foreground: CssColor, background: CssColor): CssColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha)
  const channel = (foregroundValue: number, backgroundValue: number) => (
    (foregroundValue * foreground.alpha
      + backgroundValue * background.alpha * (1 - foreground.alpha)) / alpha
  )
  return {
    red: channel(foreground.red, background.red),
    green: channel(foreground.green, background.green),
    blue: channel(foreground.blue, background.blue),
    alpha,
  }
}

function relativeLuminance(color: CssColor): number {
  const linear = (channel: number) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
}

function contrast(first: CssColor, second: CssColor): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((left, right) => right - left)
  return (lighter! + 0.05) / (darker! + 0.05)
}

function opaqueChannels(color: CssColor): readonly number[] {
  if (color.alpha !== 1) throw new Error('Expected an opaque composed color')
  return [color.red, color.green, color.blue]
}

function composedMenuPalette(mode: keyof typeof neutralCheckedTokens): MenuPalette {
  const surface = themedColor(mode, '.context-menu-list', 'background')
  const gridSurface = composite(
    themedColor(mode, '.context-menu-grid .context-menu-icon-command', 'background'),
    surface,
  )
  const selectedSurface = composite(
    themedColor(mode, '.context-menu-grid .context-menu-checked-neutral-surface', 'background'),
    surface,
  )

  return {
    surface,
    foreground: composite(themedColor(mode, '.context-menu-list', 'color'), surface),
    border: composite(themedColor(mode, '.context-menu-list', 'border'), surface),
    icon: composite(themedColor(mode, '.context-menu-icon', 'color'), surface),
    defaultCheckIndicator: composite(
      themedColor(mode, '.context-menu-check-indicator', 'color'),
      surface,
    ),
    paragraphSelectedIcon: composite(
      themedColor(
        mode,
        '.context-menu-command.context-menu-accent-icon:not(.context-menu-icon-command) .context-menu-icon',
        'color',
      ),
      surface,
    ),
    themeText: composite(
      themedColor(mode, '.context-menu-checked-theme-text', 'color'),
      surface,
    ),
    shortcut: composite(themedColor(mode, '.context-menu-shortcut', 'color'), surface),
    gridSurface,
    gridBorder: composite(
      themedColor(mode, '.context-menu-grid .context-menu-icon-command', 'border'),
      gridSurface,
    ),
    selectedSurface,
    selectedBorder: composite(
      themedColor(mode, '.context-menu-grid .context-menu-checked-neutral-surface', 'border-color'),
      selectedSurface,
    ),
    selectedIcon: composite(
      themedColor(
        mode,
        '.context-menu-grid .context-menu-checked-neutral-surface .context-menu-icon',
        'color',
      ),
      selectedSurface,
    ),
  }
}


function Harness({
  execute,
  restoreFocus,
}: {
  execute: (id: string) => void
  restoreFocus: () => void
}) {
  const menu = useContextMenu()
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <button
      ref={buttonRef}
      onClick={() => menu.openMenu({
        x: 40,
        y: 50,
        execute,
        restoreFocus,
        items: [
          { kind: 'command', id: 'search', label: '使用默认浏览器搜索' },
          { kind: 'separator', id: 'search-separator' },
          { kind: 'command', id: 'copy', label: '复制', shortcut: 'Ctrl+C' },
          {
            kind: 'submenu',
            id: 'paragraph',
            label: '段落',
            items: [
              { kind: 'command', id: 'body', label: '正文' },
              { kind: 'separator', id: 'paragraph-separator' },
              { kind: 'command', id: 'heading-1', label: '一级标题' },
            ],
          },
          {
            kind: 'command',
            id: 'delete',
            label: '删除',
            disabled: true,
            disabledReason: '没有可删除的内容',
          },
        ],
      })}
    >
      打开菜单
    </button>
  )
}


function NonAutoFocusHarness({ onReady }: { onReady?: () => void }) {
  const [open, setOpen] = useState(false)
  const request: ContextMenuRequest = {
    x: 10,
    y: 10,
    autoFocus: false,
    execute: () => undefined,
    restoreFocus: () => undefined,
    items: [{ kind: 'command', id: 'copy', label: 'Copy' }],
  }
  return (
    <>
      <button data-testid="focus-owner" onClick={() => setOpen(true)}>Open without focus</button>
      {open && <ContextMenu request={request} close={() => setOpen(false)} onReady={onReady} />}
    </>
  )
}

function CompactColorHarness() {
  const menu = useContextMenu()
  return (
    <button onClick={() => menu.openMenu({
      x: 10,
      y: 10,
      widthCssPx: 200,
      submenuWidthCssPx: 300,
      rootIconGutter: 'none',
      execute: () => undefined,
      restoreFocus: () => undefined,
      items: [
        { kind: 'command', id: 'copy', label: 'Copy' },
        {
          kind: 'submenu',
          id: 'colors',
          label: 'Colors',
          items: [{
            kind: 'command', id: 'yellow', label: 'Yellow', swatchColor: '#FFF3B3',
            checked: true, checkedAppearance: 'theme-text',
          }],
        },
      ],
    })}>
      Open compact color menu
    </button>
  )
}
function IconHarness() {
  const menu = useContextMenu()
  return (
    <button
      onClick={() => menu.openMenu({
        x: 40,
        y: 50,
        execute: () => undefined,
        restoreFocus: () => undefined,
        items: buildVisualEditorMenu({
          kind: 'text',
          selectionText: '测试',
        }),
      })}
    >
      打开图标菜单
    </button>
  )
}

function IconChoiceHarness() {
  const menu = useContextMenu()
  return (
    <button
      onClick={() => menu.openMenu({
        x: 40,
        y: 50,
        execute: () => undefined,
        restoreFocus: () => undefined,
        items: [{
          kind: 'submenu',
          id: 'alignment',
          label: 'Alignment',
          items: [
            {
              kind: 'command',
              id: 'left',
              label: 'Left',
              icon: 'L',
              iconChoice: true,
              checked: false,
            },
            {
              kind: 'command',
              id: 'center',
              label: 'Center',
              icon: 'C',
              iconChoice: true,
              checked: true,
            },
            {
              kind: 'command',
              id: 'right',
              label: 'Right',
              icon: 'R',
              iconChoice: true,
              checked: false,
            },
          ],
        }],
      })}
    >
      Open alignment menu
    </button>
  )
}

let tooltipMenuController: ReturnType<typeof useContextMenu> | null = null

function TooltipMenuHarness({ execute }: { execute: (id: string) => void }) {
  const menu = useContextMenu()
  tooltipMenuController = menu
  return (
    <button onClick={() => menu.openMenu({
      x: 120,
      y: 100,
      autoFocus: false,
      execute,
      restoreFocus: () => undefined,
      items: [
        { kind: 'command', id: 'ordinary', label: '普通命令' },
        {
          kind: 'command',
          id: 'paste-plain',
          label: '粘贴为纯文本',
          tooltip: '仅粘贴文字，不解析 Markdown 或 HTML 格式',
        },
        {
          kind: 'command',
          id: 'paste-html-disabled',
          label: '粘贴为 HTML',
          disabled: true,
          disabledReason: '剪贴板中没有 HTML 格式',
          tooltip: '读取并转换剪贴板中的 HTML 格式',
        },
        {
          kind: 'icon-grid',
          id: 'editing',
          columns: 3,
          items: [
            { kind: 'command', id: 'bold', label: '加粗', shortcut: 'Ctrl+B', icon: <b>B</b> },
            {
              kind: 'command',
              id: 'disabled-paste',
              label: '粘贴',
              icon: <b>P</b>,
              disabled: true,
              disabledReason: '没有可粘贴的内容',
              disabledTooltip: '剪贴板中没有可粘贴的内容',
            },
            { kind: 'command', id: 'italic', label: '斜体', icon: <i>I</i> },
          ],
        },
        {
          kind: 'submenu',
          id: 'more',
          label: '更多',
          items: [{
            kind: 'icon-grid',
            id: 'submenu-editing',
            columns: 1,
            items: [{ kind: 'command', id: 'underline', label: '下划线', icon: <u>U</u> }],
          }],
        },
      ],
    })}>
      打开 Tips 菜单
    </button>
  )
}

function renderTooltipMenu(execute = vi.fn()) {
  tooltipMenuController = null
  render(
    <TooltipProvider>
      <ContextMenuProvider>
        <TooltipMenuHarness execute={execute} />
      </ContextMenuProvider>
    </TooltipProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '打开 Tips 菜单' }))
  return { execute }
}

function sendFocusedSelectAll(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: 'a',
  })
  document.activeElement?.dispatchEvent(event)
  return event
}

describe('ContextMenuProvider', () => {
  it('restarts a same-position request without retaining the previous submenu', () => {
    const execute = vi.fn()
    render(<ContextMenuProvider><Harness execute={execute} restoreFocus={vi.fn()} /></ContextMenuProvider>)
    const trigger = screen.getByRole('button', { name: '打开菜单' })
    fireEvent.click(trigger)
    const previous = screen.getByRole('menu')
    fireEvent.click(screen.getByRole('menuitem', { name: '段落' }))
    expect(screen.getAllByRole('menu')).toHaveLength(2)

    // Programmatic / keyboard reopening need not produce an outside pointerdown.
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu')).not.toBe(previous)
    expect(previous).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }))
    expect(execute).toHaveBeenCalledExactlyOnceWith('copy')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps shared root and submenu hairlines, focus, and node identity through DPR signals', () => {
    const dprDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    const visualViewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')
    const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver')
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const originalBounds = HTMLElement.prototype.getBoundingClientRect
    const resolutionListeners = new Set<(event: MediaQueryListEvent) => void>()
    const resizeCallbacks: ResizeObserverCallback[] = []
    const visualViewport = new EventTarget()

    class HairlineResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    let currentDpr = 1.5
    let currentTop = 20.2
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => currentDpr,
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    })
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: HairlineResizeObserver,
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: '',
        onchange: null,
        addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (type === 'change') resolutionListeners.add(listener)
        },
        removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (type === 'change') resolutionListeners.delete(listener)
        },
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      }) as unknown as MediaQueryList),
    })
    HTMLElement.prototype.getBoundingClientRect = function getBounds() {
      if (this.classList.contains('menu-hairline')) {
        return {
          x: 0, y: currentTop, left: 0, top: currentTop, right: 120, bottom: currentTop + 1,
          width: 120, height: 1, toJSON: () => ({}),
        } as DOMRect
      }
      return originalBounds.call(this)
    }

    try {
      const view = render(
        <ContextMenuProvider>
          <Harness execute={() => undefined} restoreFocus={() => undefined} />
        </ContextMenuProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '段落' }).parentElement!)

      const root = screen.getAllByRole('menu').find((menu) => !menu.classList.contains('context-menu-submenu'))!
      const submenu = screen.getAllByRole('menu').find((menu) => menu.classList.contains('context-menu-submenu'))!
      const rootSeparator = root.querySelector<HTMLElement>(':scope > .context-menu-separator')!
      const submenuSeparator = submenu.querySelector<HTMLElement>(':scope > .context-menu-separator')!
      const rootStroke = rootSeparator.querySelector<HTMLElement>('.menu-hairline-stroke')!
      const submenuStroke = submenuSeparator.querySelector<HTMLElement>('.menu-hairline-stroke')!
      const focused = screen.getByRole('menuitem', { name: '正文' })
      focused.focus()
      const expectPreservedGeometry = () => {
        const thickness = getMenuHairlineThicknessCssPx(currentDpr)
        const edgeOffset = getMenuHairlineOffsetCssPx(currentTop, currentDpr)
        const transform = `translateY(${edgeOffset + (thickness - 1) / 2}px) scaleY(${thickness})`

        expect(screen.getAllByRole('menu')).toEqual([root, submenu])
        expect(root.querySelector(':scope > .context-menu-separator')).toBe(rootSeparator)
        expect(submenu.querySelector(':scope > .context-menu-separator')).toBe(submenuSeparator)
        expect(screen.getByRole('menuitem', { name: '段落' })).toHaveAttribute('aria-expanded', 'true')
        expect(focused).toHaveFocus()
        expect(rootStroke.style.height).toBe('1px')
        expect(submenuStroke.style.height).toBe('1px')
        expect(rootStroke.style.transform).toBe(transform)
        expect(submenuStroke.style.transform).toBe(transform)
      }

      expect(rootSeparator).toHaveClass('menu-hairline')
      expect(submenuSeparator).toHaveClass('menu-hairline')
      expect(rootSeparator.querySelectorAll('.menu-hairline-stroke')).toHaveLength(1)
      expect(submenuSeparator.querySelectorAll('.menu-hairline-stroke')).toHaveLength(1)
      expect(rootStroke.style.height).toBe('1px')
      expect(submenuStroke.style.height).toBe('1px')
      expect(rootStroke.style.transform).toContain(`scaleY(${2 / 3})`)
      expect(submenuStroke.style.transform).toContain(`scaleY(${2 / 3})`)
      expectPreservedGeometry()

      currentDpr = 2
      currentTop = 21.3
      act(() => window.dispatchEvent(new Event('resize')))
      expectPreservedGeometry()

      currentDpr = 1.25
      currentTop = 22.4
      act(() => visualViewport.dispatchEvent(new Event('resize')))
      expectPreservedGeometry()

      currentDpr = 1.5
      currentTop = 23.55
      act(() => [...resolutionListeners].forEach((listener) => (
        listener(new Event('change') as MediaQueryListEvent)
      )))
      expectPreservedGeometry()

      currentDpr = 2
      currentTop = 24.7
      act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)))
      expectPreservedGeometry()

      const callbacksAfterDetach = [...resizeCallbacks]
      view.unmount()
      expect(() => callbacksAfterDetach.forEach((callback) => (
        callback([], {} as ResizeObserver)
      ))).not.toThrow()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds
      if (dprDescriptor) Object.defineProperty(window, 'devicePixelRatio', dprDescriptor)
      if (visualViewportDescriptor) Object.defineProperty(window, 'visualViewport', visualViewportDescriptor)
      else Reflect.deleteProperty(window, 'visualViewport')
      if (resizeObserverDescriptor) Object.defineProperty(window, 'ResizeObserver', resizeObserverDescriptor)
      else Reflect.deleteProperty(window, 'ResizeObserver')
      if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('re-snaps the retained separator after a position-only menu render', () => {
    const dprDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    const originalBounds = HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    HTMLElement.prototype.getBoundingClientRect = function getBounds() {
      if (this.classList.contains('context-menu-list')) {
        return {
          x: 0, y: 0, left: 0, top: 0, right: 180, bottom: 100,
          width: 180, height: 100, toJSON: () => ({}),
        } as DOMRect
      }
      if (this.classList.contains('menu-hairline')) {
        const menuTop = Number.parseFloat(
          this.closest<HTMLElement>('.context-menu-list')?.style.top ?? '0',
        )
        const top = menuTop + 0.2
        return {
          x: 0, y: top, left: 0, top, right: 100, bottom: top + 1,
          width: 100, height: 1, toJSON: () => ({}),
        } as DOMRect
      }
      return originalBounds.call(this)
    }

    const request = (y: number): ContextMenuRequest => ({
      x: 10,
      y,
      execute: () => undefined,
      restoreFocus: () => undefined,
      items: [
        { kind: 'command', id: 'before', label: 'Before' },
        { kind: 'separator', id: 'retained-separator' },
        { kind: 'command', id: 'after', label: 'After' },
      ],
    })

    try {
      const view = render(<ContextMenu close={() => undefined} request={request(10)} />)
      const separator = screen.getByRole('separator')
      const stroke = separator.querySelector<HTMLElement>('.menu-hairline-stroke')!
      expect(Number.parseFloat(stroke.style.transform.slice('translateY('.length))).toBeCloseTo(-0.45, 10)

      view.rerender(<ContextMenu close={() => undefined} request={request(10.4)} />)

      expect(screen.getByRole('separator')).toBe(separator)
      expect(Number.parseFloat(stroke.style.transform.slice('translateY('.length))).toBeCloseTo(-0.35, 10)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds
      if (dprDescriptor) Object.defineProperty(window, 'devicePixelRatio', dprDescriptor)
    }
  })

  it('renders selected command state with the unified check icon', () => {
    render(<ContextMenu
      close={vi.fn()}
      request={{
        x: 10,
        y: 10,
        execute: vi.fn(),
        restoreFocus: vi.fn(),
        items: [{ kind: 'command', id: 'compact', label: '压缩行间距', checked: true }],
      }}
    />)

    const selected = screen.getByRole('menuitemcheckbox', { name: '压缩行间距' })
    expect(selected.querySelector('.context-menu-check-indicator .app-icon')).toBeInTheDocument()
    expect(selected).not.toHaveTextContent('✓')
    expect(selected).not.toHaveClass('context-menu-checked-neutral-surface')
  })

  it('aligns active more-format checks with the clear-format icon slot', () => {
    const items = buildVisualEditorMenu({
      kind: 'text',
      selectionText: '测试',
      activeInlineFormats: {
        strike: 'on',
        underline: 'off',
        highlight: 'off',
        superscript: 'off',
        subscript: 'off',
      },
    })
    render(<ContextMenu
      close={vi.fn()}
      request={{ x: 10, y: 10, execute: vi.fn(), restoreFocus: vi.fn(), items }}
    />)

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '更多格式' }).parentElement!)
    const active = screen.getByRole('menuitemcheckbox', { name: '删除线' })
    const clear = screen.getByRole('menuitem', { name: '清除格式' })
    const check = active.querySelector<HTMLElement>('.context-menu-check-indicator')!
    const clearIcon = clear.querySelector<HTMLElement>('.context-menu-icon')!

    expect(active).toHaveAttribute('aria-checked', 'true')
    expect(check).toHaveClass('context-menu-icon')
    expect(getComputedStyle(check).gridColumn).toBe(getComputedStyle(clearIcon).gridColumn)
    expect(getComputedStyle(check).transform).toBe(getComputedStyle(clearIcon).transform)
  })

  it('uses legal checked roles while ordinary commands remain menu items', () => {
    render(<ContextMenu
      close={vi.fn()}
      request={{
        x: 10,
        y: 10,
        execute: vi.fn(),
        restoreFocus: vi.fn(),
        items: [{
          kind: 'icon-grid',
          id: 'semantic-state',
          columns: 5,
          items: [
            { kind: 'command', id: 'plain', label: '普通图标', icon: 'P' },
            { kind: 'command', id: 'toggle-off', label: '关闭切换', icon: 'O', checked: false },
            { kind: 'command', id: 'toggle-on', label: '开启切换', icon: 'N', checked: true },
            { kind: 'command', id: 'choice-off', label: '未选选项', icon: 'L', iconChoice: true, checked: false },
            { kind: 'command', id: 'choice-on', label: '已选选项', icon: 'R', iconChoice: true, checked: true },
          ],
        }],
      }}
    />)

    expect(screen.getByRole('menuitem', { name: '普通图标' }))
      .not.toHaveAttribute('aria-checked')
    expect(screen.getByRole('menuitemcheckbox', { name: '关闭切换' }))
      .toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('menuitemcheckbox', { name: '开启切换' }))
      .toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: '未选选项' }))
      .toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('menuitemradio', { name: '已选选项' }))
      .toHaveAttribute('aria-checked', 'true')
  })

  it('renders list icon buttons with an explicit neutral checked surface', () => {
    const items = buildVisualEditorMenu({
      kind: 'text',
      selectionText: '',
      activeBlocks: {
        blockquote: false,
        codeBlock: false,
        bulletList: true,
        orderedList: true,
        taskList: true,
        paragraphStyle: 'paragraph',
      },
    })
    render(<ContextMenu
      close={vi.fn()}
      request={{
        x: 10,
        y: 10,
        execute: vi.fn(),
        restoreFocus: vi.fn(),
        items,
      }}
    />)

    for (const label of ['有序列表', '无序列表', '任务列表']) {
      const button = screen.getByRole('menuitemcheckbox', { name: label })
      expect(button).toHaveClass('context-menu-checked-neutral-surface')
      expect(button).not.toHaveClass('context-menu-checked-theme-text')
      expect(button).not.toHaveClass('context-menu-checked')
    }
  })

  it('maps reusable neutral checked tokens to light gray and dark translucent-white surfaces', () => {
    const rules = contextMenuStyle.sheet?.cssRules
    if (!rules) throw new Error('Context-menu stylesheet was not loaded')
    const light = styleRule(rules, '.context-menu-list')
    const darkMedia = Array.from(rules).find((rule): rule is CSSMediaRule => (
      rule instanceof CSSMediaRule && rule.conditionText === '(prefers-color-scheme: dark)'
    ))
    if (!darkMedia) throw new Error('Missing dark context-menu token mapping')
    const dark = styleRule(darkMedia.cssRules, systemDarkMenuSelector)

    for (const [token, value] of Object.entries(neutralCheckedTokens.light)) {
      expect(normalizedCssValue(light.style.getPropertyValue(token)))
        .toBe(normalizedCssValue(value))
    }
    for (const [token, value] of Object.entries(neutralCheckedTokens.dark)) {
      expect(normalizedCssValue(dark.style.getPropertyValue(token)))
        .toBe(normalizedCssValue(value))
    }
  })

  it('preserves the existing light menu palette after final color composition', () => {
    const palette = composedMenuPalette('light')

    expect(opaqueChannels(palette.surface)).toEqual([255, 255, 255])
    expect(opaqueChannels(palette.foreground)).toEqual([61, 61, 61])
    expect(opaqueChannels(palette.border)).toEqual([230, 230, 230])
    expect(opaqueChannels(palette.icon)).toEqual([68, 68, 68])
    expect(palette.defaultCheckIndicator.alpha).toBe(1)
    expect(palette.defaultCheckIndicator.red).toBeCloseTo(209.4, 10)
    expect(palette.defaultCheckIndicator.green).toBeCloseTo(83, 10)
    expect(palette.defaultCheckIndicator.blue).toBeCloseTo(83, 10)
    expect(palette.paragraphSelectedIcon.alpha).toBe(1)
    expect(palette.paragraphSelectedIcon.red).toBeCloseTo(209.4, 10)
    expect(palette.paragraphSelectedIcon.green).toBeCloseTo(83, 10)
    expect(palette.paragraphSelectedIcon.blue).toBeCloseTo(83, 10)
    expect(opaqueChannels(palette.themeText)).toEqual([198, 40, 40])
    expect(opaqueChannels(palette.shortcut)).toEqual([136, 136, 136])
    expect(opaqueChannels(palette.gridSurface)).toEqual([250, 251, 252])
    expect(opaqueChannels(palette.gridBorder)).toEqual([223, 227, 231])
    expect(opaqueChannels(palette.selectedSurface)).toEqual([238, 240, 242])
    expect(opaqueChannels(palette.selectedBorder)).toEqual([197, 201, 205])
    expect(opaqueChannels(palette.selectedIcon)).toEqual([68, 68, 68])
  })

  it('keeps the dark default check indicator theme-colored and at least 3:1 against its real surface', () => {
    const palette = composedMenuPalette('dark')

    expect(contrast(palette.defaultCheckIndicator, palette.surface)).toBeGreaterThanOrEqual(3)
    expect(
      palette.defaultCheckIndicator.red
        - Math.max(palette.defaultCheckIndicator.green, palette.defaultCheckIndicator.blue),
    ).toBeGreaterThanOrEqual(40)
  })

  it('keeps the dark paragraph selected icon theme-colored and at least 3:1 against its real surface', () => {
    const palette = composedMenuPalette('dark')

    expect(contrast(palette.paragraphSelectedIcon, palette.surface)).toBeGreaterThanOrEqual(3)
    expect(
      palette.paragraphSelectedIcon.red
        - Math.max(palette.paragraphSelectedIcon.green, palette.paragraphSelectedIcon.blue),
    ).toBeGreaterThanOrEqual(40)
  })

  it('keeps dark theme-text theme-colored and at least 4.5:1 against its real surface', () => {
    const palette = composedMenuPalette('dark')

    expect(contrast(palette.themeText, palette.surface)).toBeGreaterThanOrEqual(4.5)
    expect(palette.themeText.red - Math.max(palette.themeText.green, palette.themeText.blue))
      .toBeGreaterThanOrEqual(40)
  })

  it('composes dark neutral selection and menu controls into distinguishable colors', () => {
    const palette = composedMenuPalette('dark')

    expect(relativeLuminance(palette.surface)).toBeLessThan(0.08)
    expect(contrast(palette.foreground, palette.surface)).toBeGreaterThanOrEqual(7)
    expect(contrast(palette.icon, palette.surface)).toBeGreaterThanOrEqual(7)
    expect(contrast(palette.shortcut, palette.surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(palette.border, palette.surface)).toBeGreaterThanOrEqual(3)
    expect(contrast(palette.gridBorder, palette.gridSurface)).toBeGreaterThanOrEqual(3)
    expect(contrast(palette.selectedSurface, palette.surface)).toBeGreaterThanOrEqual(1.4)
    expect(contrast(palette.selectedBorder, palette.selectedSurface)).toBeGreaterThanOrEqual(2.5)
    expect(contrast(palette.selectedIcon, palette.selectedSurface)).toBeGreaterThanOrEqual(7)
  })

  it.each([
    {
      mode: 'light' as const,
      base: 'rgb(238, 240, 242)',
      hover: 'rgb(229, 232, 235)',
      pressed: 'rgb(217, 221, 225)',
      border: 'rgb(197, 201, 205)',
      inset: 'rgb(0 0 0 / 4%)',
      icon: 'rgb(68, 68, 68)',
    },
    {
      mode: 'dark' as const,
      base: 'rgba(255, 255, 255, 0.12)',
      hover: 'rgba(255, 255, 255, 0.18)',
      pressed: 'rgba(255, 255, 255, 0.24)',
      border: 'rgba(255, 255, 255, 0.32)',
      inset: 'rgb(255 255 255 / 8%)',
      icon: 'rgba(255, 255, 255, 0.92)',
    },
  ])('keeps the $mode neutral checked surface through interaction states', ({
    mode,
    base,
    hover,
    pressed,
    border,
    inset,
    icon,
  }) => {
    const interactiveStyle = document.head.appendChild(document.createElement('style'))
    interactiveStyle.textContent = neutralStateCss(mode)
    const view = render(<ContextMenu
      close={vi.fn()}
      request={{
        x: 10,
        y: 10,
        execute: vi.fn(),
        restoreFocus: vi.fn(),
        items: [{
          kind: 'icon-grid',
          id: 'list-state',
          columns: 1,
          items: [{
            kind: 'command',
            id: 'ordered-list',
            label: '有序列表',
            icon: 'L',
            checked: true,
            checkedAppearance: 'neutral-surface',
          }],
        }],
      }}
    />)

    try {
      const button = screen.getByRole('menuitemcheckbox', { name: '有序列表' })
      const menuIcon = button.querySelector('.context-menu-icon')!
      expect(button).not.toHaveClass('context-menu-checked')
      expect(getComputedStyle(button).backgroundColor).toBe(base)
      expect(getComputedStyle(button).borderColor).toBe(border)
      expect(normalizedCssValue(getComputedStyle(button).boxShadow))
        .toContain(normalizedCssValue(inset))
      expect(getComputedStyle(menuIcon).color).toBe(icon)

      button.dataset.testState = 'hover'
      expect(getComputedStyle(button).backgroundColor).toBe(hover)
      button.dataset.testState = 'focus-visible'
      expect(getComputedStyle(button).backgroundColor).toBe(hover)
      button.dataset.testState = 'active'
      expect(getComputedStyle(button).backgroundColor).toBe(pressed)
    } finally {
      view.unmount()
      interactiveStyle.remove()
    }
  })


  it('does not move DOM focus into a menu when autoFocus is disabled', () => {
    const onReady = vi.fn()
    render(<NonAutoFocusHarness onReady={onReady} />)
    const owner = screen.getByTestId('focus-owner')
    owner.focus()

    fireEvent.click(owner)

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(document.activeElement).toBe(owner)
    expect(screen.getByRole('menu')).not.toHaveStyle({ visibility: 'hidden' })
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('removes only the requested root gutter while preserving submenu swatches', () => {
    render(<ContextMenuProvider><CompactColorHarness /></ContextMenuProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Open compact color menu' }))
    const root = screen.getByRole('menu')
    const rootCommand = screen.getByRole('menuitem', { name: 'Copy' })
    expect(root).toHaveStyle({ width: '200px' })
    expect(root).toHaveClass('context-menu-root-no-icon-gutter')
    expect(getComputedStyle(rootCommand).gridTemplateColumns).toBe('minmax(0, 1fr) auto')
    expect(getComputedStyle(rootCommand.querySelector('.context-menu-label')!).gridColumn).toBe('1')

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Colors' }).parentElement!)
    const submenu = screen.getAllByRole('menu').find((menu) => menu.classList.contains('context-menu-submenu'))!
    const submenuCommand = screen.getByRole('menuitemcheckbox', { name: 'Yellow' })
    const swatch = submenuCommand.querySelector('.context-menu-swatch')!
    expect(submenu).not.toHaveClass('context-menu-root-no-icon-gutter')
    expect(submenu).toHaveStyle({ width: '300px' })
    expect(getComputedStyle(submenuCommand).gridTemplateColumns).toBe('24px minmax(0, 1fr) auto')
    expect(getComputedStyle(swatch).gridColumn).toBe('1')
    expect(swatch).toHaveStyle({ backgroundColor: '#FFF3B3' })
    expect(submenuCommand).toHaveClass('context-menu-checked-theme-text')
    expect(submenuCommand).not.toHaveClass('context-menu-checked')
  })
  it('executes an enabled command and restores focus after closing', () => {
    const execute = vi.fn()
    const restoreFocus = vi.fn()
    render(
      <ContextMenuProvider>
        <Harness execute={execute} restoreFocus={restoreFocus} />
      </ContextMenuProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(getComputedStyle(screen.getByRole('menu')).width).toBe('272px')
    expect(screen.getByRole('menu')).not.toHaveClass('context-menu-root-no-icon-gutter')

    const copy = screen.getByRole('menuitem', { name: '复制' })
    expect(copy).not.toHaveAttribute('data-tooltip')
    fireEvent.click(copy)
    expect(execute).toHaveBeenCalledWith('copy')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(restoreFocus).toHaveBeenCalledOnce()
  })

  it('restores focus before an async command and does not restore again when it settles', async () => {
    const events: string[] = []
    let settle!: () => void
    const execute = vi.fn(() => {
      events.push('execute')
      return new Promise<void>((resolve) => { settle = resolve })
    })
    const restoreFocus = vi.fn(() => { events.push('restore-focus') })
    render(
      <ContextMenuProvider>
        <Harness execute={execute} restoreFocus={restoreFocus} />
      </ContextMenuProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }))

    expect(events).toEqual(['restore-focus', 'execute'])
    settle()
    await Promise.resolve()
    expect(events).toEqual(['restore-focus', 'execute'])
    expect(restoreFocus).toHaveBeenCalledOnce()
  })

  it('does not execute disabled commands and exposes their reason', () => {
    const execute = vi.fn()
    render(
      <ContextMenuProvider>
        <Harness execute={execute} restoreFocus={() => undefined} />
      </ContextMenuProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
    const disabled = screen.getByRole('menuitem', { name: '删除' })
    expect(disabled).toHaveAttribute('aria-disabled', 'true')
    expect(disabled).not.toHaveAttribute('data-tooltip')
    expect(getComputedStyle(disabled).opacity).toBe('0.4')
    expect(getComputedStyle(disabled).pointerEvents).toBe('none')
    fireEvent.click(disabled)
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks browser-wide Ctrl+A from a focused portaled context-menu option', () => {
    const { container } = render(
      <div className="app-shell">
        <ContextMenuProvider>
          <Harness execute={() => undefined} restoreFocus={() => undefined} />
        </ContextMenuProvider>
      </div>,
    )
    const shell = container.querySelector<HTMLElement>('.app-shell')!
    const cleanup = installUiSelectionGuard(shell)
    try {
      window.getSelection()?.removeAllRanges()
      fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
      const option = screen.getByRole('menuitem', { name: '复制' })
      option.focus()
      const event = sendFocusedSelectAll()

      expect(option).toHaveFocus()
      expect(option.closest('.app-shell')).toBeNull()
      expect(event.defaultPrevented).toBe(true)
      expect(window.getSelection()?.toString()).toBe('')
    } finally {
      cleanup()
    }
  })

  it('preserves source-image pixel dimensions across device scaling', () => {
    const originalDevicePixelRatio = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 })
    try {
      render(
        <ContextMenuProvider>
          <IconHarness />
        </ContextMenuProvider>,
      )

      fireEvent.click(screen.getByRole('button', { name: '打开图标菜单' }))
      const expectedSizes = [
        ['加粗', '11.2px', '12.8px'],
        ['斜体', '9.6px', '13.6px'],
        ['代码块', '17.6px', '16px'],
        ['链接', '17.6px', '16px'],
        ['引用', '16px', '12px'],
        ['有序列表', '17.6px', '16.8px'],
        ['无序列表', '17.6px', '14.4px'],
        ['任务列表', '17.6px', '17.6px'],
      ] as const

      for (const [label, width, height] of expectedSizes) {
        const icon = screen.getByRole('menuitem', {
          name: new RegExp(`^${label}`),
        }).querySelector('img')
        expect(icon).toHaveStyle({ width, height })
      }
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value: originalDevicePixelRatio,
      })
    }
  })

  it('renders horizontal rule submenu choices as real lines without visible labels', () => {
    render(
      <ContextMenuProvider>
        <IconHarness />
      </ContextMenuProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开图标菜单' }))
    const insert = screen.getByRole('menuitem', { name: '插入' })
    fireEvent.mouseEnter(insert.parentElement!)

    const horizontalRule = screen.getByRole('menuitem', { name: '水平分割线' })
    fireEvent.mouseEnter(horizontalRule.parentElement!)

    const normal = screen.getByRole('menuitem', { name: '40%黑色' })
    expect(normal.querySelector('.context-menu-label')).toBeNull()
    expect(normal.querySelector('.context-menu-rule-preview')).toHaveStyle({
      backgroundColor: 'rgb(0 0 0 / 40%)',
      height: '2px',
    })

    const quadruple = screen.getByRole('menuitem', { name: '40%黑色四倍高度' })
    expect(quadruple.querySelector('.context-menu-label')).toBeNull()
    expect(quadruple.querySelector('.context-menu-rule-preview')).toHaveStyle({
      backgroundColor: 'rgb(0 0 0 / 40%)',
      height: '8px',
    })

    const blue = screen.getByRole('menuitem', { name: '40%蓝色' })
    expect(blue.querySelector('.context-menu-label')).toBeNull()
    expect(blue.querySelector('.context-menu-rule-preview')).toHaveStyle({
      backgroundColor: 'rgb(37 99 235 / 40%)',
      height: '2px',
    })
  })

  it('shows icon-choice state through icon opacity without a checkmark class', () => {
    render(
      <ContextMenuProvider>
        <IconChoiceHarness />
      </ContextMenuProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open alignment menu' }))
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Alignment' }).parentElement!)

    const left = screen.getByRole('menuitemradio', { name: 'Left' })
    const center = screen.getByRole('menuitemradio', { name: 'Center' })
    const right = screen.getByRole('menuitemradio', { name: 'Right' })

    expect(left).toHaveAttribute('aria-checked', 'false')
    expect(center).toHaveAttribute('aria-checked', 'true')
    expect(right).toHaveAttribute('aria-checked', 'false')
    expect(center).not.toHaveClass('context-menu-checked')
    expect(getComputedStyle(left.querySelector('.context-menu-icon')!).opacity).toBe('0.5')
    expect(getComputedStyle(center.querySelector('.context-menu-icon')!).opacity).toBe('1')
    expect(getComputedStyle(right.querySelector('.context-menu-icon')!).opacity).toBe('0.5')
  })

  it('opens a submenu with keyboard navigation and closes on Escape', () => {
    const restoreFocus = vi.fn()
    render(
      <ContextMenuProvider>
        <Harness execute={() => undefined} restoreFocus={restoreFocus} />
      </ContextMenuProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
    const paragraph = screen.getByRole('menuitem', { name: '段落' })
    paragraph.focus()
    fireEvent.keyDown(paragraph, { key: 'ArrowRight' })
    expect(screen.getByRole('menuitem', { name: '正文' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(restoreFocus).toHaveBeenCalledOnce()
  })

  it('closes when the pointer is pressed outside', () => {
    render(
      <ContextMenuProvider>
        <Harness execute={() => undefined} restoreFocus={() => undefined} />
        <div data-testid="outside">外部</div>
      </ContextMenuProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
    fireEvent.pointerDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('positions the measured menu at the mouse and keeps it inside the viewport', () => {
    const original = HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 220 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 180 })
    HTMLElement.prototype.getBoundingClientRect = function getBounds() {
      if (this.classList.contains('context-menu-list')) {
        return {
          x: 0, y: 0, left: 0, top: 0, right: 180, bottom: 140,
          width: 180, height: 140, toJSON: () => ({}),
        } as DOMRect
      }
      return original.call(this)
    }
    try {
      render(
        <ContextMenuProvider>
          <Harness execute={() => undefined} restoreFocus={() => undefined} />
        </ContextMenuProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
      expect(screen.getByRole('menu')).toHaveStyle({ left: '32px', top: '32px' })
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original
    }
  })

  it('positions a long submenu from its measured bounds near the viewport bottom', () => {
    const original = HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 })
    HTMLElement.prototype.getBoundingClientRect = function getBounds() {
      if (this.classList.contains('context-menu-submenu')) {
        return {
          x: 0, y: 0, left: 0, top: 0, right: 180, bottom: 60,
          width: 180, height: 60, toJSON: () => ({}),
        } as DOMRect
      }
      if (this.classList.contains('context-menu-list')) {
        return {
          x: 0, y: 0, left: 0, top: 0, right: 180, bottom: 140,
          width: 180, height: 140, toJSON: () => ({}),
        } as DOMRect
      }
      if (this.classList.contains('context-menu-command')) {
        return {
          x: 20, y: 170, left: 20, top: 170, right: 120, bottom: 200,
          width: 100, height: 30, toJSON: () => ({}),
        } as DOMRect
      }
      return original.call(this)
    }
    try {
      render(
        <ContextMenuProvider>
          <Harness execute={() => undefined} restoreFocus={() => undefined} />
        </ContextMenuProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
      const paragraph = screen.getByRole('menuitem', { name: '段落' })
      fireEvent.mouseEnter(paragraph.parentElement!)
      const submenu = screen.getAllByRole('menu').find((menu) => menu.classList.contains('context-menu-submenu'))
      expect(submenu).toHaveStyle({ left: '120px', top: '132px' })
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original
    }
  })

  it('closes a submenu immediately after the pointer leaves its hover region', () => {
    vi.useFakeTimers()
    render(
      <ContextMenuProvider>
        <Harness execute={() => undefined} restoreFocus={() => undefined} />
      </ContextMenuProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }))
    const paragraph = screen.getByRole('menuitem', { name: '段落' })
    fireEvent.mouseEnter(paragraph.parentElement!)
    expect(screen.getByRole('menuitem', { name: '正文' })).toBeInTheDocument()
    const child = screen.getByRole('menuitem', { name: '正文' })
    const submenu = child.closest('[role="menu"]')!
    fireEvent.mouseLeave(paragraph.parentElement!, { relatedTarget: child })
    expect(child).toBeInTheDocument()
    fireEvent.mouseLeave(submenu, { relatedTarget: paragraph })
    expect(child).toBeInTheDocument()
    fireEvent.mouseLeave(paragraph.parentElement!)
    expect(screen.queryByRole('menuitem', { name: '正文' })).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})

describe('ContextMenu tooltips', () => {
  it('keeps ordinary rows quiet while preserving explicit paste-format explanations', () => {
    vi.useFakeTimers()
    try {
      renderTooltipMenu()
      const ordinary = screen.getByRole('menuitem', { name: '普通命令' })
      const explicitPaste = screen.getByRole('menuitem', { name: '粘贴为纯文本' })

      expect(ordinary).not.toHaveAttribute('data-tooltip')
      fireEvent.pointerOver(ordinary)
      act(() => vi.advanceTimersByTime(400))
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

      expect(explicitPaste).toHaveAttribute(
        'data-tooltip',
        '仅粘贴文字，不解析 Markdown 或 HTML 格式',
      )
      fireEvent.pointerOver(explicitPaste)
      act(() => vi.advanceTimersByTime(400))
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        '仅粘贴文字，不解析 Markdown 或 HTML 格式',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('reveals an explicit explanation for a disabled ordinary row without enabling it', () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn()
      renderTooltipMenu(execute)
      const disabled = screen.getByRole('menuitem', { name: '粘贴为 HTML' })

      expect(disabled).toBeDisabled()
      expect(disabled).toHaveAttribute('data-tooltip', '剪贴板中没有 HTML 格式')
      expect(getComputedStyle(disabled).pointerEvents).toBe('auto')

      fireEvent.pointerOver(disabled)
      act(() => vi.advanceTimersByTime(399))
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('tooltip')).toHaveTextContent('剪贴板中没有 HTML 格式')

      fireEvent.pointerDown(disabled)
      fireEvent.pointerUp(disabled)
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      expect(execute).not.toHaveBeenCalled()
      expect(disabled).toBeDisabled()
      disabled.focus()
      expect(disabled).not.toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delays icon hover for 400ms and shows keyboard focus immediately', () => {
    vi.useFakeTimers()
    try {
      renderTooltipMenu()
      const bold = screen.getByRole('menuitem', { name: '加粗' })
      fireEvent.pointerOver(bold)
      act(() => vi.advanceTimersByTime(399))
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      act(() => vi.advanceTimersByTime(1))
      expect(screen.getByRole('tooltip')).toHaveTextContent('加粗（Ctrl+B）')
      expect(screen.getByRole('tooltip')).toHaveAttribute(
        'data-tooltip-layer',
        'context-menu',
      )

      fireEvent.pointerOut(bold, { relatedTarget: null })
      const italic = screen.getByRole('menuitem', { name: '斜体' })
      fireEvent.focusIn(italic)
      expect(screen.getByRole('tooltip')).toHaveTextContent('斜体')
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses a disabled icon reason on press without changing disabled semantics', () => {
    vi.useFakeTimers()
    try {
      const execute = vi.fn()
      renderTooltipMenu(execute)
      const bold = screen.getByRole('menuitem', { name: '加粗' })
      const disabled = screen.getByRole('menuitem', { name: '粘贴' })

      fireEvent.pointerOver(disabled)
      act(() => vi.advanceTimersByTime(400))
      expect(screen.getByRole('tooltip')).toHaveTextContent('剪贴板中没有可粘贴的内容')
      fireEvent.pointerDown(disabled)
      fireEvent.pointerUp(disabled)

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      expect(execute).not.toHaveBeenCalled()
      expect(disabled).toBeDisabled()
      expect(disabled).not.toHaveFocus()

      bold.focus()
      fireEvent.keyDown(bold, { key: 'ArrowDown' })
      expect(screen.getByRole('menuitem', { name: '斜体' })).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['controller close', () => tooltipMenuController?.closeMenu()],
    ['request replacement', () => tooltipMenuController?.openMenu({
      x: 20,
      y: 20,
      autoFocus: false,
      execute: () => undefined,
      restoreFocus: () => undefined,
      items: [{ kind: 'command', id: 'replacement', label: '替换菜单' }],
    })],
  ] as const)('cleans up the tooltip on %s', (_label, dismiss) => {
    vi.useFakeTimers()
    try {
      renderTooltipMenu()
      fireEvent.pointerOver(screen.getByRole('menuitem', { name: '加粗' }))
      act(() => vi.advanceTimersByTime(400))
      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      act(() => dismiss())
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['click', () => fireEvent.click(document.body)],
    ['scroll', () => fireEvent.scroll(window)],
  ] as const)('cleans up the tooltip on %s', (_label, dismiss) => {
    vi.useFakeTimers()
    try {
      renderTooltipMenu()
      fireEvent.pointerOver(screen.getByRole('menuitem', { name: '加粗' }))
      act(() => vi.advanceTimersByTime(400))
      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      dismiss()
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a measured submenu tooltip inside the viewport and outside every visible menu', () => {
    vi.useFakeTimers()
    const originalBounds = HTMLElement.prototype.getBoundingClientRect
    const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const heightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 480 })
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect
    const rootRect = rect(120, 100, 272, 260)
    const submenuRect = rect(392, 130, 200, 180)
    HTMLElement.prototype.getBoundingClientRect = function getBounds() {
      if (this.classList.contains('global-tooltip')) return rect(0, 0, 160, 32)
      if (this.classList.contains('context-menu-submenu')) return submenuRect
      if (this.classList.contains('context-menu-list')) return rootRect
      if (this.getAttribute('aria-label') === '更多') return rect(136, 280, 240, 30)
      if (this.getAttribute('aria-label') === '下划线') return rect(420, 170, 80, 25)
      return originalBounds.call(this)
    }
    const intersects = (
      left: number,
      top: number,
      width: number,
      height: number,
      obstacle: DOMRect,
    ) => left < obstacle.right
      && left + width > obstacle.left
      && top < obstacle.bottom
      && top + height > obstacle.top

    try {
      renderTooltipMenu()
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '更多' }).parentElement!)
      const underline = screen.getByRole('menuitem', { name: '下划线' })
      fireEvent.pointerOver(underline)
      act(() => vi.advanceTimersByTime(400))

      const tooltip = screen.getByRole('tooltip')
      const left = Number.parseFloat(tooltip.style.left)
      const top = Number.parseFloat(tooltip.style.top)
      expect(left).toBeGreaterThanOrEqual(8)
      expect(top).toBeGreaterThanOrEqual(8)
      expect(left + 160).toBeLessThanOrEqual(632)
      expect(top + 32).toBeLessThanOrEqual(472)
      expect(intersects(left, top, 160, 32, rootRect)).toBe(false)
      expect(intersects(left, top, 160, 32, submenuRect)).toBe(false)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds
      if (widthDescriptor) Object.defineProperty(window, 'innerWidth', widthDescriptor)
      if (heightDescriptor) Object.defineProperty(window, 'innerHeight', heightDescriptor)
      vi.useRealTimers()
    }
  })
})
