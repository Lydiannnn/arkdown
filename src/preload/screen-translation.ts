import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { SCREEN_TRANSLATION_CHANNEL, SCREEN_TRANSLATION_STATE, type ScreenTranslationApi,
  type ScreenTranslationSnapshot } from '../shared/screen-translation'

export function exposeScreenTranslationApi(): void {
  const request = async (input: Record<string, unknown>) => {
    const result = await ipcRenderer.invoke(SCREEN_TRANSLATION_CHANNEL, input)
    if (!result?.ok) throw new Error(typeof result?.error === 'string' ? result.error : '悬浮翻译窗操作失败。')
    return result.value
  }
  const api: ScreenTranslationApi = {
    getState: options => request({ method: 'state', ...(options?.reloadSettings === true ? { reloadSettings: true } : {}) }),
    updateSettings: (patch, observed) => request({ method: 'settings', patch, ...(observed ? { observed } : {}) }),
    command: action => request({ method: 'command', action }),
    saveBaiduCredentials: ({ apiKey, secretKey }) => request({ method: 'credentials', apiKey, secretKey }),
    onState: listener => {
      const receive = (_event: IpcRendererEvent, state: ScreenTranslationSnapshot) => listener(state)
      ipcRenderer.on(SCREEN_TRANSLATION_STATE, receive)
      return () => ipcRenderer.removeListener(SCREEN_TRANSLATION_STATE, receive)
    },
  }
  contextBridge.exposeInMainWorld('arkScreenTranslation', api)
}
