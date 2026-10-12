/** One editor generation owns its optional-component preparations, independently of other windows. */
export function createRuntimeComponentOwner(options: {
  publishSignal(signal: AbortSignal): void
  closeOwnedResources(): Promise<void>
  abortOwnedResourcesClose(): void
}) {
  let controller = new AbortController()
  options.publishSignal(controller.signal)
  const renew = () => {
    if (!controller.signal.aborted) return
    controller = new AbortController()
    options.publishSignal(controller.signal)
  }
  return {
    get signal() { return controller.signal },
    abort: () => controller.abort(),
    invalidate() { controller.abort(); renew() },
    prepareClose() {
      // Release download/verification IPC waiters before the close gate begins draining.
      controller.abort()
      return options.closeOwnedResources()
    },
    abortClose() {
      renew()
      options.abortOwnedResourcesClose()
    },
  }
}
