import {
  GUIDE_GROUPS,
  GUIDE_UPDATED_AT,
  GUIDE_VERSION,
  type GuidePage,
} from './content.ts'

export interface GuideSearchRecord {
  pageTitle: string
  sectionTitle: string
  summary: string
  keywords: string[]
  path: string
  hash: string
}

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

function validatePages(pages: GuidePage[]): void {
  const outputs = new Set<string>()
  const sectionIds = new Set<string>()
  for (const page of pages) {
    if (outputs.has(page.output)) throw new Error(`duplicate page output: ${page.output}`)
    outputs.add(page.output)
    for (const section of page.sections) {
      if (sectionIds.has(section.id)) throw new Error(`duplicate section id: ${section.id}`)
      sectionIds.add(section.id)
    }
  }
}

function isRootPage(page: GuidePage): boolean {
  return page.output === '使用说明书.html'
}

function pageHref(current: GuidePage, target: GuidePage): string {
  if (isRootPage(current)) return target.output
  if (isRootPage(target)) return '../使用说明书.html'
  return target.output.replace(/^使用说明书\//, '')
}

function renderGlobalNavigation(current: GuidePage, pages: GuidePage[]): string {
  return GUIDE_GROUPS.map((group) => {
    const groupPages = group.pageIds.map((id) => pages.find((page) => page.id === id))
      .filter((page): page is GuidePage => Boolean(page))
    const containsCurrent = groupPages.some((page) => page.id === current.id)
    const links = groupPages.map((page) => `
      <li>
        <a class="chapter-link${page.id === current.id ? ' is-active' : ''}"
           href="${escapeHtml(pageHref(current, page))}"
           ${page.id === current.id ? 'aria-current="page"' : ''}>
          ${escapeHtml(page.title)}
        </a>
      </li>`).join('')
    return `
      <details class="chapter-group" data-chapter-group="${escapeHtml(group.title)}"${containsCurrent ? ' open' : ''}>
        <summary>${escapeHtml(group.title)}</summary>
        <ul>${links}</ul>
      </details>`
  }).join('')
}

function renderPageToc(page: GuidePage): string {
  return page.sections.map((section) => `
    <li><a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></li>`).join('')
}

function renderSections(page: GuidePage, assetBase: string, firstImageLoading: string): string {
  const html = page.sections.map((section) => `
    <section class="manual-section" id="${escapeHtml(section.id)}" data-section-title="${escapeHtml(section.title)}">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="section-body">${section.body.replaceAll('{{assetBase}}', assetBase)}</div>
    </section>`).join('')
  return firstImageLoading === 'eager'
    ? html.replace('loading="lazy"', 'loading="eager"')
    : html
}

function renderFooterNavigation(current: GuidePage, pages: GuidePage[]): string {
  const index = pages.findIndex((page) => page.id === current.id)
  const previous = index > 0 ? pages[index - 1] : undefined
  const next = index < pages.length - 1 ? pages[index + 1] : undefined
  return `
    <nav class="page-pagination" aria-label="相邻章节">
      ${previous
        ? `<a class="page-previous" href="${escapeHtml(pageHref(current, previous))}"><span>上一章</span><strong>${escapeHtml(previous.title)}</strong></a>`
        : '<span></span>'}
      ${next
        ? `<a class="page-next" href="${escapeHtml(pageHref(current, next))}"><span>下一章</span><strong>${escapeHtml(next.title)}</strong></a>`
        : '<span></span>'}
    </nav>`
}

export function buildSearchIndex(pages: GuidePage[]): GuideSearchRecord[] {
  validatePages(pages)
  return pages.flatMap((page) => page.sections.map((section) => ({
    pageTitle: page.title,
    sectionTitle: section.title,
    summary: section.summary,
    keywords: section.keywords,
    path: isRootPage(page) ? '../使用说明书.html' : page.output.replace(/^使用说明书\//, ''),
    hash: `#${section.id}`,
  })))
}

export function renderGuidePage(page: GuidePage, pages: GuidePage[]): string {
  validatePages(pages)
  if (!pages.some((candidate) => candidate.id === page.id)) {
    throw new Error(`page is not part of the guide: ${page.id}`)
  }

  const root = isRootPage(page)
  const assetBase = root ? '使用说明书/assets' : 'assets'
  const guideBase = root ? '使用说明书/' : './'
  const homeHref = root ? '使用说明书.html' : '../使用说明书.html'
  const firstImageLoading = root ? 'eager' : 'lazy'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; script-src 'self'; style-src 'self'; img-src 'self' data:;">
  <title>${escapeHtml(page.title)} · Arkdown 使用说明书</title>
  <link rel="stylesheet" href="${assetBase}/css/manual.css">
  <script defer src="${assetBase}/js/search-index.js"></script>
  <script defer src="${assetBase}/js/manual.js"></script>
</head>
<body data-page="${page.id}" data-guide-base="${guideBase}" data-first-image-loading="${firstImageLoading}">
  <a class="skip-link" href="#main-content">跳到正文</a>
  <header class="site-header">
    <a class="brand" href="${homeHref}" aria-label="返回 Arkdown 使用说明书首页">
      <span class="brand-mark" aria-hidden="true">TL</span>
      <span class="brand-copy">
        <strong>Arkdown</strong>
        <small>OFFLINE USER GUIDE · ${GUIDE_VERSION}</small>
      </span>
    </a>
    <div class="header-actions">
      <button class="menu-button" type="button" aria-label="打开章节目录" aria-expanded="false" aria-controls="guide-sidebar">章节</button>
      <span class="guide-badge">使用说明书</span>
    </div>
  </header>

  <div class="drawer-overlay" data-drawer-overlay hidden></div>
  <aside class="guide-sidebar" id="guide-sidebar" aria-label="章节目录">
    <button class="sidebar-close" type="button" data-sidebar-close aria-label="关闭章节目录">关闭</button>
    <div class="sidebar-search">
      <label for="guide-search">搜索全部说明</label>
      <div class="search-control">
        <input id="guide-search" type="search" placeholder="输入功能或问题" autocomplete="off">
        <button class="search-clear" type="button" aria-label="清除搜索" hidden>清除</button>
      </div>
      <p class="search-count" role="status">共 ${pages.flatMap((candidate) => candidate.sections).length} 个章节</p>
    </div>
    <nav class="chapter-navigation" data-chapter-navigation>
      ${renderGlobalNavigation(page, pages)}
    </nav>
    <div class="search-results" data-search-results hidden>
      <ul></ul>
    </div>
  </aside>

  <div class="page-layout">
    <main class="manual-main" id="main-content">
      <nav class="breadcrumb" aria-label="面包屑">
        <a href="${homeHref}">Arkdown</a><span aria-hidden="true">/</span><span>${escapeHtml(page.title)}</span>
      </nav>
      <p class="eyebrow">${escapeHtml(page.eyebrow)}</p>
      <h1>${escapeHtml(page.title)}</h1>
      <p class="lead">${escapeHtml(page.description)}</p>
      <p class="page-meta">适用版本 ${GUIDE_VERSION} · 更新于 ${GUIDE_UPDATED_AT}</p>

      ${renderSections(page, assetBase, firstImageLoading)}
      ${renderFooterNavigation(page, pages)}
      <footer class="manual-footer">
        <p>Arkdown ${GUIDE_VERSION} · 离线使用说明书</p>
        <a href="${homeHref}">返回说明书首页</a>
      </footer>
    </main>

    <aside class="page-toc" aria-label="本页目录">
      <strong>本页内容</strong>
      <ol>${renderPageToc(page)}</ol>
    </aside>
  </div>

  <button class="back-to-top" type="button" aria-label="返回顶部">顶部</button>

  <div class="image-modal" role="dialog" aria-modal="true" aria-labelledby="image-modal-title" hidden>
    <div class="image-modal-panel">
      <header><strong id="image-modal-title">截图预览</strong><button type="button" data-modal-close aria-label="关闭截图预览">关闭</button></header>
      <div class="image-modal-content"><img alt=""></div>
    </div>
  </div>
</body>
</html>
`
}
