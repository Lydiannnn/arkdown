import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  SHORTCUT_DEFINITIONS, acceleratorFromKeyEvent, shortcutConflict, shortcutFor,
  type ShortcutSnapshot, type ShortcutUpdate, type ObservedShortcutSnapshot,
} from '../../shared/keyboard-shortcuts'
import { ArkdownDialog } from '../modal/ArkdownDialog'
import type { ShortcutPreferenceDraft } from './shortcut-preference-draft'
import './keyboard-shortcuts.css'

interface Props {
  snapshot: ShortcutSnapshot
  draft: ShortcutPreferenceDraft
  onSnapshot(snapshot: ShortcutSnapshot): void
  onCancel(): void
}

export function KeyboardShortcutsDialog({ snapshot, draft, onSnapshot, onCancel }: Props) {
  const savedDraft = useSyncExternalStore(draft.subscribe, draft.getSnapshot)
  const [recording, setRecording] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recordingRef = useRef<string | null>(null)
  const recordingObservation = useRef<ObservedShortcutSnapshot | null>(null)
  const readyRef = useRef(false)
  const submittingRef = useRef(false)
  const mounted = useRef(true)
  const generation = useRef(0)
  const origin = useRef<HTMLElement | null>(null)
  const latest = useRef({ snapshot, onSnapshot })
  latest.current = { snapshot, onSnapshot }
  useEffect(() => { draft.accept(snapshot) }, [draft, snapshot])
  useEffect(() => {
    void draft.refresh(window.arkdown).then(() => {
      const observed = draft.getSnapshot().observed
      if (mounted.current && observed) latest.current.onSnapshot(observed)
    })
  }, [draft])

  const stopRecording = async (): Promise<boolean> => {
    generation.current += 1
    recordingRef.current = null
    recordingObservation.current = null
    readyRef.current = false
    if (mounted.current) { setRecording(null); setReady(false) }
    let restored = false
    try {
      const result = await window.arkdown.setShortcutRecording?.(false)
      restored = result?.ok ?? false
    } catch { /* Report below while leaving the recorder usable. */ }
    if (mounted.current) origin.current?.focus({ preventScroll: true })
    if (!restored) {
      if (mounted.current) setError(current => [current, '录入已结束，但截图快捷键暂时无法恢复。请关闭弹窗后重试。'].filter(Boolean).join(' '))
      return false
    }
    return true
  }

  const save = async (update: ShortcutUpdate, keepBusy = false, original?: ObservedShortcutSnapshot) => {
    const observed = original ?? draft.getSnapshot().observed
    if (!observed) { setError('快捷键设置尚未读取，请重新加载。'); return }
    setBusy(true)
    setError(null)
    try {
      const result = await draft.change(update, structuredClone(observed), window.arkdown)
      if (!mounted.current) return
      if (result) latest.current.onSnapshot(result)
    } catch { if (mounted.current) setError('快捷键保存失败，请重试。') }
    finally { if (mounted.current && !keepBusy) setBusy(false) }
  }

  const startRecording = async (id: string, button: HTMLElement) => {
    const observed = draft.getSnapshot().observed
    if (!observed) { setError('快捷键设置尚未读取，请重新加载。'); return }
    const attempt = ++generation.current
    origin.current = button
    recordingRef.current = id
    recordingObservation.current = structuredClone(observed)
    readyRef.current = false
    setRecording(id)
    setReady(false)
    setError(null)
    try {
      const result = await window.arkdown.setShortcutRecording?.(true)
      if (!mounted.current || generation.current !== attempt) {
        if (!mounted.current || recordingRef.current === null) await window.arkdown.setShortcutRecording?.(false)
        return
      }
      if (!result?.ok) {
        recordingRef.current = null
        setRecording(null)
        setError('无法开始快捷键录入，请重试。')
        return
      }
      readyRef.current = true
      setReady(true)
    } catch {
      if (mounted.current) { recordingRef.current = null; setRecording(null); setError('无法开始快捷键录入，请重试。') }
    }
  }

  useEffect(() => {
    mounted.current = true
    const capture = (event: KeyboardEvent) => {
      const id = recordingRef.current
      if (!id) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (submittingRef.current) return
      if (event.key === 'Escape') { void stopRecording(); return }
      if (!readyRef.current) return
      const accelerator = acceleratorFromKeyEvent(event)
      if (!accelerator) return
      const observed = recordingObservation.current
      if (!observed) return
      const conflict = shortcutConflict(id, accelerator, observed.bindings)
      if (conflict) { setError(conflict); return }
      readyRef.current = false
      submittingRef.current = true
      setBusy(true)
      void (async () => {
        try { await save({ id, accelerator }, true, observed) }
        catch { if (mounted.current) setError('无法结束录入，请重试。') }
        finally {
          await stopRecording()
          submittingRef.current = false
          if (mounted.current) setBusy(false)
        }
      })()
    }
    window.addEventListener('keydown', capture, true)
    return () => {
      mounted.current = false
      generation.current += 1
      window.removeEventListener('keydown', capture, true)
      void window.arkdown.setShortcutRecording?.(false).catch(() => undefined)
    }
  }, [draft])

  const groups = [...new Set(SHORTCUT_DEFINITIONS.map(item => item.group))]
  const saving = busy || savedDraft.pending
  const unavailable = !savedDraft.observed || savedDraft.loading
  const bindings = savedDraft.observed ? savedDraft.bindings : snapshot.bindings
  return <ArkdownDialog
    title="快捷键"
    description="点击“修改”后按下组合键，修改后立即保存。按 Esc 取消录入。"
    size="large"
    className="keyboard-shortcuts-dialog"
    error={[error, savedDraft.error].filter(Boolean).join(' ') || null}
    escapeEnabled={!recording && !saving}
    onCancel={onCancel}
    actions={({ requestClose }) => <>
      {(savedDraft.hasDirty || savedDraft.error) && <button type="button" disabled={saving || Boolean(recording) || savedDraft.loading}
        onClick={() => { setError(null); void draft.reload(window.arkdown).then(next => { if (mounted.current && next) latest.current.onSnapshot(next) }) }}>重新加载快捷键</button>}
      <button type="button" disabled={saving || unavailable || Boolean(recording) || savedDraft.resetAllBlocked} onClick={() => void save({ resetAll: true })}>恢复全部默认</button>
      <button type="button" disabled={saving} onClick={() => requestClose()}>关闭</button>
    </>}
  >
    <div className="keyboard-shortcuts-scroll">
      <table className="keyboard-shortcuts-table">
        <thead><tr><th scope="col">操作</th><th scope="col">快捷键</th><th scope="col">设置</th></tr></thead>
        <tbody>{groups.map(group => <Fragment key={group}>
          <tr className="keyboard-shortcuts-group"><th colSpan={3} scope="colgroup">{group}</th></tr>
          {SHORTCUT_DEFINITIONS.filter(item => item.group === group).map(item => {
            const key = shortcutFor(item.id, bindings)
            const active = recording === item.id
            return <tr key={item.id} data-recording={active || undefined}>
              <th scope="row">{item.label}</th>
              <td><span className="keyboard-shortcut-key" aria-live={active ? 'polite' : undefined}>{active ? (ready ? '请按快捷键…' : '准备录入…') : key ?? '未设置'}</span></td>
              <td><div className="keyboard-shortcut-actions">
                <button type="button" aria-label={`${active ? '取消录入' : '修改'} ${item.label}`} disabled={saving || unavailable || savedDraft.singleChangesBlocked || Boolean(recording && !active)}
                  onClick={event => { if (active) void stopRecording(); else void startRecording(item.id, event.currentTarget) }}>{active ? '取消' : '修改'}</button>
                {item.owner !== 'fixed' && <button type="button" aria-label={`清除 ${item.label}`} disabled={saving || unavailable || savedDraft.singleChangesBlocked || Boolean(recording) || key === null}
                  onClick={() => void save({ id: item.id, accelerator: null })}>清除</button>}
                <button type="button" aria-label={`恢复默认 ${item.label}`} disabled={saving || unavailable || savedDraft.singleChangesBlocked || Boolean(recording) || !Object.hasOwn(bindings, item.id)}
                  onClick={() => void save({ id: item.id, reset: true })}>默认</button>
              </div></td>
            </tr>
          })}
        </Fragment>)}</tbody>
      </table>
    </div>
  </ArkdownDialog>
}
