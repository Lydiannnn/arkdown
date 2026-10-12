import type { ArkdownRendererApi } from '../preload/arkdown-api'

declare global {
  interface Window {
    arkdown: ArkdownRendererApi
  }
}

export {}
