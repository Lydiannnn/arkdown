import { contextBridge, ipcRenderer } from 'electron'
import type { RuntimeInstallSnapshot, RuntimeInstallerApi } from '../shared/runtime-component'

const token = process.argv.find(value => value.startsWith('--arkdown-runtime-installer='))?.split('=')[1]
if (token && /^[0-9a-f-]{36}$/u.test(token)) {
  const channel = `runtime-installer:${token}`
  const api: RuntimeInstallerApi = {
    getState: () => ipcRenderer.invoke(`${channel}:state`),
    retry: () => ipcRenderer.invoke(`${channel}:retry`),
    cancel: () => ipcRenderer.invoke(`${channel}:cancel`),
    subscribe(listener) {
      const receive = (_event: unknown, snapshot: RuntimeInstallSnapshot) => listener(snapshot)
      ipcRenderer.on(`${channel}:changed`, receive)
      return () => { ipcRenderer.removeListener(`${channel}:changed`, receive) }
    },
  }
  contextBridge.exposeInMainWorld('runtimeInstaller', Object.freeze(api))
}
