import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-box.css'), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]+)\\}', 's'))
  if (!match) throw new Error('Missing CSS rule for ' + selector)
  return match[1].replace(/\s+/g, ' ')
}

describe('archived sticky-note selection styles', () => {
  it('fills archived content with the real pointer hit area', () => {
    const surface = rule('.sticky-note-box-content[data-view="archived"] > .sticky-note-grid[data-interaction-mode="archive"]')
    expect(surface).toContain('min-height: 100%')
  })

  it('uses the theme color for selected borders and overlay', () => {
    const selected = rule('.sticky-note-grid[data-interaction-mode="archive"] .sticky-note-card[aria-selected="true"]')
    expect(selected).toContain('border-color: rgb(var(--theme-color-rgb, 198 40 40) / 80%)')
    expect(selected).toContain('box-shadow: inset 0 0 0 999px rgb(var(--theme-color-rgb, 198 40 40) / 10%)')
  })

  it('uses the theme color for marquee border and fill', () => {
    const marquee = rule('.sticky-note-selection-marquee')
    expect(marquee).toContain('border: 1px solid rgb(var(--theme-color-rgb, 198 40 40) / 60%)')
    expect(marquee).toContain('background: rgb(var(--theme-color-rgb, 198 40 40) / 10%)')
    expect(marquee).toContain('pointer-events: none')
  })

  it('keeps every card on the default arrow while idle and grabbing only during a real drag', () => {
    expect(rule('.sticky-note-grid[data-interaction-mode="archive"] .sticky-note-card')).toContain('cursor: default')
    expect(rule('.sticky-note-grid[data-interaction-mode="active"] .sticky-note-card[draggable="true"]')).toContain('cursor: default')
    expect(rule('.sticky-note-grid[data-dragging="true"] .sticky-note-card[aria-selected="true"]')).toContain('cursor: grabbing')
    expect(css).not.toMatch(/^\.sticky-note-card\[draggable="true"\]:active\s*\{/mu)
  })

  it('keeps drag-only theme glow while enabled targets still show control layers', () => {
    const permanent = rule('.sticky-note-permanent-delete-target')
    expect(permanent).toContain('width: 40px')
    expect(permanent).toContain('height: 40px')
    expect(rule('.sticky-note-drop-target-icon')).toContain('width: 22px')
    expect(rule('.sticky-note-drop-target-icon')).toContain('height: 22px')
    expect(rule('.sticky-note-drop-target-icon')).toContain('opacity: .5')
    const activeIcon = rule('.sticky-note-box-panel[data-card-dragging="true"] .sticky-note-drop-target-icon')
    expect(activeIcon).toContain('opacity: 1')
    expect(activeIcon).not.toContain('filter:')
    const activeFrame = rule(
      '.sticky-note-box-panel[data-card-dragging="true"] :is(.sticky-note-permanent-delete-target, .sticky-note-recycle-target)',
    )
    expect(activeFrame).toContain('border-color: rgb(var(--theme-color-rgb, 198 40 40) / 55%)')
    expect(activeFrame).toContain('box-shadow: 0 0 8px rgb(var(--theme-color-rgb, 198 40 40) / 70%)')
    expect(rule('.sticky-note-recycle-target:hover:not(:disabled)')).toContain(
      'background: var(--control-hover-layer) !important',
    )
    expect(rule('.sticky-note-recycle-target:active:not(:disabled)')).toContain(
      'background: var(--control-pressed-layer) !important',
    )
  })

  it('keeps selected archive cards visibly selected while hovered and pressed', () => {
    const selectedHover = rule(
      '.sticky-note-grid[data-interaction-mode="archive"] .sticky-note-card[aria-selected="true"]:hover:not(:disabled)',
    )
    expect(selectedHover).toContain('border-color: rgb(var(--theme-color-rgb, 198 40 40) / 80%)')
    expect(selectedHover).toContain('box-shadow: inset 0 0 0 999px rgb(var(--theme-color-rgb, 198 40 40) / 10%), 0 4px 12px rgb(0 0 0 / 9%)')

    const selectedPressed = rule(
      '.sticky-note-grid[data-interaction-mode="archive"] .sticky-note-card[aria-selected="true"]:active:not(:disabled)',
    )
    expect(selectedPressed).toContain('border-color: rgb(var(--theme-color-rgb, 198 40 40) / 80%)')
    expect(selectedPressed).toContain('box-shadow: inset 0 0 0 999px var(--control-pressed-layer), inset 0 0 0 999px rgb(var(--theme-color-rgb, 198 40 40) / 10%)')
  })

  it('pins permanent delete to archived content bottom-right and aligns active archive feedback to the Archive tab', () => {
    const permanent = rule('.sticky-note-permanent-delete-target')
    expect(permanent).toContain('position: absolute')
    expect(permanent).toContain('right: 14px')
    expect(permanent).toContain('bottom: 14px')
    expect(rule('.sticky-note-recycle-target')).toContain('left: calc(var(--sticky-note-archive-tab-center-x) - 20px)')
    const toast = rule('.sticky-note-archive-toast')
    expect(toast).toContain('left: var(--sticky-note-archive-tab-center-x)')
    expect(toast).toContain(
      'bottom: calc(var(--sticky-note-box-tabs-height) + var(--sticky-note-drop-target-gap) + var(--sticky-note-drop-target-size) + var(--sticky-note-archive-toast-gap))',
    )
  })
})
