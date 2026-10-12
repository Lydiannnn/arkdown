import { NodeSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'

function normalizeLineEndings(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?|\n/g, '\n')
}

function unwrapCompleteFence(value: string): string | null {
  const trimmed = value.trim()
  const lines = trimmed.split('\n')
  const opening = lines[0]?.match(/^[ \t]*(`{3,}|~{3,}).*$/u)
  if (!opening || lines.length < 2) return null

  const fence = opening[1]
  const fenceCharacter = fence[0]
  const closing = new RegExp(`^[\\t ]*${fenceCharacter}{${fence.length},}[\\t ]*$`, 'u')
  const closingIndex = lines.findIndex((line, index) => index > 0 && closing.test(line))
  if (closingIndex !== lines.length - 1) return null

  return lines.slice(1, -1).join('\n')
}

export function normalizeMermaidClipboardSource(raw: string): string | null {
  if (raw === '') return null

  const normalized = normalizeLineEndings(raw)
  return unwrapCompleteFence(normalized) ?? normalized
}

export function buildMermaidPasteTransaction(
  state: EditorState,
  raw: string,
): Transaction | null {
  if (raw === '') return null

  const codeBlock = state.schema.nodes.code_block
  const source = normalizeMermaidClipboardSource(raw)
  if (!codeBlock || source === null) return null

  try {
    const content = source === '' ? undefined : state.schema.text(source)
    const mermaidBlock = codeBlock.createChecked({
      language: 'mermaid',
      frontmatter: false,
    }, content)
    const transaction = state.tr.replaceSelectionWith(mermaidBlock, false)
    let insertedPosition: number | null = null
    transaction.steps.at(-1)?.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (insertedPosition !== null || newStart === newEnd) return
      transaction.doc.nodesBetween(newStart, newEnd, (node, position) => {
        if (insertedPosition !== null) return false
        if (!node.eq(mermaidBlock)) return true
        insertedPosition = position
        return false
      })
    })
    if (insertedPosition !== null) {
      transaction.setSelection(NodeSelection.create(transaction.doc, insertedPosition))
    }
    return transaction.scrollIntoView()
  } catch {
    return null
  }
}

export function serializeMermaidMarkdown(source: string): string {
  const normalized = normalizeLineEndings(source)
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(normalized.matchAll(/`+/gu), ([run]) => run.length),
  )
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
  return `${fence}mermaid\n${normalized}\n${fence}`
}
