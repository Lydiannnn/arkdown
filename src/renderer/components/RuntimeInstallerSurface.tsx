import { useEffect, useState } from 'react'
import type { RuntimeInstallerApi, RuntimeInstallSnapshot } from '../../shared/runtime-component'
import './runtime-installer.css'

export function RuntimeInstallerSurface() {
  const api = (window as unknown as { runtimeInstaller: RuntimeInstallerApi }).runtimeInstaller
  const [snapshot, setSnapshot] = useState<RuntimeInstallSnapshot | null>(null)
  useEffect(() => {
    const query = new URLSearchParams(location.search)
    document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light'
    const color = query.get('themeColor')
    if (color && /^#[0-9a-f]{6}$/iu.test(color)) document.documentElement.style.setProperty('--runtime-theme', color)
    const unsubscribe = api.subscribe(setSnapshot)
    void api.getState().then(setSnapshot)
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') void api.cancel() }
    window.addEventListener('keydown', keydown)
    return () => { unsubscribe(); window.removeEventListener('keydown', keydown) }
  }, [api])
  const state = snapshot?.state
  const progress = state?.progress
  const percent = progress && progress.totalBytes ? Math.max(0, Math.min(100, 100 * progress.receivedBytes / progress.totalBytes)) : 0
  const phase = progress?.phase === 'verifying' ? '正在校验组件' : progress?.phase === 'extracting' ? '正在安装组件' : '正在下载组件'
  return <main className="runtime-installer">
    <div className="runtime-installer-drag" />
    <h1>{snapshot?.label ?? '准备组件'}</h1>
    <p>首次使用需要准备组件，完成后将自动继续。</p>
    <div className="runtime-installer-progress" role="progressbar" aria-label={phase} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <div className="runtime-installer-status" role="status">{state?.error ?? `${phase}${progress?.phase === 'downloading' ? ` · ${Math.round(percent)}%` : '…'}`}</div>
    <footer>
      <button type="button" onClick={() => { void api.cancel() }}>取消</button>
      {state?.status === 'failed' && <button type="button" className="runtime-installer-primary" onClick={() => { void api.retry() }}>重试</button>}
    </footer>
  </main>
}
