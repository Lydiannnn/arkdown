import { DownloadSimple } from '@phosphor-icons/react'
import type { ScreenTranslationComponentState } from '../../shared/screen-translation-component'

export function ScreenTranslationInstaller({ component, pending, error, install, cancel }: {
  component: ScreenTranslationComponentState; pending: boolean; error: string | null
  install(): void; cancel(): void
}) {
  const installing = component.status === 'installing'
  const progress = component.progress
  const percent = progress && progress.totalBytes > 0
    ? Math.max(0, Math.min(100, Math.round(progress.receivedBytes / progress.totalBytes * 100))) : undefined
  const phase = progress?.phase === 'extracting' ? '正在安装…'
    : progress?.phase === 'verifying' ? '正在校验…' : '正在下载…'
  const downloadSize = (component.downloadBytes / 1024 / 1024).toFixed(1)
  return <section className="screen-translation-installer" aria-label="安装翻译组件">
    <DownloadSimple className="screen-translation-install-icon" size={32} aria-hidden="true" />
    <h2>准备好，让文字跨越语言</h2>
    <p className="screen-translation-note">首次使用需安装翻译组件，下载约 {downloadSize} MB。安装后即可使用大模型或百度快译。</p>
    {installing && <div className="screen-translation-install-progress">
      <progress aria-label="翻译组件安装进度" max={100} value={progress?.phase === 'downloading' ? percent : undefined} />
      <p role="status" className="screen-translation-note">{phase}{progress?.phase === 'downloading' && percent !== undefined ? ` ${percent}%` : ''}</p>
    </div>}
    {(component.error || error) && <p role="alert" className="screen-translation-error">{component.error || error}</p>}
    {installing
      ? <button type="button" className="screen-translation-button" onClick={cancel}>取消下载</button>
      : <button type="button" className="screen-translation-button screen-translation-primary" disabled={pending} onClick={install}>
        {component.status === 'failed' ? '重试安装' : '安装翻译组件'}
      </button>}
    <p className="screen-translation-note">组件仅需安装一次。关闭窗口会取消尚未完成的下载。</p>
  </section>
}
