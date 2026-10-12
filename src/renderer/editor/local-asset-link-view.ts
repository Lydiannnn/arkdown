import { linkSchema } from '@milkdown/kit/preset/commonmark'
import { $view } from '@milkdown/kit/utils'
import { parseLinkTarget } from '../../shared/link-target'
import { parseDocumentViewLink } from '../../shared/document-view-link'
import { welcomeActionForLink } from '../guide/welcome-actions'

const webLinkClass = 'arkdown-web-link'
const localLinkClass = 'arkdown-local-link'
const openableClass = 'arkdown-link-openable'
const linkTitle = 'Ctrl+单击打开'

export function applyLinkAttributes(
  anchor: HTMLAnchorElement,
  href: unknown,
  title: unknown,
): void {
  anchor.removeAttribute('href')
  anchor.removeAttribute('title')
  anchor.removeAttribute('data-tooltip')
  anchor.removeAttribute('tabindex')
  anchor.classList.remove('arkdown-welcome-action')
  anchor.classList.remove(webLinkClass, localLinkClass, openableClass, 'arkdown-relative-link')

  const action = welcomeActionForLink(href)
  if (action) {
    anchor.setAttribute('href', href as string)
    anchor.classList.add('arkdown-welcome-action')
    anchor.tabIndex = 0
    return
  }
  const target = parseLinkTarget(href)
  if (!target) {
    const documentLink = parseDocumentViewLink(href)
    if (!documentLink || typeof href !== 'string') return
    // The original relative spelling defines navigation and must survive serialization.
    anchor.setAttribute('href', href)
    if (documentLink.kind === 'relative') anchor.classList.add('arkdown-relative-link')
    anchor.dataset.tooltip = typeof title === 'string' && title ? title
      : documentLink.kind === 'relative' ? 'Ctrl+单击，在文档查看中打开' : 'Ctrl+单击，跳转到章节'
    return
  }
  anchor.setAttribute('href', target.kind === 'web' ? target.url : target.path)
  anchor.classList.add(target.kind === 'web' ? webLinkClass : localLinkClass)
  anchor.dataset.tooltip = typeof title === 'string' && title ? title : linkTitle
}

export const localAssetLinkView = $view(linkSchema.mark, () => (mark) => {
  const anchor = document.createElement('a')
  const apply = (nextMark: typeof mark) => {
    applyLinkAttributes(anchor, nextMark.attrs.href, nextMark.attrs.title)
  }
  apply(mark)
  return {
    dom: anchor,
    contentDOM: anchor,
    update: (nextMark) => {
      if (nextMark.type !== mark.type) return false
      apply(nextMark)
      return true
    },
  }
})
