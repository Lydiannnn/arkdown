import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResponsiveTableLayout } from '../../src/renderer/editor/responsive-table-layout'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('responsive table and manual resize coordination', () => {
  it('does not proportionally rewrite a table during a manual column drag', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const root = document.createElement('div')
    root.innerHTML = `
      <div class="tableWrapper">
        <table data-arkdown-column-resizing="true">
          <colgroup>
            <col style="width: 120px">
            <col style="width: 80px">
          </colgroup>
          <tbody><tr><td>A</td><td>B</td></tr></tbody>
        </table>
      </div>
    `
    document.body.append(root)
    const wrapper = root.querySelector<HTMLElement>('.tableWrapper')!
    Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: 100 })

    const cleanup = createResponsiveTableLayout(root)
    const columns = root.querySelectorAll<HTMLTableColElement>('col')

    expect(columns[0].style.width).toBe('120px')
    expect(columns[1].style.width).toBe('80px')
    cleanup()
  })
})
