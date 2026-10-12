import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface SearchRecord {
  pageTitle: string
  sectionTitle: string
  summary: string
  keywords: string[]
  path: string
  hash: string
}

declare global {
  interface Window {
    ArkdownSearchIndex: SearchRecord[]
    ArkdownManual: {
      filterSearchIndex: (records: SearchRecord[], query: string) => SearchRecord[]
      initialize: (document: Document) => void
    }
  }
}

const records: SearchRecord[] = [
  {
    pageTitle: '保存与状态',
    sectionTitle: '自动保存',
    summary: '停止输入后自动保存。',
    keywords: ['保存', '自动'],
    path: 'saving.html',
    hash: '#saving-auto',
  },
  {
    pageTitle: '保存与状态',
    sectionTitle: '保存冲突',
    summary: '磁盘文件被外部修改时保护当前内容。',
    keywords: ['保存', '冲突', '外部修改'],
    path: 'saving.html',
    hash: '#saving-conflict',
  },
  {
    pageTitle: '工作区与文件',
    sectionTitle: '打开工作区',
    summary: '选择 Markdown 文档所在的文件夹。',
    keywords: ['文件夹', '工作区'],
    path: 'workspace.html',
    hash: '#workspace-open',
  },
]

const fixture = `
  <button class="menu-button" aria-label="打开章节目录" aria-expanded="false" aria-controls="guide-sidebar">章节</button>
  <div class="drawer-overlay" data-drawer-overlay hidden></div>
  <aside id="guide-sidebar">
    <button type="button" data-sidebar-close aria-label="关闭章节目录">关闭</button>
    <input id="guide-search" type="search">
    <button class="search-clear" hidden>清除</button>
    <p class="search-count" role="status"></p>
    <nav data-chapter-navigation><a href="saving.html">保存与状态</a></nav>
    <div data-search-results hidden><ul></ul></div>
    <details data-chapter-group="开始使用"><summary>开始使用</summary></details>
  </aside>
  <main>
    <section id="saving-auto"><h2>自动保存</h2></section>
    <figure class="manual-figure">
      <button type="button" data-image-src="assets/images/app.png" data-image-alt="Arkdown 主界面" data-image-caption="主界面">
        <img src="assets/images/app.png" alt="Arkdown 主界面">
      </button>
    </figure>
  </main>
  <aside class="page-toc"><a href="#saving-auto">自动保存</a></aside>
  <button class="back-to-top" type="button">顶部</button>
  <div class="image-modal" role="dialog" hidden>
    <div class="image-modal-panel">
      <header><strong id="image-modal-title"></strong><button data-modal-close>关闭</button></header>
      <div class="image-modal-content"><img alt=""></div>
    </div>
  </div>
`

async function loadRuntime() {
  const source = await readFile('user-guide/assets/js/manual.js', 'utf8')
  window.eval(source)
  window.ArkdownManual.initialize(document)
}

beforeEach(() => {
  document.documentElement.lang = 'zh-CN'
  document.body.className = ''
  delete document.body.dataset.manualReady
  document.body.dataset.guideBase = './'
  document.body.innerHTML = fixture
  window.ArkdownSearchIndex = structuredClone(records)
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('offline guide runtime', () => {
  it('filters Chinese text and common pinyin wording', async () => {
    await loadRuntime()

    expect(window.ArkdownManual.filterSearchIndex(records, '保存')).toHaveLength(2)
    expect(window.ArkdownManual.filterSearchIndex(records, '  CHONG TU ')).toEqual([
      expect.objectContaining({ sectionTitle: '保存冲突' }),
    ])
  })

  it('renders cross-page search results and clears back to chapters', async () => {
    await loadRuntime()
    const input = document.querySelector<HTMLInputElement>('#guide-search')!
    const clear = document.querySelector<HTMLButtonElement>('.search-clear')!
    const results = document.querySelector<HTMLElement>('[data-search-results]')!
    const navigation = document.querySelector<HTMLElement>('[data-chapter-navigation]')!

    input.value = '保存'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(results.hidden).toBe(false)
    expect(navigation.hidden).toBe(true)
    expect(results.querySelectorAll('li')).toHaveLength(2)
    expect(results.querySelector('a')?.getAttribute('href')).toContain('saving.html#saving-auto')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('找到 2 个')
    expect(clear.hidden).toBe(false)

    clear.click()
    expect(input.value).toBe('')
    expect(results.hidden).toBe(true)
    expect(navigation.hidden).toBe(false)
    expect(clear.hidden).toBe(true)
  })

  it('opens and closes the mobile drawer with correct aria state', async () => {
    await loadRuntime()
    const menu = document.querySelector<HTMLButtonElement>('.menu-button')!
    const overlay = document.querySelector<HTMLElement>('[data-drawer-overlay]')!
    const close = document.querySelector<HTMLButtonElement>('[data-sidebar-close]')!

    menu.click()
    expect(document.body.classList.contains('nav-open')).toBe(true)
    expect(menu.getAttribute('aria-expanded')).toBe('true')
    expect(menu.getAttribute('aria-label')).toBe('关闭章节目录')
    expect(overlay.hidden).toBe(false)

    close.click()
    expect(document.body.classList.contains('nav-open')).toBe(false)
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    expect(menu.getAttribute('aria-label')).toBe('打开章节目录')
    expect(overlay.hidden).toBe(true)

    menu.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.body.classList.contains('nav-open')).toBe(false)
    expect(menu.getAttribute('aria-expanded')).toBe('false')
    expect(menu.getAttribute('aria-label')).toBe('打开章节目录')
    expect(overlay.hidden).toBe(true)
  })

  it('opens a real screenshot in the modal and closes it with Escape', async () => {
    await loadRuntime()
    const trigger = document.querySelector<HTMLButtonElement>('[data-image-src]')!
    const modal = document.querySelector<HTMLElement>('.image-modal')!

    trigger.click()
    expect(modal.hidden).toBe(false)
    expect(modal.querySelector('img')?.getAttribute('src')).toBe('assets/images/app.png')
    expect(modal.querySelector('img')?.getAttribute('alt')).toBe('Arkdown 主界面')
    expect(document.querySelector('#image-modal-title')?.textContent).toBe('主界面')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(modal.hidden).toBe(true)
  })

  it('returns to the top with reduced-motion aware behavior', async () => {
    const scrollTo = vi.fn()
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    })
    await loadRuntime()

    document.querySelector<HTMLButtonElement>('.back-to-top')!.click()
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' })
  })
})
