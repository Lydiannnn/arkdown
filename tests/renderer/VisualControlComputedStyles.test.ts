import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

function styleFrom(relativePath: string): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = readFileSync(
    path.join(process.cwd(), relativePath),
    'utf8',
  )
  return style
}

const crepeResetStyle = styleFrom('node_modules/@milkdown/crepe/lib/theme/common/reset.css')
const crepeListStyle = styleFrom('node_modules/@milkdown/crepe/lib/theme/common/list-item.css')
const appStyle = styleFrom('src/renderer/app/styles.css')
const stickyStyle = styleFrom('src/renderer/sticky-notes/sticky-note-window.css')

beforeAll(() => {
  document.head.append(crepeResetStyle, crepeListStyle, appStyle, stickyStyle)
})
afterEach(() => document.body.replaceChildren())
afterAll(() => {
  crepeResetStyle.remove()
  crepeListStyle.remove()
  appStyle.remove()
  stickyStyle.remove()
})

function appendListSurface(sticky: boolean): HTMLElement {
  const host = document.createElement('main')
  host.className = sticky ? 'sticky-note-window' : 'arkdown-window'
  host.style.color = 'rgb(18, 52, 86)'
  host.innerHTML = `
    <div class="visual-editor"><div class="milkdown"><div class="ProseMirror">
      <ul>
        <div class="milkdown-list-item-block"><li class="list-item" data-target="first-item">
          <div class="label-wrapper" data-target="first-wrapper"><span class="milkdown-icon label bullet" data-target="first-bullet"><svg></svg></span></div>
          <div class="children"><div data-content-dom><p>First</p><ul>
            <div class="milkdown-list-item-block"><li class="list-item" data-target="nested-item">
              <div class="label-wrapper"><span class="milkdown-icon label bullet" data-target="nested-bullet"><svg></svg></span></div>
              <div class="children"><div data-content-dom><p>Nested</p></div></div>
            </li></div>
          </ul></div></div>
        </li></div>
        <div class="milkdown-list-item-block"><li class="list-item" data-target="task-item">
          <div class="label-wrapper" data-target="task-wrapper"><span class="milkdown-icon label unchecked" data-target="task-label"><svg data-target="task-icon"></svg></span></div>
          <div class="children"><div data-content-dom><p>Task</p></div></div>
        </li></div>
      </ul>
      <blockquote data-target="quote"><p>Quote</p></blockquote>
    </div></div></div>`
  document.body.append(host)
  return host
}

describe('rendered editor control styles', () => {
  it('sizes Milkdown checked and unchecked task icons through the task-checkbox variable', () => {
    const host = document.createElement('div')
    host.style.setProperty('--task-checkbox-size', '17px')
    host.innerHTML = `
      <div class="visual-editor">
        <div class="ProseMirror">
          <div class="milkdown-list-item-block">
            <li class="list-item">
              <div class="label-wrapper">
                <span class="label unchecked"><svg width="24" height="24"></svg></span>
                <span class="label checked"><svg width="24" height="24"></svg></span>
              </div>
            </li>
          </div>
        </div>
      </div>
    `
    document.body.append(host)

    expect(getComputedStyle(host).getPropertyValue('--task-checkbox-size')).toBe('17px')
    const icons = host.querySelectorAll<SVGElement>('.label svg')
    expect(icons).toHaveLength(2)
    for (const icon of icons) {
      expect(getComputedStyle(icon).width).toBe('var(--task-checkbox-size, 25px)')
      expect(getComputedStyle(icon).height).toBe('var(--task-checkbox-size, 25px)')
    }
  })

  it('keeps Arkdown list geometry explicit while sticky notes override it compactly', () => {
    const arkdown = appendListSurface(false)
    const arkdownItem = arkdown.querySelector<HTMLElement>('[data-target="first-item"]')!
    const arkdownWrapper = arkdown.querySelector<HTMLElement>('[data-target="first-wrapper"]')!
    expect(getComputedStyle(arkdownItem).gap).toBe('10px')
    expect(getComputedStyle(arkdownWrapper).width).toBe('24px')

    const sticky = appendListSurface(true)
    const stickyItem = sticky.querySelector<HTMLElement>('[data-target="first-item"]')!
    const stickyWrapper = sticky.querySelector<HTMLElement>('[data-target="first-wrapper"]')!
    expect(getComputedStyle(stickyItem).gap).toBe('2px')
    expect(getComputedStyle(stickyWrapper).width).toBe('14px')
  })

  it('colors and offsets only the intended real Crepe list controls', () => {
    const sticky = appendListSurface(true)
    const firstBullet = sticky.querySelector<HTMLElement>('[data-target="first-bullet"]')!
    const nestedBullet = sticky.querySelector<HTMLElement>('[data-target="nested-bullet"]')!
    const taskLabel = sticky.querySelector<HTMLElement>('[data-target="task-label"]')!
    const taskIcon = sticky.querySelector<SVGElement>('[data-target="task-icon"]')!

    expect(getComputedStyle(sticky).color).toBe('rgb(18, 52, 86)')
    expect(getComputedStyle(firstBullet).transform).toBe('translate(1px, 0)')
    expect(getComputedStyle(nestedBullet).transform).toBe('none')
    expect(getComputedStyle(taskLabel).width).toBe('22px')
    expect(getComputedStyle(taskLabel).height).toBe('22px')
    expect(getComputedStyle(taskLabel).position).toBe('absolute')
    expect(getComputedStyle(taskLabel).right).toBe('0px')
    expect(getComputedStyle(taskLabel).transform).toBe('none')
    expect(getComputedStyle(taskIcon).width).toBe('14px')
    expect(getComputedStyle(taskIcon).height).toBe('14px')
    expect(getComputedStyle(taskIcon).transform).toBe('translateX(3px)')
  })

  it('removes the gray quote border and keeps the accent connected to the live theme variable', () => {
    const arkdown = appendListSurface(false)
    const quote = arkdown.querySelector<HTMLElement>('[data-target="quote"]')!
    expect(getComputedStyle(quote).borderLeftWidth).toBe('0px')

    arkdown.style.setProperty('--theme-color-rgb', '12 34 56')
    expect(getComputedStyle(quote).getPropertyValue('--theme-color-rgb')).toBe('12 34 56')
    arkdown.style.setProperty('--theme-color-rgb', '78 90 123')
    expect(getComputedStyle(quote).getPropertyValue('--theme-color-rgb')).toBe('78 90 123')
  })

  it('renders the active image alignment icon fully opaque and alternatives at half opacity', () => {
    const host = document.createElement('div')
    host.innerHTML = `
      <div class="visual-editor">
        <div class="ProseMirror">
          <span class="arkdown-image-alignment-toolbar">
            <button aria-pressed="false"><img alt=""></button>
            <button aria-pressed="true"><img alt=""></button>
            <button aria-pressed="false"><img alt=""></button>
          </span>
        </div>
      </div>
    `
    document.body.append(host)

    const icons = host.querySelectorAll<HTMLImageElement>('img')
    expect(getComputedStyle(icons[0]!).opacity).toBe('0.5')
    expect(getComputedStyle(icons[1]!).opacity).toBe('1')
    expect(getComputedStyle(icons[2]!).opacity).toBe('0.5')
  })
})
