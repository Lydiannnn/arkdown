import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import {
  createLogicalBlockSemanticFingerprint,
  type MarkdownLogicalBlockKind,
} from './edit-indicators/markdown-logical-blocks'

export interface ProseMirrorLogicalBlock {
  kind: MarkdownLogicalBlockKind
  semanticFingerprint: string
  node: ProseMirrorNode
  position: number
}

function inlineSemanticText(node: ProseMirrorNode): string {
  let result = ''
  node.descendants((child) => {
    if (child.isText) {
      result += child.text ?? ''
      return false
    }
    if (child.type.name === 'image') {
      result += typeof child.attrs.alt === 'string' ? child.attrs.alt : ''
      return false
    }
    if (child.type.name === 'hardbreak') {
      result += ' '
      return false
    }
    if (child.isInline && child.isLeaf) return false
    if (result && child.isBlock) result += ' '
    return true
  })
  return result
}

function listItemSemanticText(node: ProseMirrorNode): string {
  const parts: string[] = []
  node.forEach((child) => {
    if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') return
    parts.push(child.type.name === 'code_block' ? child.textContent : inlineSemanticText(child))
  })
  return parts.join(' ')
}

function tableRowSemanticParts(node: ProseMirrorNode): string[] {
  const parts: string[] = []
  node.forEach((cell) => parts.push(inlineSemanticText(cell)))
  return parts
}

function semanticParts(kind: MarkdownLogicalBlockKind, node: ProseMirrorNode): readonly string[] {
  if (kind === 'code-block') return [node.textContent]
  if (kind === 'table-row') return tableRowSemanticParts(node)
  if (kind === 'list-item') return [listItemSemanticText(node)]
  return [inlineSemanticText(node)]
}

function logicalKind(node: ProseMirrorNode): MarkdownLogicalBlockKind | null {
  switch (node.type.name) {
    case 'paragraph': return 'paragraph'
    case 'heading': return 'heading'
    case 'list_item': return 'list-item'
    case 'blockquote': return 'blockquote'
    case 'code_block': return 'code-block'
    case 'table_header_row':
    case 'table_row': return 'table-row'
    default: return null
  }
}

function peerKey(kind: MarkdownLogicalBlockKind, parts: readonly string[]): string {
  const parsed = JSON.parse(createLogicalBlockSemanticFingerprint({
    kind, semanticParts: parts, occurrence: 0,
  })) as [MarkdownLogicalBlockKind, readonly string[], number]
  return JSON.stringify([parsed[0], parsed[1]])
}

export function describeVisualLogicalBlocks(
  doc: ProseMirrorNode,
): readonly ProseMirrorLogicalBlock[] {
  const blocks: ProseMirrorLogicalBlock[] = []
  const occurrences = new Map<string, number>()
  const emit = (node: ProseMirrorNode, position: number, kind: MarkdownLogicalBlockKind) => {
    if (kind === 'paragraph' && node.childCount === 0 && doc.childCount > 1) return
    const parts = semanticParts(kind, node)
    const key = peerKey(kind, parts)
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    blocks.push({
      kind,
      semanticFingerprint: createLogicalBlockSemanticFingerprint({
        kind, semanticParts: parts, occurrence,
      }),
      node,
      position,
    })
  }
  const walk = (parent: ProseMirrorNode, parentPosition: number, owner: MarkdownLogicalBlockKind | null) => {
    let offset = 0
    parent.forEach((node) => {
      const position = parent.type.name === 'doc'
        ? offset
        : parentPosition + 1 + offset
      const kind = logicalKind(node)
      if (kind && owner === null) emit(node, position, kind)

      if (kind === 'list-item' && owner === null) {
        let childOffset = 0
        node.forEach((child) => {
          const childPosition = position + 1 + childOffset
          if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') {
            walk(child, childPosition, null)
          }
          childOffset += child.nodeSize
        })
      } else if (
        kind === null
        && node.childCount > 0
        && owner !== 'blockquote'
        && owner !== 'table-row'
      ) {
        walk(node, position, owner)
      }
      offset += node.nodeSize
    })
  }
  walk(doc, -1, null)
  return blocks
}

