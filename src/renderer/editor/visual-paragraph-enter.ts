import { Plugin, TextSelection } from '@milkdown/kit/prose/state'

export function createVisualParagraphEnterPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown: (view, event) => {
        if (
          event.key !== 'Enter'
          || event.shiftKey
          || event.altKey
          || !event.ctrlKey
          || event.metaKey
          || event.isComposing
          || view.composing
        ) return false
        const { selection } = view.state
        if (
          !(selection instanceof TextSelection)
          || !selection.empty
          || !selection.$from.sameParent(selection.$to)
          || selection.$from.parent.type.name !== 'paragraph'
        ) return false
        const hardbreak = view.state.schema.nodes.hardbreak
        if (!hardbreak) return false
        view.dispatch(view.state.tr
          .replaceSelectionWith(hardbreak.create({ isInline: true }), false)
          .scrollIntoView())
        return true
      },
    },
  })
}
