import { describe, expect, it } from 'vitest'
import { applySourceTextCommand } from '../../src/renderer/editor/context-menu/source-editor-commands'

describe('applySourceTextCommand', () => {
  it.each([
    ['toggle-strong', '**text**'],
    ['toggle-emphasis', '*text*'],
    ['toggle-strike', '~~text~~'],
    ['toggle-inline-code', '`text`'],
    ['toggle-link', '[text](https://)'],
    ['toggle-underline', '<u>text</u>'],
    ['toggle-inline-formula', '$text$'],
    ['toggle-highlight', '<mark>text</mark>'],
    ['toggle-superscript', '<sup>text</sup>'],
    ['toggle-subscript', '<sub>text</sub>'],
  ])('formats the selected text for %s', (command, markdown) => {
    expect(applySourceTextCommand('before text after', 7, 11, command)).toEqual({
      markdown: `before ${markdown} after`,
      anchor: 7,
      head: 7 + markdown.length,
    })
  })

  it('toggles an exact wrapper and places a collapsed cursor inside new delimiters', () => {
    expect(applySourceTextCommand('<u>text</u>', 0, 11, 'toggle-underline')).toEqual({
      markdown: 'text',
      anchor: 0,
      head: 4,
    })
    expect(applySourceTextCommand('before after', 7, 7, 'toggle-highlight')).toEqual({
      markdown: 'before <mark></mark>after',
      anchor: 13,
      head: 13,
    })
  })

  it('clears only bounded inline styles while preserving links and formulas', () => {
    const selected = '**bold** *em* ~~strike~~ `code` <u>under</u> <mark>hi</mark> <sup>2</sup> <sub>3</sub> [link](https://example.com) $x+y$'
    const result = applySourceTextCommand(selected, 0, selected.length, 'clear-inline-formatting')
    expect(result.markdown).toBe('bold em strike code under hi 2 3 [link](https://example.com) $x+y$')
    expect(result.anchor).toBe(0)
    expect(result.head).toBe(result.markdown.length)
  })

  it('does not run the clear parser over an oversized selection', () => {
    const markdown = `**${'x'.repeat(1_000_001)}**`
    expect(applySourceTextCommand(markdown, 0, markdown.length, 'clear-inline-formatting'))
      .toEqual({ markdown, anchor: 0, head: markdown.length })
  })

  it('moves the complete selected line up and down', () => {
    expect(applySourceTextCommand('one\ntwo\nthree', 4, 7, 'move-line-up')).toEqual({
      markdown: 'two\none\nthree',
      anchor: 0,
      head: 3,
    })
    expect(applySourceTextCommand('one\ntwo\nthree', 4, 7, 'move-line-down')).toEqual({
      markdown: 'one\nthree\ntwo',
      anchor: 10,
      head: 13,
    })
  })
})
