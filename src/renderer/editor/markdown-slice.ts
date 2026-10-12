import type { Node as ProseMirrorNode, Schema } from '@milkdown/kit/prose/model'
import { Slice } from '@milkdown/kit/prose/model'

export type MarkdownParser = (markdown: string) => ProseMirrorNode

export function parseMarkdownInsertionSlice(
  parser: MarkdownParser,
  schema: Schema,
  markdown: string,
): Slice {
  const document = parser(markdown)
  const paragraph = schema.nodes.paragraph
  const isSingleLogicalLine = !/[\r\n]/u.test(markdown)
  const singleParagraph = document.childCount === 1
    && paragraph !== undefined
    && document.firstChild?.type === paragraph

  if (isSingleLogicalLine && singleParagraph && document.firstChild) {
    return Slice.maxOpen(document.firstChild.content)
  }
  return Slice.maxOpen(document.content)
}
