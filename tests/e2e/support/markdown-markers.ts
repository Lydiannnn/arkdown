import { fromMarkdown } from 'mdast-util-from-markdown'

// Tool pages and saved files are Markdown source; DOM assertions use rendered text.
// Match within one real text node, never link destinations, code, or joined fragments.
export function markdownContainsText(source: string, marker: string): boolean {
  type Node = { type: string; value?: unknown; children?: readonly Node[] }
  const contains = (node: Node): boolean =>
    (node.type === 'text' && typeof node.value === 'string' && node.value.includes(marker)) ||
    (node.children?.some(contains) ?? false)
  return marker.length > 0 && contains(fromMarkdown(source))
}
