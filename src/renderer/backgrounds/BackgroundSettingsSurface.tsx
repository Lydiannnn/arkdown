import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  copyBackgroundSettings,
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundPresentation,
  type BackgroundSettings,
  type BackgroundTarget,
} from '../../shared/background-settings'
import type { BackgroundSettingsRoute } from './background-settings-route'
import { BackgroundSettingsPage } from './BackgroundSettingsPage'
import { applyMainWindowTheme, initialMainWindowTheme, useResolvedMainWindowTheme } from '../app/main-window-theme'
import { themeColorRgbChannels } from '../../shared/theme-color'

interface OperationFailure {
  message: string
  retry?(): void
}

export interface BackgroundSettingsSurfaceProps {
  route: BackgroundSettingsRoute
}

function targetForRoute(route: BackgroundSettingsRoute): BackgroundTarget {
  return route.target === 'main'
    ? { kind: 'main' }
    : { kind: 'sticky-note', noteId: route.noteId }
}

export function BackgroundSettingsSurface({ route }: BackgroundSettingsSurfaceProps) {
  const [theme, setTheme] = useState(initialMainWindowTheme)
  const resolvedTheme = useResolvedMainWindowTheme(theme)
  useEffect(() => { applyMainWindowTheme(resolvedTheme) }, [resolvedTheme])
  useEffect(() => {
    let active = true
    let changed = false
    const applyTheme = (snapshot: import('../../shared/editor-appearance-preferences').EditorAppearanceSnapshot) => {
      if (!active) return
      setTheme(snapshot.appearance.editorTheme)
      document.documentElement.style.setProperty('--theme-color-rgb', themeColorRgbChannels(snapshot.appearance.themeColor))
    }
    const unsubscribe = window.arkdown.onEditorAppearancePreferencesChanged?.(snapshot => {
      changed = true
      applyTheme(snapshot)
    })
    void window.arkdown.getEditorAppearancePreferences?.().then(result => {
      if (result.ok && !changed) applyTheme(result.value)
    }).catch(() => undefined)
    return () => { active = false; unsubscribe?.() }
  }, [])
  const target = useMemo(() => targetForRoute(route), [route])
  const [settings, setSettings] = useState<BackgroundSettings>(() => (
    copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS)
  ))
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [failure, setFailure] = useState<OperationFailure | null>(null)

  const applyPresentation = useCallback((presentation: BackgroundPresentation) => {
    setSettings(copyBackgroundSettings(presentation.settings))
    setImageUrl(presentation.imageUrl)
  }, [])

  const loadPresentation = useCallback(async () => {
    const result = await window.arkdown.getBackgroundPresentation(target)
    if (result.ok) {
      applyPresentation(result.value)
      setFailure(null)
      return
    }
    setFailure({
      message: result.error.message,
      retry: () => void loadPresentation(),
    })
  }, [applyPresentation, target])

  useEffect(() => {
    void loadPresentation()
  }, [loadPresentation])

  const chooseImage = useCallback(async () => {
    const result = await window.arkdown.chooseBackgroundImage(target)
    if (!result.ok) {
      setFailure({ message: result.error.message, retry: () => void chooseImage() })
      return
    }
    if (result.value !== null) applyPresentation(result.value)
    setFailure(null)
  }, [applyPresentation, target])

  const removeImage = useCallback(async () => {
    const result = await window.arkdown.removeBackgroundImage(target)
    if (!result.ok) {
      setFailure({ message: result.error.message, retry: () => void removeImage() })
      return
    }
    applyPresentation(result.value)
    setFailure(null)
  }, [applyPresentation, target])

  const preview = useCallback(async (nextSettings: BackgroundSettings) => {
    const copied = copyBackgroundSettings(nextSettings)
    setSettings(copied)
    const result = await window.arkdown.previewBackground(target, copied)
    if (!result.ok) {
      setFailure({ message: result.error.message, retry: () => void preview(copied) })
      return
    }
    setFailure(null)
  }, [target])

  const cancel = useCallback(async () => {
    const result = await window.arkdown.cancelBackgroundSettings(target)
    if (!result.ok) {
      setFailure({ message: result.error.message, retry: () => void cancel() })
      return
    }
    setFailure(null)
  }, [target])

  const apply = useCallback(async (nextSettings: BackgroundSettings) => {
    const copied = copyBackgroundSettings(nextSettings)
    setSettings(copied)
    const result = await window.arkdown.applyBackground(target, copied)
    if (!result.ok) {
      setFailure({ message: result.error.message, retry: () => void apply(copied) })
      return
    }
    if ('status' in result.value) {
      setFailure({ message: '背景设置已在其他窗口修改，当前草稿已保留。请关闭此窗口后重新打开，核对最新设置再修改。' })
      return
    }
    applyPresentation(result.value)
    await cancel()
  }, [applyPresentation, cancel, target])

  return <>
    <BackgroundSettingsPage
      imageUrl={imageUrl}
      onApply={(nextSettings) => void apply(nextSettings)}
      onCancel={() => void cancel()}
      onChooseImage={() => void chooseImage()}
      onPreview={(nextSettings) => void preview(nextSettings)}
      onRemoveImage={() => void removeImage()}
      settings={settings}
    />
    {failure && <div className="background-settings-surface__error" role="alert">
      <span>{failure.message}</span>
      {failure.retry && <button onClick={failure.retry} type="button">重试</button>}
    </div>}
  </>
}
