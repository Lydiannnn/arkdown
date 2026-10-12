(() => {
  'use strict'

  const PINYIN_ALIASES = new Map([
    ['chong tu', '冲突'],
    ['chongtu', '冲突'],
    ['bao cun', '保存'],
    ['baocun', '保存'],
    ['wen jian jia', '文件夹'],
    ['wenjianjia', '文件夹'],
  ])

  const normalize = (value) => {
    let normalized = String(value ?? '').toLocaleLowerCase('zh-CN').trim().replace(/\s+/g, ' ')
    for (const [source, target] of PINYIN_ALIASES) {
      normalized = normalized.replaceAll(source, target)
    }
    return normalized
  }

  const filterSearchIndex = (records, query) => {
    const normalized = normalize(query)
    if (!normalized) return []
    const terms = normalized.split(' ').filter(Boolean)
    return records.filter((record) => {
      const text = normalize([
        record.pageTitle,
        record.sectionTitle,
        record.summary,
        ...(record.keywords ?? []),
      ].join(' '))
      return terms.every((term) => text.includes(term))
    })
  }

  const safeSessionStorage = {
    get(key) {
      try {
        return window.sessionStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        window.sessionStorage.setItem(key, value)
      } catch {
        // The guide remains usable when local file storage is denied.
      }
    },
  }

  const initialize = (doc) => {
    const root = doc.body
    if (!root || root.dataset.manualReady === 'true') return
    root.dataset.manualReady = 'true'

    const menu = doc.querySelector('.menu-button')
    const overlay = doc.querySelector('[data-drawer-overlay]')
    const sidebarClose = doc.querySelector('[data-sidebar-close]')
    const closeDrawer = () => {
      root.classList.remove('nav-open')
      if (menu) {
        menu.setAttribute('aria-expanded', 'false')
        menu.setAttribute('aria-label', '打开章节目录')
      }
      if (overlay) overlay.hidden = true
    }
    const openDrawer = () => {
      root.classList.add('nav-open')
      if (menu) {
        menu.setAttribute('aria-expanded', 'true')
        menu.setAttribute('aria-label', '关闭章节目录')
      }
      if (overlay) overlay.hidden = false
    }
    menu?.addEventListener('click', () => {
      if (root.classList.contains('nav-open')) closeDrawer()
      else openDrawer()
    })
    overlay?.addEventListener('click', closeDrawer)
    sidebarClose?.addEventListener('click', () => {
      closeDrawer()
      menu?.focus()
    })

    const groups = [...doc.querySelectorAll('[data-chapter-group]')]
    for (const group of groups) {
      const key = `arkdown-guide-group:${group.dataset.chapterGroup}`
      const remembered = safeSessionStorage.get(key)
      if (remembered === 'open') group.open = true
      if (remembered === 'closed') group.open = false
      group.addEventListener('toggle', () => safeSessionStorage.set(key, group.open ? 'open' : 'closed'))
    }

    const search = doc.querySelector('#guide-search')
    const clear = doc.querySelector('.search-clear')
    const count = doc.querySelector('.search-count')
    const navigation = doc.querySelector('[data-chapter-navigation]')
    const results = doc.querySelector('[data-search-results]')
    const resultList = results?.querySelector('ul')
    const totalSections = Array.isArray(window.ArkdownSearchIndex)
      ? window.ArkdownSearchIndex.length
      : 0
    const showAll = () => {
      if (search) search.value = ''
      if (clear) clear.hidden = true
      if (results) results.hidden = true
      if (navigation) navigation.hidden = false
      if (resultList) resultList.replaceChildren()
      if (count) count.textContent = `共 ${totalSections} 个章节`
    }
    const renderSearch = () => {
      const query = search?.value ?? ''
      if (!normalize(query)) {
        showAll()
        return
      }
      const matched = filterSearchIndex(window.ArkdownSearchIndex ?? [], query)
      if (clear) clear.hidden = false
      if (navigation) navigation.hidden = true
      if (results) results.hidden = false
      if (count) count.textContent = `找到 ${matched.length} 个相关章节`
      if (!resultList) return
      resultList.replaceChildren(...matched.map((record) => {
        const item = doc.createElement('li')
        const link = doc.createElement('a')
        const base = new URL(root.dataset.guideBase || './', window.location.href)
        link.href = new URL(`${record.path}${record.hash}`, base).href
        const title = doc.createElement('strong')
        title.textContent = record.sectionTitle
        const page = doc.createElement('span')
        page.textContent = record.pageTitle
        const summary = doc.createElement('small')
        summary.textContent = record.summary
        link.append(title, page, summary)
        item.append(link)
        return item
      }))
    }
    search?.addEventListener('input', renderSearch)
    clear?.addEventListener('click', () => {
      showAll()
      search?.focus()
    })
    if (count && !count.textContent?.trim()) count.textContent = `共 ${totalSections} 个章节`

    const modal = doc.querySelector('.image-modal')
    const modalImage = modal?.querySelector('img')
    const modalTitle = doc.querySelector('#image-modal-title')
    const closeModal = () => {
      if (!modal || modal.hidden) return
      modal.hidden = true
      root.classList.remove('modal-open')
    }
    for (const trigger of doc.querySelectorAll('[data-image-src]')) {
      trigger.addEventListener('click', () => {
        if (!modal || !modalImage) return
        modalImage.src = trigger.dataset.imageSrc || ''
        modalImage.alt = trigger.dataset.imageAlt || ''
        if (modalTitle) modalTitle.textContent = trigger.dataset.imageCaption || '截图预览'
        modal.hidden = false
        root.classList.add('modal-open')
        modal.querySelector('[data-modal-close]')?.focus()
      })
    }
    modal?.querySelector('[data-modal-close]')?.addEventListener('click', closeModal)
    modal?.addEventListener('click', (event) => {
      if (event.target === modal) closeModal()
    })

    doc.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      closeModal()
      closeDrawer()
    })

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    doc.querySelector('.back-to-top')?.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
    })

    const tocLinks = [...doc.querySelectorAll('.page-toc a[href^="#"]')]
    const sections = tocLinks
      .map((link) => doc.querySelector(link.getAttribute('href')))
      .filter(Boolean)
    if ('IntersectionObserver' in window && sections.length > 0) {
      const observer = new IntersectionObserver((entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0]
        if (!visible) return
        for (const link of tocLinks) {
          const active = link.getAttribute('href') === `#${visible.target.id}`
          link.classList.toggle('is-active', active)
          if (active) link.setAttribute('aria-current', 'location')
          else link.removeAttribute('aria-current')
        }
      }, { rootMargin: '-20% 0px -70% 0px' })
      sections.forEach((section) => observer.observe(section))
    }
  }

  window.ArkdownManual = { filterSearchIndex, initialize }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initialize(document), { once: true })
  } else {
    initialize(document)
  }
})()
