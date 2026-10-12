import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { isMermaidLanguage } from '../../src/renderer/editor/mermaid/mermaid-types'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies: Record<string, string>
}

it('pins the audited Mermaid runtime dependencies', () => {
  expect(packageJson.dependencies.mermaid).toBe('11.17.2')
  expect(packageJson.dependencies.dompurify).toBe('3.4.12')
})

it.each([
  ['mermaid', true],
  [' MERMAID ', true],
  ['mermaidjs', false],
  ['latex', false],
  ['', false],
])('recognizes Mermaid language value %j as %s', (value, expected) => {
  expect(isMermaidLanguage(value)).toBe(expected)
})
