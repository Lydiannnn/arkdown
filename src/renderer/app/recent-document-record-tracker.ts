const SUCCESSFUL_DOCUMENT_LIMIT = 32

export interface RecentDocumentRecordInput {
  absolutePath: string
  revision: string | null
  savedMarkdown: string
}

export interface RecentDocumentRecordAttempt {
  complete(success: boolean): void
}

function documentKey(absolutePath: string): string {
  return absolutePath.replaceAll('/', '\\').toLocaleLowerCase('en-US')
}

function compactMarkdownDigest(markdown: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < markdown.length; index += 1) {
    const code = markdown.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
    second ^= second >>> 13
  }
  return [
    markdown.length.toString(36),
    (first >>> 0).toString(36),
    (second >>> 0).toString(36),
  ].join(':')
}

export function recentDocumentRecordSignature(input: RecentDocumentRecordInput): string {
  const contentIdentity = input.revision
    ? `revision:${input.revision.toLocaleLowerCase('en-US')}`
    : `markdown:${compactMarkdownDigest(input.savedMarkdown)}`
  return `${documentKey(input.absolutePath)}\0${contentIdentity}`
}

export class RecentDocumentRecordTracker {
  private readonly successfulByDocument = new Map<string, string>()
  private readonly inFlight = new Set<string>()

  begin(input: RecentDocumentRecordInput): RecentDocumentRecordAttempt | null {
    const key = documentKey(input.absolutePath)
    const signature = recentDocumentRecordSignature(input)
    if (this.successfulByDocument.get(key) === signature || this.inFlight.has(signature)) {
      return null
    }
    this.inFlight.add(signature)
    let completed = false
    return {
      complete: (success) => {
        if (completed) return
        completed = true
        this.inFlight.delete(signature)
        if (!success) return
        this.successfulByDocument.delete(key)
        this.successfulByDocument.set(key, signature)
        while (this.successfulByDocument.size > SUCCESSFUL_DOCUMENT_LIMIT) {
          const oldest = this.successfulByDocument.keys().next().value as string | undefined
          if (oldest === undefined) break
          this.successfulByDocument.delete(oldest)
        }
      },
    }
  }
}
