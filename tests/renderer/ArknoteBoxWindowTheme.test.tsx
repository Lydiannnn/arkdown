import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ArknoteBoxWindowRoot } from '../../src/renderer/sticky-notes/ArknoteBoxWindowRoot'
import type { ArknoteBoxTheme, ArknoteBoxThemeApi } from '../../src/shared/arknote-box-theme'
vi.mock('../../src/renderer/sticky-notes/StickyNoteBoxPanel', () => ({ StickyNoteBoxPanel: () => <div>box</div> }))
it('follows live dark/light state and does not overwrite an event with an older initial read', async () => {
  let read!: (theme: ArknoteBoxTheme) => void
  let event!: (theme: ArknoteBoxTheme) => void
  const unsubscribe = vi.fn()
  const api: ArknoteBoxThemeApi = { get: () => new Promise(resolve => { read = resolve }), subscribe: listener => { event = listener; return unsubscribe } }
  const target = window as unknown as { arknoteBoxTheme?: ArknoteBoxThemeApi }
  target.arknoteBoxTheme = api
  const mounted = render(<ArknoteBoxWindowRoot />)
  act(() => event({ mode: 'dark', themeColor: '#2563EB' }))
  await act(async () => read({ mode: 'light', themeColor: '#C62828' }))
  expect(document.documentElement.dataset.arkdownTheme).toBe('dark')
  expect(document.documentElement.style.getPropertyValue('--theme-color-rgb')).toBe('37 99 235')
  act(() => event({ mode: 'light', themeColor: '#C62828' }))
  await waitFor(() => expect(document.documentElement.dataset.arkdownTheme).toBe('minimal'))
  mounted.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  delete target.arknoteBoxTheme
})
