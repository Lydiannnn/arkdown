import { useEffect } from 'react'
import { createScreenshotOcrHostController } from './screenshot-ocr-host'
import type { ArkdownApi } from '../../shared/contracts'

let appOwnedHost: {
  api: ArkdownApi
  controller: ReturnType<typeof createScreenshotOcrHostController>
  onPageHide: () => void
} | undefined

function startAppOwnedHost(api: ArkdownApi): void {
  if (!api.onScreenshotOcrHostCommand || !api.onScreenshotOcrModelState
    || !api.submitScreenshotOcr || !api.settleScreenshotOcr) return
  if (appOwnedHost?.api === api) {
    appOwnedHost.controller.start()
    return
  }
  if (appOwnedHost) {
    window.removeEventListener('pagehide', appOwnedHost.onPageHide)
    appOwnedHost.controller.dispose()
  }
  const controller = createScreenshotOcrHostController({
    subscribe: (listener) => api.onScreenshotOcrHostCommand!(listener),
    subscribeModelState: (listener) => api.onScreenshotOcrModelState!(listener),
    submit: (input) => api.submitScreenshotOcr!(input),
    settle: (input) => api.settleScreenshotOcr!(input),
  })
  const onPageHide = () => {
    if (appOwnedHost?.controller !== controller) return
    controller.dispose()
    appOwnedHost = undefined
  }
  appOwnedHost = { api, controller, onPageHide }
  window.addEventListener('pagehide', onPageHide, { once: true })
  controller.start()
}

export function ScreenshotOcrHost() {
  useEffect(() => {
    startAppOwnedHost(window.arkdown)
  }, [])
  return null
}
