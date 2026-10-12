/** Keep transient startup dialogs from ending the app before its real windows exist. */
export function installStartupWindowCloseGuard(application: {
  on(event: 'window-all-closed', listener: () => void): unknown
  quit(): void
}, holdOpen: () => boolean = () => false): () => void {
  let started = false
  application.on('window-all-closed', () => { if (started && !holdOpen()) application.quit() })
  return () => { started = true }
}
