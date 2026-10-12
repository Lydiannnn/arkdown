import { useEffect, useRef, useState } from 'react'
import type { ArkdownApi } from '../../shared/contracts'
import type { LargeModelSettings } from '../../shared/large-model-settings'
import type { PublicModelMutationResult, PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import './codex-cli-login.css'

interface CodexCliLoginPanelProps {
  observed: PublicModelSettingsSnapshot
  startLogin?: ArkdownApi['startCodexCliLogin']
  cancelLogin?: ArkdownApi['cancelCodexCliLogin']
  disabled?: boolean
  onPendingChange?(pending: boolean): void
  onMutation?(mutation: PublicModelMutationResult): void
  onConnected(settings: LargeModelSettings): void | Promise<unknown>
}

export function CodexCliLoginPanel({ observed, startLogin, cancelLogin, disabled = false, onPendingChange, onMutation, onConnected }: CodexCliLoginPanelProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const active = useRef(false)
  const callbacks = useRef({ cancelLogin, onPendingChange })
  callbacks.current = { cancelLogin, onPendingChange }
  useEffect(() => () => {
    generation.current += 1
    if (active.current) {
      active.current = false
      void (callbacks.current.cancelLogin ?? window.arkdown?.cancelCodexCliLogin)?.().catch(() => undefined)
      callbacks.current.onPendingChange?.(false)
    }
  }, [])
  const cancel = async () => {
    if (!active.current) return
    const current = ++generation.current
    try { await (cancelLogin ?? window.arkdown?.cancelCodexCliLogin)?.() }
    catch { /* A closed owner also reaps its login process in the main process. */ }
    finally {
      if (generation.current === current) {
        active.current = false; setPending(false); onPendingChange?.(false)
      }
    }
  }
  const start = async () => {
    if (disabled || active.current) return
    const run = startLogin ?? window.arkdown?.startCodexCliLogin
    if (!run) { setError('登录暂不可用，请重试。'); return }
    const current = ++generation.current
    const originalObservation = structuredClone(observed)
    active.current = true; setPending(true); setError(null); onPendingChange?.(true)
    try {
      const result = await run(originalObservation)
      if (generation.current !== current) return
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.status === 'completed') {
        onMutation?.(result.value.connection.mutation)
        if (result.value.connection.mutation.status === 'conflict') setError('大模型设置已在其他窗口更改，请重新加载后再调整。')
        else if (result.value.connection.status === 'connected') await onConnected(result.value.connection.mutation.snapshot.settings)
        else setError('登录后尚未连接成功，请重新检测连接。')
      } else if (result.value.status !== 'cancelled') {
        setError(result.value.status === 'timeout' ? '登录等待超时，请重试。' : '登录未能完成，请重试。')
      }
    } catch {
      if (generation.current === current) setError('登录未能完成，请重试。')
    } finally {
      if (generation.current === current) {
        active.current = false; setPending(false); onPendingChange?.(false)
      }
    }
  }
  return <section aria-label="ChatGPT 登录" className="large-model-codex-login">
    <p className="preferences-description">使用你的 ChatGPT 账号连接 Codex。登录将在浏览器中完成。</p>
    <div className="large-model-codex-login-actions">
      <button className="large-model-primary-action" disabled={disabled || pending} onClick={() => void start()} type="button">
        {pending ? '等待浏览器登录…' : '登录 ChatGPT'}
      </button>
      {pending && <button onClick={() => void cancel()} type="button">取消登录</button>}
    </div>
    {pending && <p aria-live="polite" className="preferences-description">完成登录后将自动更新连接与模型列表。</p>}
    {error && <p role="alert" className="preferences-error">{error}</p>}
  </section>
}
