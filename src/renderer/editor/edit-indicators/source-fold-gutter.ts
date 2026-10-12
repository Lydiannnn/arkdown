import { foldGutter } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import './edit-indicators.css'

function foldMarker(open: boolean): HTMLElement {
  const marker = document.createElement('span')
  const folded = !open
  marker.className = [
    'arkdown-source-fold-triangle',
    folded
      ? 'arkdown-source-fold-triangle--right'
      : 'arkdown-source-fold-triangle--down',
  ].join(' ')
  marker.dataset.folded = String(folded)
  marker.setAttribute('aria-hidden', 'true')
  return marker
}

export const sourceFoldGutter: Extension = foldGutter({
  markerDOM: foldMarker,
})
