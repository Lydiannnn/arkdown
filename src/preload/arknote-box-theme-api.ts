import { ARKNOTE_BOX_THEME_CHANNEL, ARKNOTE_BOX_THEME_EVENT, parseArknoteBoxTheme, type ArknoteBoxThemeApi } from '../shared/arknote-box-theme'
export function createArknoteBoxThemeApi(ipc: {
  invoke(channel: string): Promise<unknown>
  on(channel: string, listener: (_event: unknown, payload: unknown) => void): unknown
  removeListener(channel: string, listener: (_event: unknown, payload: unknown) => void): unknown
}): ArknoteBoxThemeApi {
  return {
    async get() {
      const theme = parseArknoteBoxTheme(await ipc.invoke(ARKNOTE_BOX_THEME_CHANNEL))
      if (!theme) throw new Error('无法读取便签盒子主题。')
      return theme
    },
    subscribe(listener) {
      const receive = (_event: unknown, payload: unknown) => {
        const theme = parseArknoteBoxTheme(payload)
        if (theme) listener(theme)
      }
      ipc.on(ARKNOTE_BOX_THEME_EVENT, receive)
      return () => { ipc.removeListener(ARKNOTE_BOX_THEME_EVENT, receive) }
    },
  }
}
