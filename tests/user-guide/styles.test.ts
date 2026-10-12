import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('approved guide visual contract', () => {
  it('uses the captured reference tokens', async () => {
    const css = await readFile('user-guide/assets/css/manual.css', 'utf8')

    for (const token of [
      '--accent: #167d6f',
      '--accent-soft: #eaf5f1',
      '--accent-strong: #0f665b',
      '--ink: #1d2523',
      '--muted: #65706d',
      '--line: #d9dfdd',
      '--surface-subtle: #f5f7f6',
      '--warning: #a66312',
      '--warning-soft: #fff7e8',
      '--info: #2f6ea3',
      '--info-soft: #edf5fb',
      '--danger: #b44343',
      '--danger-soft: #fff0f0',
      '--radius: 6px',
      '--header-height: 56px',
      '--sidebar-width: 280px',
      '--toc-width: 220px',
      '--content-width: 860px',
    ]) expect(css).toContain(token)
  })

  it('defines desktop, mobile, focus, and reduced-motion behavior', async () => {
    const css = await readFile('user-guide/assets/css/manual.css', 'utf8')

    expect(css).toContain('.site-header')
    expect(css).toContain('.guide-sidebar')
    expect(css).toContain('.page-toc')
    expect(css).toContain('.image-modal')
    expect(css).toContain('.nav-open .guide-sidebar')
    expect(css).toContain('@media (max-width: 900px)')
    expect(css).toContain('@media (max-width: 520px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('[hidden]')
  })
})
