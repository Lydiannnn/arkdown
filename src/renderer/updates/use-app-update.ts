import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateSnapshot } from '../../shared/app-update'
import type { UpdateAction } from '../../shared/update-transfer'

export function useAppUpdate(aboutOpen: boolean, hasInitialWork = false) {
  const [state, setState] = useState<UpdateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const exitPending = useRef(false)
  const workStarted = useRef(hasInitialWork)
  const markWorkStarted = useCallback(() => {
    workStarted.current = true
    void window.arkdown.performUpdateAction?.('work-started').catch(() => {})
  }, [])
  useEffect(() => { if (hasInitialWork) markWorkStarted() }, [hasInitialWork, markWorkStarted])
  useEffect(() => {
    const edit = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.application-update-dialog')) return
      if (!workStarted.current) markWorkStarted()
    }
    const checkbox = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.editor-host input[type="checkbox"]')) edit(event)
    }
    for (const type of ['beforeinput', 'compositionstart', 'paste', 'drop', 'change']) document.addEventListener(type, edit, true)
    document.addEventListener('pointerdown', checkbox, true)
    return () => {
      for (const type of ['beforeinput', 'compositionstart', 'paste', 'drop', 'change']) document.removeEventListener(type, edit, true)
      document.removeEventListener('pointerdown', checkbox, true)
    }
  }, [markWorkStarted])
  useEffect(() => {
    let active = true
    const receive = (next: UpdateSnapshot) => { if (active) setState(current => !current || next.revision >= current.revision ? next : current) }
    const stop = window.arkdown.onAppUpdateChanged?.(receive)
    void window.arkdown.getAppUpdateState?.().then(result => { if (result.ok) receive(result.value) }).catch(() => {})
    return () => { active = false; stop?.() }
  }, [])
  useEffect(() => {
    if (!aboutOpen) return
    const interactionId = crypto.randomUUID()
    void window.arkdown.notifyUpdateAbout?.({ interactionId, open: true }).catch(() => {})
    return () => { void window.arkdown.notifyUpdateAbout?.({ interactionId, open: false }).catch(() => {}) }
  }, [aboutOpen])
  useEffect(() => { if (state?.requiredPrompt !== 'closing') exitPending.current = false }, [state?.requiredPrompt])
  useEffect(() => {
    if (state?.requiredPrompt !== 'visible' || state.transfer?.forced) return
    const claim = () => {
      if (workStarted.current || document.querySelector('[aria-modal="true"], dialog[open]')) { markWorkStarted(); return }
      if (!document.hasFocus()) return
      void window.arkdown.performUpdateAction?.('claim-gate').catch(() => {})
    }
    const timer = setTimeout(claim, 0)
    window.addEventListener('focus', claim)
    return () => { clearTimeout(timer); window.removeEventListener('focus', claim) }
  }, [state?.requiredPrompt, state?.transfer?.forced, markWorkStarted])
  const action = useCallback(async (input: UpdateAction) => {
    setError(null)
    try {
      const result = await window.arkdown.performUpdateAction?.(input)
      if (!result?.ok) setError('更新操作未能完成，请重试。')
    } catch { setError('更新操作未能完成，请重试。') }
  }, [])
  const openWebsite = useCallback(async () => {
    setError(null)
    try {
      const result = await window.arkdown.openUpdateWebsite?.()
      if (!result?.ok || !result.value) setError('未能打开浏览器，请访问 https://arkdown.cotax.tech/ 下载更新。')
    } catch { setError('未能打开浏览器，请访问 https://arkdown.cotax.tech/ 下载更新。') }
  }, [])
  const requestExit = useCallback(async () => {
    if (exitPending.current) return
    exitPending.current = true; setError(null)
    try {
      const result = await window.arkdown.requestRequiredUpdateExit?.()
      if (result?.ok) return
    } catch { /* A disconnected IPC is not authorization to force close. */ }
    exitPending.current = false; setError('退出请求未能完成，请先处理未保存内容，再重试关闭 Arkdown。')
  }, [])
  const protectWork = useCallback(() => {
    setError(null)
    void window.arkdown.protectUpdateWork?.().then(result => { if (!result.ok) setError(result.error.message) }).catch(() => setError('暂时无法返回编辑，请重试。'))
  }, [])
  return { state, error, openWebsite, requestExit, protectWork, action, markWorkStarted }
}
