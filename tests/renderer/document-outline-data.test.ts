import { expect, it } from 'vitest'
import { extractOutline, outlineHeadingOffset } from '../../src/renderer/workspace/workspace-navigation'

it('matches rendered heading order including setext, nested headings and formatted titles', () => {
  const markdown = '开始\n===\n\n> ## **引用**标题\n\n```md\n# 示例\n```\n\n### [继续](https://example.com)'
  expect(extractOutline(markdown)).toEqual([
    { depth: 1, text: '开始', index: 0 }, { depth: 2, text: '引用标题', index: 1 },
    { depth: 3, text: '继续', index: 2 },
  ])
  expect(outlineHeadingOffset(markdown, 2)).toBe(markdown.indexOf('###'))
  expect(outlineHeadingOffset(markdown, 3)).toBeUndefined()
})
