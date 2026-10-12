import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TranslationHistoryView } from '../../src/renderer/editor/TranslationHistoryView'
import type { TranslationHistoryRecord } from '../../src/renderer/editor/translation-history'

function record(overrides: Partial<TranslationHistoryRecord> = {}): TranslationHistoryRecord {
  return {
    id: 'record-1',
    requestId: 'request-1',
    documentKey: 'note.md',
    workspaceAbsolutePath: 'C:/Notes',
    documentRelativePath: 'note.md',
    documentAbsolutePath: 'C:/Notes/note.md',
    documentRevision: 'revision-a',
    mode: 'visual',
    source: { markdown: '**source**', plainText: 'source' },
    translatedMarkdown: '**bold** and [link](https://example.com)',
    modelId: 'chat-model',
    targetLanguage: 'zh-CN',
    terminal: 'completed',
    createdAt: 100,
    anchor: {
      mode: 'visual',
      from: 1,
      to: 7,
      blockStart: 0,
      fingerprint: { before: '', selected: 'source', after: '' },
      status: 'valid',
    },
    ...overrides,
  }
}

it('renders safe Markdown, copies raw Markdown, and exposes record metadata', () => {
  const onCopy = vi.fn()
  const markdown = '**bold** and [link](https://example.com)\n\n<img src=x onerror="alert(1)">'
  const { container } = render(
    <TranslationHistoryView
      onCopy={onCopy}
      record={record({ translatedMarkdown: markdown })}
    />,
  )

  expect(screen.getByRole('region', { name: '翻译记录' })).toHaveFocus()
  expect(screen.getByText('bold').tagName).toBe('STRONG')
  expect(container.querySelector('img')).toBeNull()
  expect(screen.getByText('状态：已完成')).toBeVisible()
  expect(screen.getByText('模型：chat-model')).toBeVisible()
  expect(screen.getByText('目标语言：zh-CN')).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: '复制译文' }))
  expect(onCopy).toHaveBeenCalledWith(markdown)

  const copy = screen.getByRole('button', { name: '复制译文' })
  expect(copy).toHaveClass('translation-icon-action', 'translation-history-copy-button')
  expect(copy).toHaveAttribute('data-tooltip', '复制译文')
  expect(copy).toHaveTextContent('')
  expect(copy.querySelector('svg')).toBeInTheDocument()
})

it.each([
  ['stopped', '已停止'],
  ['timeout-partial', '部分结果超时'],
] as const)('labels the %s terminal state', (terminal, label) => {
  render(
    <TranslationHistoryView
      onCopy={() => undefined}
      record={record({ terminal })}
    />,
  )
  expect(screen.getByText(`状态：${label}`)).toBeVisible()
})

it('announces an invalid source anchor without presenting it as clickable', () => {
  render(
    <TranslationHistoryView
      onCopy={() => undefined}
      record={record({
        anchor: {
          mode: 'source',
          from: 0,
          to: 6,
          lineStart: 0,
          fingerprint: { before: '', selected: 'source', after: '' },
          status: 'location-changed',
        },
      })}
    />,
  )

  expect(screen.getByText('原文位置已变化')).toBeVisible()
  expect(screen.queryByRole('button', { name: '原文位置已变化' })).not.toBeInTheDocument()
})

it('keeps history metadata, output, copy, and navigation in the annotated sidebar structure', () => {
  const style = document.createElement('style')
  style.textContent = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/selection-translation.css'),
    'utf8',
  )
  document.head.append(style)

  try {
    const { container } = render(
      <TranslationHistoryView
        onCopy={() => undefined}
        record={record()}
      />,
    )

    const history = screen.getByRole('region', { name: '翻译记录' })
    const metadata = container.querySelector<HTMLElement>('.translation-history-metadata')!
    const output = container.querySelector<HTMLElement>('.translation-history-output')!
    const copy = screen.getByRole('button', { name: '复制译文' })
    const copyAction = copy.closest<HTMLElement>('.translation-history-copy-action')!

    expect(history).toHaveFocus()
    expect(container.querySelector('.translation-history-header')).toBeNull()
    expect(container.querySelector('.translation-history-navigation')).toBeNull()
    expect(getComputedStyle(metadata).marginTop).toBe('20px')
    expect(getComputedStyle(metadata).paddingBottom).toBe('20px')
    expect(getComputedStyle(output).marginTop).toBe('26.6667px')
    expect(getComputedStyle(copyAction).marginTop).toBe('21.3333px')
  } finally {
    style.remove()
  }
})
