import { describe, expect, it } from 'vitest'
import { computeLineEditIndicators } from '../../src/renderer/editor/edit-indicators/line-diff'

function states(
  openingMarkdown: string,
  savedMarkdown: string,
  currentMarkdown: string,
) {
  return computeLineEditIndicators({ openingMarkdown, savedMarkdown, currentMarkdown })
}

describe('computeLineEditIndicators', () => {
  it('classifies unchanged, inserted, and deleted visible lines against stable alignments', () => {
    expect(states('alpha\nbeta', 'alpha\nbeta', 'alpha\nbeta')).toEqual({
      states: ['none', 'none'],
      openingLineCount: 2,
      savedLineCount: 2,
      currentLineCount: 2,
    })

    expect(states('alpha\ngamma', 'alpha\ngamma', 'alpha\nbeta\ngamma').states)
      .toEqual(['none', 'unsaved', 'none'])
    expect(states('alpha', 'alpha', 'alpha\nomega').states)
      .toEqual(['none', 'unsaved'])

    expect(states('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma', 'alpha\ngamma').states)
      .toEqual(['none', 'unsaved'])
    expect(states('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma', 'alpha\nbeta').states)
      .toEqual(['none', 'unsaved'])
    expect(states('alpha\nbeta', 'alpha\nbeta', '').states).toEqual(['unsaved'])
  })

  it('marks the current side and surviving deletion boundary when lines move', () => {
    const result = states('alpha\nbeta\ngamma', 'alpha\nbeta\ngamma', 'beta\nalpha\ngamma')

    expect(result.states).toEqual(['unsaved', 'unsaved', 'none'])
  })

  it('uses a deterministic repeated-line tie break', () => {
    const input = {
      openingMarkdown: 'same\nremoved\nsame',
      savedMarkdown: 'same\nremoved\nsame',
      currentMarkdown: 'same\nsame',
    }

    expect(computeLineEditIndicators(input).states).toEqual(['none', 'unsaved'])
    expect(computeLineEditIndicators(input)).toEqual(computeLineEditIndicators(input))
  })

  it('normalizes only Markdown line endings before comparing', () => {
    expect(states('alpha\r\nbeta', 'alpha\nbeta', 'alpha\rbeta').states)
      .toEqual(['none', 'none'])
    expect(states('café', 'café', 'cafe\u0301').states).toEqual(['unsaved'])
  })

  it('gives unsaved priority, exposes saved edits, and clears exact opening reversions', () => {
    expect(states('alpha\nbeta', 'alpha\nBETA', 'alpha\nBETA').states)
      .toEqual(['none', 'saved'])
    expect(states('alpha\nbeta', 'alpha\nBETA', 'alpha\nlatest').states)
      .toEqual(['none', 'unsaved'])
    expect(states('alpha\nbeta', 'alpha\nBETA', 'alpha\nbeta').states)
      .toEqual(['none', 'none'])
  })

  it('does not mark the untouched blank line after a saved line replacement', () => {
    expect(states(
      'alpha\nold value\n\nomega',
      'alpha\nnew value\n\nomega',
      'alpha\nnew value\n\nomega',
    ).states).toEqual(['none', 'saved', 'none', 'none'])
  })

  it('does not project a replacement deletion onto a repeated untouched blank line', () => {
    expect(states(
      'a\n\nb\n\nc\n\nd\n\ne',
      'A\n\nB\n\nc\n\nD\n\ne',
      'A\n\nB\n\nc\n\nD\n\ne',
    ).states).toEqual([
      'saved', 'none', 'saved', 'none', 'none', 'none', 'saved', 'none', 'none',
    ])
  })

  it('projects saved deletion boundaries through later unsaved insertions', () => {
    expect(states(
      'a\nx\nb\nc',
      'a\nb\nc',
      'a\ny\nb\nc',
    ).states).toEqual(['none', 'unsaved', 'saved', 'none'])
  })

  it('projects an EOF saved deletion onto the same repeated line before a later EOF insert', () => {
    expect(states(
      'a\nsame\nsame\nz',
      'a\nsame\nsame',
      'a\nsame\nsame\ntail',
    ).states).toEqual(['none', 'none', 'saved', 'unsaved'])
  })

  it('is deterministic and non-mutating for a large repeated-value edit', () => {
    const openingLines = Array.from({ length: 5_000 }, (_, index) => (
      index % 7 === 0 ? 'repeat' : `line-${index}`
    ))
    const savedLines = [...openingLines]
    const currentLines = [...savedLines]
    currentLines.splice(1_250, 17, 'insert-a', 'repeat', 'insert-b')
    currentLines.splice(3_400, 0, 'repeat', 'insert-c')
    const input = {
      openingMarkdown: openingLines.join('\n'),
      savedMarkdown: savedLines.join('\n'),
      currentMarkdown: currentLines.join('\n'),
    }
    const untouched = { ...input }

    const first = computeLineEditIndicators(input)
    const second = computeLineEditIndicators(input)

    expect(first).toEqual(second)
    expect(first.states).toHaveLength(currentLines.length)
    expect(input).toEqual(untouched)
  })
})
