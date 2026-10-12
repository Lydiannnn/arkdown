import type { UpdateSnapshot } from '../../shared/app-update'
import '../updates/app-update.css'
import { useRef } from 'react'
import { version } from '../../../package.json'
import logo from '../../../assets/branding/arkdown-lockup-color.svg'
import reverseLogo from '../../../assets/branding/arkdown-lockup-reverse.svg'
import { ArkdownDialog } from '../modal/ArkdownDialog'
import './about-dialog.css'

const credits = [
  'Electron', 'Chromium', 'Node.js', 'React', 'Milkdown', 'ProseMirror', 'CodeMirror',
  'unified', 'remark', 'micromark', 'react-markdown', 'Mermaid', 'KaTeX',
  'ExcelJS', 'write-file-atomic', 'PaddleOCR / PP-OCRv6', 'RapidOCR', 'Pandoc', 'MarkItDown', 'Python',
] as const

export function AboutDialog({ onClose, colorScheme, update, onOpenUpdateWebsite, onUpdateExit, updateError }: { onClose(): void; colorScheme?: 'light' | 'dark'; update?: UpdateSnapshot | null; onOpenUpdateWebsite?(): void; onUpdateExit?(): void; updateError?: string | null }) {
  const closeRef = useRef<HTMLButtonElement>(null)

  return (
    <ArkdownDialog
      className="about-dialog"
      size="large"
      title={<>
        <span className="about-dialog__accessible-title">关于 Arkdown</span>
        <picture aria-hidden="true">
          {!colorScheme && <source media="(prefers-color-scheme: dark)" srcSet={reverseLogo} />}
          <img className="about-dialog__logo" src={colorScheme === 'dark' ? reverseLogo : logo} alt="" />
        </picture>
      </>}
      onCancel={onClose}
      initialFocusRef={closeRef}
      actions={({ requestClose }) => (
        <button type="button" ref={closeRef} onClick={() => requestClose()}>
          关闭
        </button>
      )}
    >
      <div className="about-dialog__product">
        <p>本地、轻量的 Markdown 编辑器</p>
        <p className="about-dialog__metadata">
          <span>版本 {update?.currentVersion ?? version}</span>
          {update?.candidate && <button className="app-update-link" type="button" onClick={onOpenUpdateWebsite}>新版本 {update.candidate.version}，前往官网下载</button>}
          <span>发布日期 <time dateTime="2026-10-11">2026 年 10 月 11 日</time></span>
        </p>
        {update?.candidate?.required && <p className="app-update-about-status">当前版本需要更新。请先保存或导出自己的工作，再<button className="app-update-link" type="button" onClick={onUpdateExit}>关闭 Arkdown</button>。Arknote 将继续运行。</p>}
        {updateError && <p className="app-update-about-status app-update-error" role="alert">{updateError}</p>}
        <p className="about-dialog__credit">powered by Miterh</p>
        <p>Copyright © 2026 Miterh</p>
      </div>
      <section className="about-dialog__acknowledgements" aria-labelledby="about-credits-heading">
        <h3 id="about-credits-heading">开源组件致谢</h3>
        <p className="about-dialog__credits">{credits.join('、')}</p>
      </section>
    </ArkdownDialog>
  )
}
