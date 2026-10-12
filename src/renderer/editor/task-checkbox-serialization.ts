import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Root, RootContent } from 'mdast'

interface TaskMarker {
  offset: number
  checked: boolean
}

function sourceTaskMarkers(markdown: string, parse: (source: string) => Root): TaskMarker[] | null {
  const markers: TaskMarker[] = []
  let valid = true
  const visit = (node: RootContent) => {
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const start = node.position?.start.offset
      const prefix = start === undefined ? null : /^(?:[-+*]|\d+[.)])[\t ]+\[([ xX])\](?=[\t \r\n]|$)/.exec(markdown.slice(start))
      if (!prefix || start === undefined) valid = false
      else markers.push({ offset: start + prefix[0].length - 2, checked: node.checked })
    }
    if ('children' in node) node.children.forEach(child => visit(child as RootContent))
  }
  parse(markdown).children.forEach(visit)
  return valid ? markers : null
}

// Refuse this shortcut if anything except existing task checked attributes changed.
function checkedOnlyChanges(before: ProseMirrorNode, after: ProseMirrorNode): boolean[] | null {
  const checked: boolean[] = []
  const visit = (left: ProseMirrorNode, right: ProseMirrorNode): boolean => {
    const task = left.type.name === 'list_item' && typeof left.attrs.checked === 'boolean'
    if (task) {
      if (typeof right.attrs.checked !== 'boolean'
        || !left.hasMarkup(right.type, { ...right.attrs, checked: left.attrs.checked }, right.marks)) return false
      checked.push(right.attrs.checked)
    } else if (!left.sameMarkup(right)) return false
    if (left.text !== right.text || left.childCount !== right.childCount) return false
    for (let index = 0; index < left.childCount; index += 1) {
      if (!visit(left.child(index), right.child(index))) return false
    }
    return true
  }
  return visit(before, after) ? checked : null
}

export function createTaskCheckboxSerializer(
  openingDocument: ProseMirrorNode,
  openingMarkdown: string,
  fallback: (document: ProseMirrorNode) => string,
  parse: (source: string) => Root = source => fromMarkdown(source, {
    extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()],
  }),
): (document: ProseMirrorNode) => string {
  let baselineDocument = openingDocument
  let baselineMarkdown = openingMarkdown
  let markers: TaskMarker[] | null | undefined
  return (document) => {
    const checked = checkedOnlyChanges(baselineDocument, document)
    if (checked?.length) {
      markers ??= sourceTaskMarkers(baselineMarkdown, parse)
      const baselineChecked = checkedOnlyChanges(baselineDocument, baselineDocument)!
      if (markers && markers.length === checked.length
        && markers.every((marker, index) => marker.checked === baselineChecked[index])) {
        let result = baselineMarkdown
        for (let index = markers.length - 1; index >= 0; index -= 1) {
          const marker = markers[index]!
          if (marker.checked === checked[index]) continue
          result = result.slice(0, marker.offset) + (checked[index] ? 'x' : ' ') + result.slice(marker.offset + 1)
        }
        return result
      }
    }
    // Text/format/structure edits still use the normal serializer. Only checkbox
    // toggles retain the source baseline, so undo also restores its exact spelling.
    const markdown = fallback(document)
    baselineDocument = document
    baselineMarkdown = markdown
    markers = undefined
    return markdown
  }
}
