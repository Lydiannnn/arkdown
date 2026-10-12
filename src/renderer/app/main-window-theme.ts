import { useEffect, useState } from 'react'
import { isEditorTheme, resolveEditorTheme, type EditorTheme } from '../../shared/editor-appearance-preferences'

// The main process passes this so the first paint uses the persisted theme.
export function initialMainWindowTheme(search = window.location.search): EditorTheme {
  const value = new URLSearchParams(search).get('theme')
  return isEditorTheme(value) ? value : 'system'
}

export function prefersDarkMainWindow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function useResolvedMainWindowTheme(theme: EditorTheme) {
  const [systemDark, setSystemDark] = useState(prefersDarkMainWindow)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(query.matches)
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return resolveEditorTheme(theme, systemDark)
}

export function applyMainWindowTheme(theme: EditorTheme, systemDark = prefersDarkMainWindow()): void {
  document.documentElement.dataset.arkdownTheme = resolveEditorTheme(theme, systemDark)
}
