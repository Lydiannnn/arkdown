import { useEffect, useRef, useState } from 'react'
import { Choice } from './ShellMenuChoice'
import type { DefaultApplicationsStatus } from '../../shared/default-applications'

export function DefaultApplicationsSection() {
  const [status, setStatus] = useState<DefaultApplicationsStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const mounted = useRef(false), locked = useRef(false), generation = useRef(0)
  const refresh = async () => {
    if (!window.arkdown?.getDefaultApplicationsStatus) return
    const token = ++generation.current
    try {
      const result = await window.arkdown?.getDefaultApplicationsStatus?.()
      if (!mounted.current || token !== generation.current) return
      if (!result || !result.ok) throw new Error(result && !result.ok ? result.error.message : '默认程序状态不可用')
      setStatus(result.value); setError(undefined)
    } catch (failure) {
      if (mounted.current && token === generation.current) { setStatus(null); setError(failure instanceof Error ? failure.message : '默认程序状态读取失败') }
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    const focus = () => { if (!locked.current) void refresh() }
    window.addEventListener('focus', focus)
    return () => { mounted.current = false; generation.current++; window.removeEventListener('focus', focus) }
  }, [])
  const apply = async (enabled: boolean) => {
    if (locked.current) return
    locked.current = true; generation.current++; setPending(true); setError(undefined)
    try {
      const result = await window.arkdown?.setDefaultApplicationsEnabled?.(enabled)
      if (!result || !result.ok) throw new Error(result && !result.ok ? result.error.message : '默认程序设置不可用')
      if (mounted.current) {
        setStatus(result.value)
        const incomplete = [result.value.markdown !== enabled ? '.md' : '', result.value.text !== enabled ? '.txt' : ''].filter(Boolean)
        if (incomplete.length) setError(enabled
          ? `${incomplete.join('、')} 尚未设为 Arkdown。Windows 保留了当前默认程序，可手动设置。`
          : `${incomplete.join('、')} 仍由当前 Arkdown 打开，可手动设置。`)
      }
    } catch (failure) {
      await refresh()
      if (mounted.current) setError(failure instanceof Error ? failure.message : '默认程序设置未完成')
    } finally {
      locked.current = false
      if (mounted.current) setPending(false)
    }
  }
  const open = async () => {
    if (locked.current) return
    locked.current = true; setPending(true); setError(undefined)
    try {
      const result = await window.arkdown?.openDefaultApplicationsSettings?.()
      if (!result || !result.ok) throw new Error(result && !result.ok ? result.error.message : '默认程序设置不可用')
      await refresh()
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '默认程序设置打开失败')
    } finally {
      locked.current = false
      if (mounted.current) setPending(false)
    }
  }
  return <div className="preferences-subsection" aria-labelledby="preferences-default-applications-heading">
    <h3 className="preferences-secondary-heading" id="preferences-default-applications-heading">md/txt默认程序</h3>
    <Choice label="将Arkdown设为Markdown文件和文本文档的默认程序"
      checked={status?.markdown === true || status?.text === true}
      indeterminate={Boolean(status && status.markdown !== status.text)}
      description={(status && status.markdown !== status.text
        ? `尚未设为${status.markdown ? '文本文档' : 'Markdown 文件'}的默认程序。` : '')
        + '包括 *.md 和 *.txt 格式文件。取消勾选将撤销当前 Arkdown 的关联。'}
      disabled={!status || !window.arkdown?.setDefaultApplicationsEnabled} pending={pending} error={error}
      onChange={enabled => { void apply(enabled) }} />
    {error && window.arkdown?.openDefaultApplicationsSettings && <button type="button"
      className="preferences-screenshot-action" disabled={pending} aria-disabled={pending} onClick={() => { void open() }}>手动设置</button>}
  </div>
}
