import type { AiProcessKind } from '../../shared/ai-process-events'

/** Optional readable-provider channel. Adapters emit new suffixes only.
 * Original replay, final answer and all structured translation output remain separate. */
export interface ModelProcessDelta {
  kind: AiProcessKind
  itemId: string
  segmentIndex: number
  delta: string
  delivery: 'stream' | 'complete'
}
