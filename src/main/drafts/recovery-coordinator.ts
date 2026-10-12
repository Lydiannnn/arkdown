import type { DraftSummary, RecoveredDraft } from './draft-types'

interface RecoveryDraftStore {
  listRecoverable(includeIgnored?: boolean): Promise<DraftSummary[]>
  isClaimed?(draftId: string): boolean
  read(draftId: string): Promise<RecoveredDraft | null>
  markIgnored(draftId: string): Promise<void>
}

export interface RecoveryResult {
  found: number
  recovered: number
  ignored: number
}

export class RecoveryCoordinator {
  private flight: Promise<RecoveryResult> | null = null
  constructor(private readonly options: {
    drafts: RecoveryDraftStore
    prompt(summaries: DraftSummary[]): Promise<'recover' | 'ignore'>
    open(draft: RecoveredDraft): Promise<void> | void
  }) {}

  promptAndOpen(includeIgnored = false): Promise<RecoveryResult> {
    if (this.flight) return this.flight
    const flight = this.run(includeIgnored).finally(() => {
      if (this.flight === flight) this.flight = null
    })
    this.flight = flight
    return flight
  }

  private async run(includeIgnored: boolean): Promise<RecoveryResult> {
    const summaries = (await this.options.drafts.listRecoverable(includeIgnored))
      .filter((summary) => !this.options.drafts.isClaimed?.(summary.draftId))
    const result: RecoveryResult = {
      found: summaries.length,
      recovered: 0,
      ignored: 0,
    }
    if (summaries.length === 0) return result

    const decision = await this.options.prompt(summaries)
    if (decision === 'ignore') {
      for (const summary of summaries) {
        await this.options.drafts.markIgnored(summary.draftId)
        result.ignored += 1
      }
      return result
    }

    for (const summary of summaries) {
      const draft = await this.options.drafts.read(summary.draftId)
      if (!draft) continue
      await this.options.open(draft)
      result.recovered += 1
    }
    return result
  }
}
