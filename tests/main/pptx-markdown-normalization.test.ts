import { describe, expect, it } from 'vitest'
import { normalizePptxMarkdown } from '../../src/main/document-conversion/pptx-markdown-normalization'

describe('PPTX Markdown normalization', () => {
  it('collapses CommonMark soft breaks while preserving blocks and explicit hard breaks', () => {
    const input = [
      '<!-- Slide number: 1 -->',
      '1',
      'Slide title',
      '',
      'First text box',
      'Second text box',
      '',
      '## Heading',
      '',
      '- first item',
      '- second item',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | 1 |',
      '',
      'Hard break  ',
      'continues here',
      '',
      '```text',
      'line one',
      'line two',
      '```',
    ].join('\n')

    expect(normalizePptxMarkdown(input)).toBe([
      '<!-- Slide number: 1 -->',
      '1 Slide title',
      '',
      'First text box Second text box',
      '',
      '## Heading',
      '',
      '- first item',
      '- second item',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | 1 |',
      '',
      'Hard break  ',
      'continues here',
      '',
      '```text',
      'line one',
      'line two',
      '```',
    ].join('\n'))
  })

  it('preserves repeated blockquote container markers', () => {
    const input = [
      '> first quoted line',
      '> second quoted line',
      '',
      '> nested first line',
      '> > nested second line',
    ].join('\n')

    expect(normalizePptxMarkdown(input)).toBe(input)
  })
})
