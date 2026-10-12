import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

interface PositionedNode {
  type?: unknown
  position?: {
    start?: { offset?: unknown }
    end?: { offset?: unknown }
  }
  children?: unknown
}

function visitTextNodes(node: unknown, replace: (start: number, end: number) => void): void {
  if (typeof node !== 'object' || node === null) return
  const candidate = node as PositionedNode
  const start = candidate.position?.start?.offset
  const end = candidate.position?.end?.offset
  if (candidate.type === 'text' && typeof start === 'number' && typeof end === 'number') {
    replace(start, end)
  }
  if (Array.isArray(candidate.children)) {
    for (const child of candidate.children) visitTextNodes(child, replace)
  }
}

function startsMarkdownBlockContainer(characters: string[], start: number): boolean {
  let end = start
  while (end < characters.length && characters[end] !== '\n') end += 1
  const line = characters.slice(start, end).join('')
  return /^[ \t]{0,3}(?:>|[-+*][ \t]|\d+[.)][ \t]|\|)/u.test(line)
}

export function normalizePptxMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/gu, '\n')
  if (!normalized.includes('\n')) return normalized
  const characters = normalized.split('')
  const tree = fromMarkdown(normalized, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
  visitTextNodes(tree, (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (
        characters[index] === '\n'
        && !startsMarkdownBlockContainer(characters, index + 1)
      ) characters[index] = ' '
    }
  })
  return characters.join('')
}
