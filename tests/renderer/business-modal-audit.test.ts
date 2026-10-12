import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = path.join(process.cwd(), 'src/renderer')

function rendererSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return rendererSourceFiles(absolutePath)
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [absolutePath] : []
  })
}

function findNativeBusinessModalCalls(source: string, file: string): string[] {
  const patterns = [
    /\b(?:window|globalThis|self|top|parent)\s*(?:\?\.|\.)\s*(?:alert|confirm|prompt)\s*(?:\?\.)?\s*\(/gu,
    /\b(?:window|globalThis|self|top|parent)\s*(?:\?\.)?\s*\[\s*(['"])(?:alert|confirm|prompt)\1\s*\]\s*(?:\?\.)?\s*\(/gu,
    /\b(?:alert|confirm|prompt)\s*(?:\?\.)?\s*\(/gu,
  ]
  const matches = patterns.flatMap((pattern, patternIndex) => (
    Array.from(source.matchAll(pattern), (match) => ({
      index: match.index,
      end: match.index + match[0].length,
      text: match[0],
      bare: patternIndex === patterns.length - 1,
    }))
  )).filter((match) => {
    if (!match.bare) return true
    let previous = match.index - 1
    while (previous >= 0 && /\s/u.test(source[previous]!)) previous -= 1
    if (previous >= 0 && (source[previous] === '.' || source[previous] === ']')) return false
    const lineStart = source.lastIndexOf('\n', match.index - 1) + 1
    const lineEnd = source.indexOf('\n', match.index)
    const linePrefix = source.slice(lineStart, match.index)
    const lineRemainder = source.slice(match.index, lineEnd < 0 ? source.length : lineEnd)
    return linePrefix.trim() !== ''
      || !/^(?:alert|confirm|prompt)\s*\([^)]*\)\s*:/u.test(lineRemainder)
  }).sort((left, right) => left.index - right.index || right.end - left.end)
  const distinct = matches.filter((match, index) => !matches.slice(0, index).some((prior) => (
    match.index >= prior.index && match.end <= prior.end
  )))
  return distinct.map((match) => {
    const line = source.slice(0, match.index).split('\n').length
    return `${file}:${line}: ${match.text}`
  })
}

describe('renderer business modal audit', () => {
  it.each([
    ["alert('message')", 'bare alert'],
    ["confirm('continue?')", 'bare confirm'],
    ["prompt('name')", 'bare prompt'],
    ["window.alert('message')", 'window dot access'],
    ["globalThis['confirm']('continue?')", 'globalThis bracket access'],
    ["self?.prompt('name')", 'optional dot access'],
    ["window?.['alert']('message')", 'optional bracket access'],
    ["top.confirm?.('continue?')", 'optional call access'],
    ["const answer = enabled ? confirm('continue?') : false", 'bare call in a ternary'],
  ])('detects %s (%s)', (source) => {
    expect(findNativeBusinessModalCalls(source, 'mutation.ts')).toHaveLength(1)
  })

  it('does not treat controller method signatures as native calls', () => {
    expect(findNativeBusinessModalCalls(`interface DialogPort {
      alert(options: AlertOptions): Promise<void>
      confirm(options: ConfirmOptions): Promise<boolean>
      prompt(options: PromptOptions): Promise<string | null>
    }`, 'controller.ts')).toEqual([])
  })

  it('does not call browser-native alert, confirm, or prompt APIs', () => {
    const findings = rendererSourceFiles(rendererRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return findNativeBusinessModalCalls(source, path.relative(process.cwd(), file))
    })

    expect(findings).toEqual([])
  })
})
