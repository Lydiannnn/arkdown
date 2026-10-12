import type {
  EditorActiveBlocks,
  EditorParagraphStyle,
} from './editor-menu-model'

interface ResolvedNode {
  type: { name: string }
  attrs: Record<string, unknown>
}

interface ResolvedPosition {
  depth: number
  node(depth: number): ResolvedNode
}

export function resolveEditorActiveBlocks(
  doc: { resolve(position: number): ResolvedPosition },
  position: number,
): EditorActiveBlocks {
  const active: EditorActiveBlocks = {
    blockquote: false,
    codeBlock: false,
    bulletList: false,
    orderedList: false,
    taskList: false,
    paragraphStyle: null,
  }
  const resolved = doc.resolve(position)
  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    const node = resolved.node(depth)
    if (active.paragraphStyle === null && node.type.name === 'paragraph') {
      active.paragraphStyle = 'paragraph'
    }
    const headingLevel = Number(node.attrs.level)
    if (
      active.paragraphStyle === null
      && node.type.name === 'heading'
      && Number.isInteger(headingLevel)
      && headingLevel >= 1
      && headingLevel <= 6
    ) {
      active.paragraphStyle = `heading-${headingLevel}` as EditorParagraphStyle
    }
    if (node.type.name === 'blockquote') active.blockquote = true
    if (node.type.name === 'code_block') active.codeBlock = true
    if (node.type.name === 'bullet_list') active.bulletList = true
    if (node.type.name === 'ordered_list') active.orderedList = true
    if (node.type.name === 'list_item' && typeof node.attrs.checked === 'boolean') {
      active.taskList = true
    }
  }
  if (active.taskList) active.bulletList = false
  return active
}
