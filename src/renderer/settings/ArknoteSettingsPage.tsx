import { useEffect, useRef, useState } from 'react'
import {
  copyArknotePreferences,
  type ArknotePreferences,
} from '../../shared/arknote-preferences'
import { StickyNotePreferencesSection } from './StickyNotePreferencesSection'
import { StickyNoteMaterialSettingsPage } from './StickyNoteMaterialSettingsPage'
import { copyStickyNoteWallpaperAppearances, type StickyNoteWallpaperAppearances } from '../../shared/sticky-note-glass-appearance'
import { PreferencesShell, scrollPreferenceTarget } from './PreferencesShell'
import { AppIcon } from '../icons/AppIcon'
import { DesktopContextMenuCheckbox } from './ShellIntegrationPreferencesSection'
import { ArknoteImmediateSave } from './arknote-immediate-save'
import './search-preferences.css'
import './preferences-normalization.css'
import './arknote-standalone-preferences.css'

interface ArknoteSettingsPageProps {
  onClose?: () => void
}

export function ArknoteSettingsPage({
  onClose = () => window.close(),
}: ArknoteSettingsPageProps) {
  const [value, setValue] = useState<ArknotePreferences | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [closing, setClosing] = useState(false)
  const [materialView, setMaterialView] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const summaryScrollTopRef = useRef(0)
  const queueRef = useRef<ArknoteImmediateSave | null>(null)
  const closingRef = useRef(false)
  const finishedRef = useRef(false)
  const activeRef = useRef(false)

  useEffect(() => { document.title = '设置 — Arknote' }, [])
  useEffect(() => {
    let active = true
    activeRef.current = true
    void window.arkdown.getArknotePreferences?.().then(result => {
      if (!active) return
      if (!result.ok) { setError(result.error.message); return }
      const initial = copyArknotePreferences(result.value)
      setValue(initial)
      queueRef.current = new ArknoteImmediateSave(initial, async input => {
        const saved = await window.arkdown.setArknotePreferences?.(input)
        if (!saved?.ok) throw new Error('设置保存失败')
        return saved.value
      }, state => {
        if (!activeRef.current) return
        setValue(state.value); setSaving(state.pending); setError(state.error)
      })
    }).catch(() => { if (active) setError('无法读取设置，请稍后重试。') })
    return () => { active = false; activeRef.current = false }
  }, [])

  const change = (patch: Partial<ArknotePreferences>) => {
    if (!closingRef.current) {
      // A later edit can follow a quit cancelled by another service resource.
      finishedRef.current = false
      queueRef.current?.change(patch)
    }
  }
  const changeMaterials = (snapshot: StickyNoteWallpaperAppearances) => change(snapshot)

  useEffect(() => window.arkdown.onPrepareClose?.(async () => {
    // The main process disables window input while preparing service exit.
    // Only acknowledge here; closing before the response would destroy its IPC.
    const saved = await queueRef.current?.flush() ?? true
    if (saved) finishedRef.current = true
    return saved
  }), [])

  const close = async () => {
    if (closingRef.current) return
    closingRef.current = true; setClosing(true)
    const saved = await queueRef.current?.flush() ?? true
    if (!saved) { closingRef.current = false; setClosing(false); return }
    finishedRef.current = true
    onClose()
  }

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (finishedRef.current) return
      event.preventDefault(); event.returnValue = ''
      void close()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [onClose])

  const openMaterials = () => {
    summaryScrollTopRef.current = contentRef.current?.scrollTop ?? 0
    setMaterialView(true)
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = 0
      document.getElementById('preferences-arknote-material-settings')?.focus({ preventScroll: true })
    })
  }
  const returnToSummary = (sectionId?: string) => {
    setMaterialView(false)
    requestAnimationFrame(() => {
      const target = sectionId ? document.getElementById(sectionId) : null
      if (contentRef.current && target) scrollPreferenceTarget(contentRef.current, target)
      else if (contentRef.current) {
        contentRef.current.scrollTop = summaryScrollTopRef.current
        contentRef.current.querySelector<HTMLButtonElement>('.sticky-note-material-settings-action button')?.focus({ preventScroll: true })
      }
    })
  }

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || closing || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      if (materialView && !closing) returnToSummary()
      else void close()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [materialView, closing, onClose])

  return (
    <PreferencesShell
      ariaLabel="Arknote 设置"
      className="arknote-settings-page"
      contentRef={contentRef}
      header={materialView ? <button aria-label="返回 Arknote 设置" className="preferences-back" disabled={closing} onClick={() => returnToSummary()} type="button"><AppIcon aria-hidden="true" name="previous" size={16} /></button> : undefined}
      onTocClick={(event) => {
        if (closing) { event.preventDefault(); return }
        const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
        if (!link) return
        const sectionId = decodeURIComponent(link.hash.slice(1))
        if (sectionId === 'preferences-arknote-material-settings') {
          event.preventDefault()
          if (!materialView) openMaterials()
        } else if (materialView) {
          event.preventDefault()
          returnToSummary(sectionId)
        }
      }}
      footer={<button className="preferences-footer-secondary-action" disabled={closing} onClick={() => void close()} type="button">关闭</button>}
      status={<>
        {!value && !error && <p>正在读取设置…</p>}
        {saving && <p role="status">正在保存…</p>}
        {error && (
          <p className="preferences-error" data-ui-selectable="true" role="alert" tabIndex={0}>
            {error}
          </p>
        )}
      </>}
      toc={<>
        <a className="preferences-toc-primary" href="#preferences-arknote-heading">Arknote</a>
        <a className="preferences-toc-secondary" href="#preferences-arknote-startup-heading">开机启动</a>
        <a className="preferences-toc-secondary" href="#preferences-arknote-materials-heading">默认材质</a>
        <a className="preferences-toc-secondary" href="#preferences-arknote-material-settings">材质设置</a>
        <a className="preferences-toc-secondary" href="#preferences-arknote-colors-heading">默认颜色</a>
        <a className="preferences-toc-primary" href="#preferences-context-menu-heading">右键菜单</a>
      </>}
      tocLabel="Arknote 设置目录"
    >
      <fieldset className="arknote-settings-fields" disabled={closing}>
      {materialView && value ? <StickyNoteMaterialSettingsPage disabled={closing} value={copyStickyNoteWallpaperAppearances(value)} onChange={changeMaterials} /> : <>
      <h1>Arknote 设置</h1>
      {value && <StickyNotePreferencesSection
        launchAtLogin={value.launchAtLogin}
        onLaunchAtLoginChange={(launchAtLogin) => change({ launchAtLogin })}
        onChange={(stickyNotes) => change({ stickyNotes })}
        onOpenMaterialSettings={openMaterials}
        surface="arknote-standalone"
        title="Arknote"
        value={value.stickyNotes}
      />}
      {value && <section aria-labelledby="preferences-context-menu-heading" className="preferences-section preferences-page--arkdown arknote-context-menu-section">
        <h2 id="preferences-context-menu-heading">右键菜单</h2>
        <DesktopContextMenuCheckbox checked={value.registerDesktopContextMenu} disabled={closing}
          onChange={(registerDesktopContextMenu) => change({ registerDesktopContextMenu })} />
      </section>}
      </>}
      </fieldset>
    </PreferencesShell>
  )
}
