import { expect, it } from 'vitest'
import {
  RecentDocumentRecordTracker,
  recentDocumentRecordSignature,
} from '../../src/renderer/app/recent-document-record-tracker'

it('uses a compact digest instead of retaining revisionless Markdown in a signature', () => {
  const markdown = `# Large\n${'private body '.repeat(100_000)}`

  const signature = recentDocumentRecordSignature({
    absolutePath: 'C:/Notes/imported.docx',
    revision: null,
    savedMarkdown: markdown,
  })

  expect(signature.length).toBeLessThan(160)
  expect(signature).not.toContain('private body')
})

it('keeps only the latest successful signature per document across many large saves', () => {
  const tracker = new RecentDocumentRecordTracker()
  const firstMarkdown = `first:${'a'.repeat(20_000)}`
  for (let index = 0; index < 100; index += 1) {
    const attempt = tracker.begin({
      absolutePath: 'C:/Notes/note.md',
      revision: null,
      savedMarkdown: index === 0 ? firstMarkdown : `${index}:${'b'.repeat(20_000)}`,
    })
    expect(attempt).not.toBeNull()
    attempt!.complete(true)
  }

  expect(tracker.begin({
    absolutePath: 'C:/Notes/note.md',
    revision: null,
    savedMarkdown: firstMarkdown,
  })).not.toBeNull()
})

it('bounds successful per-document memoization and keeps the newest entries', () => {
  const tracker = new RecentDocumentRecordTracker()
  for (let index = 0; index < 40; index += 1) {
    tracker.begin({
      absolutePath: `C:/Notes/${index}.md`,
      revision: `${index}`.padStart(64, '0'),
      savedMarkdown: '# Saved',
    })!.complete(true)
  }

  expect(tracker.begin({
    absolutePath: 'C:/Notes/39.md',
    revision: '39'.padStart(64, '0'),
    savedMarkdown: '# Changed but same revision',
  })).toBeNull()
  expect(tracker.begin({
    absolutePath: 'C:/Notes/0.md',
    revision: '0'.padStart(64, '0'),
    savedMarkdown: '# Saved',
  })).not.toBeNull()
})

it('deduplicates concurrent attempts, retries failures, and memoizes only success', () => {
  const tracker = new RecentDocumentRecordTracker()
  const input = {
    absolutePath: 'C:/Notes/note.md',
    revision: 'a'.repeat(64),
    savedMarkdown: '# Saved',
  }
  const first = tracker.begin(input)

  expect(first).not.toBeNull()
  expect(tracker.begin(input)).toBeNull()
  first!.complete(false)
  const retry = tracker.begin(input)
  expect(retry).not.toBeNull()
  retry!.complete(true)
  expect(tracker.begin(input)).toBeNull()
})
