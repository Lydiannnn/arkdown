import { StateEffect, StateField, type ChangeSet, type EditorState, type Extension } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'
import { isCodeDocumentPath } from '../../shared/document-types'

export function normalizeCodeDocumentText(text: string): string {
  return text.replace(/\r\n|\r/g, '\n')
}

// CodeMirror edits normalized positions. Keep unedited original slices, including
// their individual newline sequences, rather than rewriting the whole document.
export function applyCodeDocumentChanges(raw: string, changes: ChangeSet): string {
  const newline = /\r\n|\r|\n/u.exec(raw)?.[0] ?? '\n'
  let rawOffset = 0
  let normalizedOffset = 0
  const rawPosition = (position: number): number => {
    while (normalizedOffset < position && rawOffset < raw.length) {
      if (raw[rawOffset] === '\r' && raw[rawOffset + 1] === '\n') rawOffset += 1
      rawOffset += 1
      normalizedOffset += 1
    }
    return rawOffset
  }
  let previous = 0
  const parts: string[] = []
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const start = rawPosition(from)
    const end = rawPosition(to)
    parts.push(raw.slice(previous, start), inserted.toString().replace(/\n/g, newline))
    previous = end
  })
  parts.push(raw.slice(previous))
  return parts.join('')
}

export function createCodeDocumentTextState(initialText: string): {
  extension: Extension
  text(state: EditorState): string
} {
  // History stores compact newline markers, not another full source snapshot.
  const restoreTerminators = StateEffect.define<string>()
  const markers = (text: string) => (text.match(/\r\n|\r|\n/g) ?? [])
    .map(newline => newline === '\r\n' ? 'c' : newline === '\r' ? 'r' : 'n').join('')
  const rawText = StateField.define<string>({
    create: () => initialText,
    update: (raw, transaction) => {
      const restored = transaction.effects.filter(effect => effect.is(restoreTerminators)).at(-1)
      if (restored) {
        let index = 0
        return transaction.newDoc.toString().replace(/\n/g, () => {
          const marker = restored.value[index++]
          return marker === 'c' ? '\r\n' : marker === 'r' ? '\r' : '\n'
        })
      }
      return transaction.docChanged ? applyCodeDocumentChanges(raw, transaction.changes) : raw
    },
  })
  return {
    extension: [rawText, invertedEffects.of(transaction => transaction.docChanged
      ? [restoreTerminators.of(markers(transaction.startState.field(rawText)))] : [])],
    text: state => state.field(rawText),
  }
}

export async function loadCodeDocumentLanguage(path: string): Promise<Extension> {
  if (!isCodeDocumentPath(path)) return []
  const { languages } = await import('@codemirror/language-data')
  const name = (path.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  const extension = name.split('.').at(-1) ?? ''
  const aliases: Record<string, string> = {
    cjs: 'JavaScript', mjs: 'JavaScript', mts: 'TypeScript', cts: 'TypeScript',
    jsonc: 'JSON', json5: 'JSON', pyi: 'Python', svg: 'XML',
  }
  const language = aliases[extension]
    ? languages.find(language => language.name === aliases[extension])
    : languages.find(language => language.filename?.test(name))
      ?? languages.find(language => language.extensions.includes(extension))
  return language ? language.load() : []
}
