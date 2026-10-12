import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { GUIDE_PAGES } from '../../user-guide/content'
import { renderGuidePage } from '../../user-guide/template'

describe('final user-guide review contracts', () => {
  it('provides direct troubleshooting entries for ordinary-user failures', () => {
    const page = GUIDE_PAGES.find(({ id }) => id === 'troubleshooting')!
    const entries = new Map(page.sections.map((section) => [section.id, section]))

    expect(entries.get('troubleshooting-tree-missing')?.title).toBe('文件树看不到文档')
    expect(entries.get('troubleshooting-document-open')?.title).toBe('文档无法打开')
    expect(entries.get('troubleshooting-save-failure')?.title).toBe('保存失败')
    expect(entries.get('troubleshooting-save-conflict')?.title).toBe('出现保存冲突')
    expect(entries.get('troubleshooting-portable-settings')?.title).toBe('移动程序后设置没有保留')
    for (const id of [
      'troubleshooting-tree-missing',
      'troubleshooting-document-open',
      'troubleshooting-save-failure',
      'troubleshooting-save-conflict',
      'troubleshooting-portable-settings',
    ]) {
      expect(entries.get(id)?.body).toContain('<ol class="steps">')
    }
  })

  it('loads the first home screenshot eagerly and leaves child screenshots lazy', () => {
    const home = renderGuidePage(GUIDE_PAGES[0]!, GUIDE_PAGES)
    const workspace = renderGuidePage(GUIDE_PAGES[1]!, GUIDE_PAGES)

    expect(home).toMatch(/app-start\.png[^>]*loading="eager"/)
    expect(workspace).toMatch(/file-tree\.png[^>]*loading="lazy"/)
  })

  it('keeps sticky-note guidance searchable and illustrated with the real application', () => {
    const sections = GUIDE_PAGES.flatMap((page) => page.sections)
    const box = sections.find(({ id }) => id === 'editing-sticky-note-box')
    const desktop = sections.find(({ id }) => id === 'portable-sticky-note-lifecycle')

    expect(box?.keywords).toEqual(expect.arrayContaining(['便签盒子', '归档', '搜索']))
    expect(box?.body).toContain('sticky-note-box.png')
    expect(desktop?.keywords).toEqual(expect.arrayContaining(['开机启动', '系统托盘', 'Pin']))
  })

  it('renders a dedicated mobile drawer close control', async () => {
    const home = renderGuidePage(GUIDE_PAGES[0]!, GUIDE_PAGES)
    const css = await readFile('user-guide/assets/css/manual.css', 'utf8')

    expect(home).toContain('class="sidebar-close"')
    expect(home).toContain('data-sidebar-close')
    expect(home).toContain('aria-label="关闭章节目录"')
    expect(css).toContain('.sidebar-close')
  })
})
