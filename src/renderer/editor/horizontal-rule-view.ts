import { hrSchema } from '@milkdown/kit/preset/commonmark'
import { $view } from '@milkdown/kit/utils'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  DEFAULT_HORIZONTAL_RULE_ATTRIBUTES,
  applyHorizontalRuleDomStyle,
  parseHorizontalRuleHtml,
  serializeHorizontalRule,
} from './horizontal-rule-styles'

interface HorizontalRuleChangeDetail {
  markdown?: unknown
}

export function applyHorizontalRuleChangeTransaction(
  event: Event,
  view: Pick<EditorView, 'state' | 'dispatch'>,
  getPos: () => number | undefined,
): void {
  const detail = (event as CustomEvent<HorizontalRuleChangeDetail>).detail
  const attributes = typeof detail?.markdown === 'string'
    ? parseHorizontalRuleHtml(detail.markdown)
    : null
  const html = view.state.schema.nodes.html
  const position = getPos()
  if (!attributes || !html || typeof position !== 'number') return
  const actual = view.state.doc.nodeAt(position)
  const controlledHtml = actual?.type === html
    && typeof actual.attrs.value === 'string'
    && parseHorizontalRuleHtml(actual.attrs.value)
  if (!actual || (actual.type.name !== 'hr' && !controlledHtml)) return
  const replacement = html.create({
    ...(actual.type === html ? actual.attrs : {}),
    value: serializeHorizontalRule(attributes),
  })
  view.dispatch(view.state.tr.replaceWith(
    position,
    position + actual.nodeSize,
    replacement,
  ))
}

export const defaultHorizontalRuleView = $view(hrSchema.node, () => (_node, view, getPos) => {
  const horizontalRule = view.dom.ownerDocument.createElement('hr')
  horizontalRule.contentEditable = 'false'
  applyHorizontalRuleDomStyle(horizontalRule, DEFAULT_HORIZONTAL_RULE_ATTRIBUTES)

  const replaceWithControlledRule = (event: Event) => (
    applyHorizontalRuleChangeTransaction(event, view, getPos)
  )
  horizontalRule.addEventListener('arkdown:horizontal-rule-change', replaceWithControlledRule)

  return {
    dom: horizontalRule,
    destroy: () => {
      horizontalRule.removeEventListener(
        'arkdown:horizontal-rule-change',
        replaceWithControlledRule,
      )
    },
  }
})
