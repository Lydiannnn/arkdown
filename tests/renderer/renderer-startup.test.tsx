import { act, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

const boundary = vi.hoisted(() => {
  let resolveApp!: () => void
  const appReady = new Promise<void>(resolve => { resolveApp = resolve })
  return { render: vi.fn(), loaded: [] as string[], appReady, resolveApp }
})
vi.mock('react-dom/client', async importOriginal => ({ ...await importOriginal<object>(), createRoot: () => ({ render: boundary.render }) }))
vi.mock('../../src/renderer/app/App', async () => { boundary.loaded.push('app'); await boundary.appReady; return { App: () => <input aria-label="document input" /> } })
vi.mock('../../src/renderer/sticky-notes/StickyNoteWindowRoot', () => { boundary.loaded.push('sticky'); return { StickyNoteWindowRoot: ({ noteId }: { noteId: string }) => <output>sticky:{noteId}</output> } })
vi.mock('../../src/renderer/sticky-notes/ArknoteBoxWindowRoot', () => { boundary.loaded.push('box'); return { ArknoteBoxWindowRoot: () => <output>box</output> } })
vi.mock('../../src/renderer/settings/ArknoteSettingsPage', () => { boundary.loaded.push('settings'); return { ArknoteSettingsPage: () => <output>settings</output> } })
vi.mock('../../src/renderer/context-menu/ExternalContextMenuSurface', () => { boundary.loaded.push('menu'); return { ExternalContextMenuSurface: () => <output>menu</output> } })
vi.mock('../../src/renderer/printing/PrintDocumentSurface', () => { boundary.loaded.push('print'); return { PrintDocumentSurface: ({ token }: { token: string }) => <output>print:{token}</output> } })
vi.mock('../../src/renderer/screenshot/ScreenshotSelectionSurface', () => { boundary.loaded.push('selection'); return { ScreenshotSelectionSurface: ({ sessionId, displayId }: { sessionId: string; displayId: string }) => <output>selection:{sessionId}:{displayId}</output> } })
vi.mock('../../src/renderer/screenshot/ScreenshotTranslationWindow', () => { boundary.loaded.push('screenshot'); return { ScreenshotTranslationWindow: ({ sessionId }: { sessionId: string }) => <output>screenshot:{sessionId}</output> } })
vi.mock('../../src/renderer/backgrounds/BackgroundSettingsSurface', () => { boundary.loaded.push('background'); return { BackgroundSettingsSurface: ({ route }: { route: unknown }) => <output>background:{JSON.stringify(route)}</output> } })
vi.mock('../../src/renderer/components/RuntimeInstallerSurface', () => { boundary.loaded.push('installer'); return { RuntimeInstallerSurface: () => <output>installer</output> } })
vi.mock('../../src/renderer/screen-translation/ScreenTranslationSurface', () => { boundary.loaded.push('screen'); return { ScreenTranslationSurface: () => <output>screen</output> } })
vi.mock('../../src/renderer/tooltip/TooltipProvider', () => ({ TooltipProvider: ({ children }: { children: ReactNode }) => <div data-provider="tooltip">{children}</div> }))
vi.mock('../../src/renderer/context-menu/ContextMenuProvider', () => ({ ContextMenuProvider: ({ children }: { children: ReactNode }) => <div data-provider="context">{children}</div> }))
vi.mock('../../src/renderer/modal/BusinessDialogProvider', () => ({ BusinessDialogProvider: ({ children }: { children: ReactNode }) => <div data-provider="dialog">{children}</div> }))

afterEach(() => { window.dispatchEvent(new Event('unload')); window.history.replaceState({}, '', '/'); vi.resetModules() })
it('renders the root with its persisted theme while model rules are unresolved and imports only the selected surface', async () => {
  window.history.replaceState({}, '', '/?theme=dark')
  const unsubscribe = vi.fn()
  Object.defineProperty(window, 'arkdown', { configurable: true, value: { getModelCapabilityRules: () => new Promise(() => {}), onModelCapabilityRulesChanged: () => unsubscribe } })
  await import('../../src/renderer/main')
  expect(document.documentElement.dataset.arkdownTheme).toBe('dark')
  expect(boundary.loaded).toEqual([])
  expect(boundary.render).toHaveBeenCalledOnce()
  // Inspect the entry boundary without mounting the heavy editor in this routing test.
  const tree = boundary.render.mock.lastCall![0]
  const { createRoot } = await vi.importActual<typeof import('react-dom/client')>('react-dom/client')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(tree))
    expect(screen.getByRole('status', { name: '正在加载' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'document input' })).toBeNull()
    expect(boundary.loaded).toEqual(['app'])
    await act(async () => { boundary.resolveApp(); await boundary.appReady })
    expect(screen.getByRole('textbox', { name: 'document input' })).toBeEnabled()
    expect(boundary.loaded).toEqual(['app'])
    expect(container.querySelector('[data-provider="tooltip"] > [data-provider="context"] input')).not.toBeNull()
    window.dispatchEvent(new Event('unload'))
    expect(unsubscribe).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); container.remove() }
})

it.each([
  ['?surface=runtime-installer', 'installer', []],
  ['?surface=screen-translation', 'screen', []],
  ['?surface=screenshot-translation&sessionId=s1', 'screenshot:s1', ['tooltip']],
  ['?surface=screenshot-selection&sessionId=s2&displayId=d1', 'selection:s2:d1', []],
  ['?surface=print&token=t1', 'print:t1', []],
  ['?surface=sticky-note-context-menu', 'menu', ['tooltip']],
  ['?surface=arknote-box', 'box', ['tooltip', 'dialog', 'context']],
  ['?surface=arknote-settings', 'settings', []],
  ['?surface=background-settings&target=main', 'background:{"target":"main"}', []],
  ['?surface=sticky-note&noteId=123e4567-e89b-42d3-a456-426614174000', 'sticky:123e4567-e89b-42d3-a456-426614174000', ['tooltip', 'dialog']],
  ['?surface=background-settings&target=sticky-note&noteId=123e4567-e89b-42d3-a456-426614174000', 'background:{"noteId":"123e4567-e89b-42d3-a456-426614174000","target":"sticky-note"}', []],
  ['?surface=unknown', 'app', ['tooltip', 'context']],
  ['?surface=sticky-note&noteId=invalid', 'app', ['tooltip', 'context']],
] as const)('preserves route props and providers for %s', async (search, text, providers) => {
  window.history.replaceState({}, '', `/${search}`)
  Object.defineProperty(window, 'arkdown', { configurable: true, value: {} })
  await import('../../src/renderer/main')
  expect(boundary.render).toHaveBeenCalledOnce()
  const { createRoot } = await vi.importActual<typeof import('react-dom/client')>('react-dom/client')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(boundary.render.mock.lastCall![0]))
    expect(text === 'app' ? screen.getByRole('textbox', { name: 'document input' }) : screen.getByText(text)).toBeVisible()
    expect([...container.querySelectorAll('[data-provider]')].map(element => element.getAttribute('data-provider'))).toEqual(providers)
  } finally { act(() => root.unmount()); container.remove() }
})
