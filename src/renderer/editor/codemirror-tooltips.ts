import { ViewPlugin, type EditorView } from '@codemirror/view'

const foldTipSelector = '.cm-foldPlaceholder[title], .cm-foldGutter [title]'
const foldLabels: Record<string, string> = {
  unfold: '展开代码',
  'Fold line': '折叠代码',
  'Unfold line': '展开代码',
}

// CodeMirror creates and replaces its fold controls during rendering. Keep this
// adaptation inside each editor; document content and SVG titles are untouched.
export const codeMirrorTooltips = ViewPlugin.fromClass(class {
  private readonly observer: MutationObserver

  constructor(view: EditorView) {
    const refresh = () => {
      for (const element of view.dom.querySelectorAll<HTMLElement>(foldTipSelector)) {
        const label = element.title
        element.dataset.tooltip = foldLabels[label] ?? label
        element.removeAttribute('title')
      }
    }
    this.observer = new MutationObserver(refresh)
    this.observer.observe(view.dom, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title'],
    })
    refresh()
  }

  destroy() {
    this.observer.disconnect()
  }
})
