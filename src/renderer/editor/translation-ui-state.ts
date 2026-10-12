import type { PublicErrorCode } from '../../shared/public-errors'

export type TranslationUiStatus =
  | 'ready'
  | 'starting'
  | 'streaming'
  | 'completed'
  | 'stopped'
  | 'failed'

export interface TranslationUiState {
  requestId: string | null
  status: TranslationUiStatus
  output: string
  errorCode: PublicErrorCode | null
  error: string | null
}

export const PARTIAL_TRANSLATION_TIMEOUT_MESSAGE = '翻译内容过多，请分批次翻译'

export function isPartialTranslationTimeout(state: TranslationUiState): boolean {
  return state.status === 'failed'
    && state.errorCode === 'MODEL_TIMEOUT'
    && state.output !== ''
}

export type TranslationUiStateEvent =
  | { type: 'completed' }
  | { type: 'stopped' }

export function reduceTranslationUiState(
  state: TranslationUiState,
  event: TranslationUiStateEvent,
): TranslationUiState {
  switch (event.type) {
    case 'completed':
      return {
        ...state,
        requestId: null,
        status: 'completed',
        errorCode: null,
        error: null,
      }
    case 'stopped':
      return {
        ...state,
        requestId: null,
        status: 'stopped',
        errorCode: null,
        error: null,
      }
  }
}
