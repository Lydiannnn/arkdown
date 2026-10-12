/*! Copyright (c) 2026 Miterh. Source copyright marker: YPF. */
import path from 'node:path'
import { app, protocol } from 'electron'
import {
  configureAppProfile,
  desktopAppMode,
  startDesktopApp,
} from './app-mode'
import { registerStartupProtocols } from './startup-protocols'
import { configureApplicationBranding } from './branding'
import { ArkdownLaunchBroker } from './updates/launch-broker'
import { startupDocumentIntent } from './startup-document-intent'
import { inspectUpdateStartup, acknowledgeUpdateRestart, type RestartContext } from './updates/update-restart'
import { notifyUpdateLaunchBlocked } from './updates/update-launch-gate'

const mode = desktopAppMode(process.execPath)
configureApplicationBranding(mode)
configureAppProfile({
  app,
  mode,
  portableRoot: path.dirname(process.execPath),
})

registerStartupProtocols(mode, protocol)
void (async () => {
let restart: RestartContext | undefined
if (app.isPackaged && process.platform === 'win32') {
  let inspected: Awaited<ReturnType<typeof inspectUpdateStartup>>
  try { inspected = await inspectUpdateStartup({ executablePath: process.execPath, version: app.getVersion(), argv: process.argv }) }
  catch (error) {
    await (await import('./updates/update-startup-recovery')).showUpdateStartupFailure(__dirname, error)
    app.quit(); return
  }
  if (inspected.recoverySession) { await (await import('./updates/update-startup-recovery')).recoverInterruptedUpdate(inspected.recoverySession, __dirname, mode); return }
  if (inspected.blockedByUpdate) {
    try {
      if (mode !== 'arkdown') throw new Error('Arknote waits for installation')
      const broker = new ArkdownLaunchBroker(path.resolve(process.execPath).toLowerCase() + ':' + path.resolve(app.getPath('userData')).toLowerCase())
      const paths = process.argv.slice(1).map(arg => startupDocumentIntent([process.execPath, arg], true)).filter((p): p is string => p !== null)
      await broker.forwardToRunning(paths)
    } catch { await notifyUpdateLaunchBlocked(path.dirname(process.execPath), mode).catch(() => undefined) }
    app.quit(); return
  }
  restart = inspected.restart
}
const acknowledge = async () => {
  if (!restart) return
  try { await acknowledgeUpdateRestart(restart, mode, process.pid) }
  catch (error) { console.error('Update restart acknowledgement failed; keeping the running application open', error) }
}
await startDesktopApp(mode, {
  startArkdown: async () => {
    let broker: ArkdownLaunchBroker | undefined
    let paths: string[] = []
    if (app.isPackaged && process.platform === 'win32') {
      broker = new ArkdownLaunchBroker(path.resolve(process.execPath).toLowerCase() + ':' + path.resolve(app.getPath('userData')).toLowerCase())
      paths = process.argv.slice(1).map(arg => startupDocumentIntent([process.execPath, arg], true)).filter((p): p is string => p !== null)
      if (!await broker.claim(paths)) { app.quit(); return }
      app.once('will-quit', () => { void broker?.close() })
    }
    await (await import('./arkdown-main')).startArkdown({ launchBroker: broker, additionalDocuments: paths.slice(1) })
    await acknowledge()
  },
  startArknote: async () => { await (await import('./arknote-main')).startArknote(); await acknowledge() },
})
})().catch((error) => {
  console.error(`Failed to start ${mode}`, error)
  app.quit()
})
