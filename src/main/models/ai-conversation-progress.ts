import { randomUUID } from 'node:crypto'
import type { AiProcessEvent, AiProcessStage, AiProcessToolEvent } from '../../shared/ai-process-events'
import { AiProcessBatcher } from './ai-process-batcher'
import type { ModelProcessDelta } from './model-process-delta'

export type AiConversationToolFacts = Omit<AiProcessToolEvent, 'type' | 'requestId' | 'messageId' | 'round' | 'sequence'>

/** Display-only request state. Callers remain responsible for tool admission and
 * confirmed outcomes; this object never grants authority or changes replay. */
export class AiConversationProgress {
  private round = 0
  private sequence = 0
  private messageId: string | undefined
  private phase: 'streaming' | 'tools' | 'terminal' = 'tools'
  private stage: AiProcessStage | undefined
  private batcher: AiProcessBatcher | undefined
  private displayEnabled = true
  private readonly itemIds = new Map<string, string>()

  constructor(private readonly options: {
    requestId: string
    signal: AbortSignal
    isCurrent(): boolean
    emit(event: AiProcessEvent): void
  }) {}

  private owned(): boolean {
    if (this.phase === 'terminal') return false
    try { if (this.options.isCurrent()) return true } catch { /* Optional display ownership fails closed. */ }
    this.dispose()
    return false
  }

  modelRoundIsCurrent(round: number): boolean {
    return this.phase === 'streaming' && this.round === round && !this.options.signal.aborted && this.owned()
  }

  beginRound(messageId: string, visible = true): number {
    this.closeText()
    if (!this.owned() || this.options.signal.aborted) return this.round
    this.round += 1
    this.messageId = messageId
    this.phase = 'streaming'
    this.stage = undefined
    this.itemIds.clear()
    const round = this.round
    this.batcher = new AiProcessBatcher({
      isCurrent: () => this.modelRoundIsCurrent(round),
      emit: delta => {
        let itemId = this.itemIds.get(delta.itemId)
        if (!itemId) {
          if (this.itemIds.size >= 2048) {
            // Bound identity metadata without hiding new semantic progress. An
            // evicted provider item may return as another opaque display fragment;
            // adapter deduplication and provider replay remain independent.
            const oldest = this.itemIds.keys().next().value
            if (oldest !== undefined) this.itemIds.delete(oldest)
          }
          itemId = randomUUID(); this.itemIds.set(delta.itemId, itemId)
        }
        this.publish({ type: 'process-text', ...delta, itemId })
      },
    })
    if (visible) this.setStage('waiting-model')
    return round
  }

  append(round: number, delta: ModelProcessDelta): void {
    if (this.displayEnabled && this.modelRoundIsCurrent(round)) this.batcher?.append(delta)
  }

  reasoning(round: number, active: boolean): void {
    if (!this.modelRoundIsCurrent(round)) return
    if (active) this.setStage('thinking')
    else if (this.stage === 'thinking') this.setStage('waiting-model')
  }

  answering(round: number): void {
    if (this.modelRoundIsCurrent(round)) this.setStage('answering')
  }

  setStage(stage: AiProcessStage): void {
    if (this.options.signal.aborted || !this.owned() || !this.messageId || stage === this.stage) return
    const toolStage = stage === 'awaiting-approval' || stage === 'tool-running'
    if (toolStage !== (this.phase === 'tools')) return
    this.batcher?.flush()
    if (this.options.signal.aborted || !this.owned()) return
    this.stage = stage
    this.publish({ type: 'process-stage', stage })
  }

  tool(facts: AiConversationToolFacts, trustedSettlement = false): void {
    if (this.phase !== 'tools' || !this.messageId || !this.owned()) return
    if (this.options.signal.aborted && !(trustedSettlement && ['succeeded', 'failed', 'unknown'].includes(facts.status))) return
    this.publish({ type: 'process-tool', ...facts })
  }

  /** Before message-completed, cancellation abort or any request terminal. */
  closeText(): void {
    this.batcher?.close()
    this.batcher = undefined
    if (this.phase !== 'terminal') this.phase = 'tools'
  }

  finish(): void { this.closeText(); this.dispose() }

  dispose(): void {
    this.batcher?.dispose()
    this.batcher = undefined
    this.phase = 'terminal'
    this.itemIds.clear()
  }

  private publish(event: Omit<Extract<AiProcessEvent, { type: 'process-text' }>, 'requestId' | 'messageId' | 'round' | 'sequence'>
    | { type: 'process-stage'; stage: AiProcessStage } | ({ type: 'process-tool' } & AiConversationToolFacts)): void {
    if (!this.displayEnabled || !this.messageId || !this.owned()) return
    try {
      this.options.emit({ ...event, requestId: this.options.requestId, messageId: this.messageId,
        round: this.round, sequence: ++this.sequence })
    } catch {
      // A broken optional display sink must not retire the real model round.
      this.displayEnabled = false
      this.batcher?.dispose()
      this.itemIds.clear()
    }
  }
}
