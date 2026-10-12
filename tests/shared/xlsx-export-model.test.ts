import { describe, expect, it } from 'vitest'
import { buildXlsxRows } from '../../src/shared/xlsx-export-model'

describe('buildXlsxRows', () => {
  it('preserves source order, blank lines, visible labels, code, and media names', () => {
    expect(buildXlsxRows([
      '# Report',
      'Read [Arkdown](https://example.com) and `inline code`.',
      '',
      '![Diagram](assets/diagram.png)',
      '![](assets/photo.png)',
      '```ts',
      'const answer = 42',
      '=SUM(A1:A2)',
      '```',
      'Done',
    ].join('\n'))).toEqual([
      { kind: 'line', value: 'Report' },
      { kind: 'line', value: 'Read Arkdown and inline code.' },
      { kind: 'line', value: '' },
      { kind: 'line', value: 'Diagram' },
      { kind: 'line', value: 'photo.png' },
      { kind: 'line', value: 'const answer = 42' },
      { kind: 'line', value: '=SUM(A1:A2)' },
      { kind: 'line', value: 'Done' },
    ])
  })

  it('creates rectangular table cells, respects escaped pipes, and omits the delimiter row', () => {
    expect(buildXlsxRows([
      'Before',
      '| Name | Value |',
      '| :--- | ---: |',
      '| A \\| B | +12 |',
      '| short |',
      '| wide | -1 | @literal |',
      'After',
    ].join('\n'))).toEqual([
      { kind: 'line', value: 'Before' },
      {
        kind: 'table',
        cells: [
          ['Name', 'Value', ''],
          ['A | B', '+12', ''],
          ['short', '', ''],
          ['wide', '-1', '@literal'],
        ],
      },
      { kind: 'line', value: 'After' },
    ])
  })

  it('does not treat a pipe line without a valid Markdown delimiter as a table', () => {
    expect(buildXlsxRows('alpha | beta\nnot a delimiter\n=literal')).toEqual([
      { kind: 'line', value: 'alpha | beta' },
      { kind: 'line', value: 'not a delimiter' },
      { kind: 'line', value: '=literal' },
    ])
  })
})
