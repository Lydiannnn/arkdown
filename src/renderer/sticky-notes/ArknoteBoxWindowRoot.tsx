import { themeColorRgbChannels } from '../../shared/theme-color'
import type { ArknoteBoxThemeApi } from '../../shared/arknote-box-theme'
import { useEffect } from 'react'
import { StickyNoteBoxPanel } from './StickyNoteBoxPanel'

interface ArknoteBoxWindowRootProps {
  onClose?: () => void
}

export function ArknoteBoxWindowRoot({
  onClose = () => window.close(),
}: ArknoteBoxWindowRootProps) {
  useEffect(() => { document.title = '便签盒子 — Arknote' }, [])
  useEffect(() => {
    const api = (window as unknown as { arknoteBoxTheme?: ArknoteBoxThemeApi }).arknoteBoxTheme
    if (!api) return
    let active = true
    let changed = false
    const apply = (theme: Awaited<ReturnType<ArknoteBoxThemeApi['get']>>) => {
      if (!active) return
      document.documentElement.dataset.arkdownTheme = theme.mode === 'dark' ? 'dark' : 'minimal'
      document.documentElement.style.setProperty('--theme-color-rgb', themeColorRgbChannels(theme.themeColor))
    }
    const unsubscribe = api.subscribe(theme => { changed = true; apply(theme) })
    void api.get().then(theme => { if (!changed) apply(theme) }).catch(() => undefined)
    return () => { active = false; unsubscribe() }
  }, [])
  return <div className="arknote-box-window-root">
    <StickyNoteBoxPanel onClose={onClose} />
  </div>
}
