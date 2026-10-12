import { expect, it, vi } from 'vitest'
import { createArkdownApi, type MenuCommandTransport } from '../../src/preload/arkdown-api'

it('forwards only registered menu commands and releases subscriptions', () => {
  let listener: ((payload: unknown) => void) | null = null
  const unsubscribe = vi.fn()
  const transport: MenuCommandTransport = {
    subscribe(next) {
      listener = next
      return unsubscribe
    },
  }
  const api = createArkdownApi(vi.fn(), undefined, undefined, transport)
  const handler = vi.fn()
  const release = api.onMenuCommand!(handler)

  const dispatch = listener as ((payload: unknown) => void) | null
  dispatch?.('strong')
  dispatch?.('select-editor-theme-minimal' as never)
  dispatch?.('about')
  dispatch?.('search-workspace')
  dispatch?.('toggle-document-outline')
  dispatch?.('not-a-command')
  expect(handler).toHaveBeenCalledTimes(5)
  expect(handler).toHaveBeenCalledWith('strong')
  expect(handler).toHaveBeenCalledWith('select-editor-theme-minimal')
  expect(handler).toHaveBeenCalledWith('about')
  expect(handler).toHaveBeenCalledWith('search-workspace')
  expect(handler).toHaveBeenCalledWith('toggle-document-outline')

  release()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
