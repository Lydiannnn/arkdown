export interface ScreenTranslationComponentState {
  status: 'absent' | 'installing' | 'installed' | 'failed'
  version: string
  downloadBytes: number
  progress: {
    phase: 'downloading' | 'verifying' | 'extracting'
    receivedBytes: number
    totalBytes: number
  } | null
  error: string | null
}
