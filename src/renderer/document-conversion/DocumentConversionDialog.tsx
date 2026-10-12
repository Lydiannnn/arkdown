import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SafeReadonlyMarkdown } from '../editor/SafeReadonlyMarkdown'
import { useModalEscape } from '../modal/use-modal-escape'
import type { ConvertedDocument } from '../../shared/document-conversion'
import type { DocumentConversionController } from './use-document-conversion'
import './document-conversion.css'

export interface DocumentConversionDialogProps {
  controller: DocumentConversionController
  onAccept?(converted: ConvertedDocument): boolean | void | Promise<boolean | void>
}

interface AcceptAttempt {
  preview: ConvertedDocument
  token: symbol
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function DocumentConversionDialog({
  controller,
  onAccept,
}: DocumentConversionDialogProps) {
  const { state } = controller
  const [accepting, setAccepting] = useState(false)
  const mountedRef = useRef(true)
  const acceptAttemptRef = useRef<AcceptAttempt | null>(null)
  const previewIdentity = state.status === 'preview' ? state.converted : null
  const previewIdentityRef = useRef<ConvertedDocument | null>(previewIdentity)
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const activationOriginRef = useRef<HTMLElement | null>(null)

  const invalidateAccept = () => {
    if (!acceptAttemptRef.current) return
    acceptAttemptRef.current = null
    if (mountedRef.current) setAccepting(false)
  }

  const cancelCurrent = () => {
    const activationOrigin = activationOriginRef.current
    invalidateAccept()
    controller.cancel()
    queueMicrotask(() => {
      if (activationOrigin?.isConnected) activationOrigin.focus({ preventScroll: true })
    })
  }

  useModalEscape(
    dialogRef,
    cancelCurrent,
    state.status !== 'idle',
  )

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      acceptAttemptRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    if (previewIdentityRef.current === previewIdentity) return
    previewIdentityRef.current = previewIdentity
    invalidateAccept()
  }, [previewIdentity])

  useLayoutEffect(() => {
    if (state.status === 'idle') return
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    activationOriginRef.current = previouslyFocused
    const background = previouslyFocused?.closest<HTMLElement>('.app-shell')
      ?? document.querySelector<HTMLElement>('.app-shell')
    const previousAriaHidden = background?.getAttribute('aria-hidden') ?? null
    const previousInert = Boolean(background?.inert)
    if (background) {
      background.setAttribute('aria-hidden', 'true')
      background.inert = true
    }
    cancelRef.current?.focus()

    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', containFocus)
    return () => {
      document.removeEventListener('keydown', containFocus)
      if (background) {
        if (previousAriaHidden === null) background.removeAttribute('aria-hidden')
        else background.setAttribute('aria-hidden', previousAriaHidden)
        background.inert = previousInert
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true })
    }
  }, [state.status === 'idle'])

  if (state.status === 'idle') return null

  const runAccept = () => {
    if (acceptAttemptRef.current || state.status !== 'preview') return
    const preview = state.converted
    const converted = controller.accept()
    if (!converted || converted !== preview) return
    const attempt: AcceptAttempt = {
      preview,
      token: Symbol('document-conversion-accept'),
    }
    acceptAttemptRef.current = attempt
    setAccepting(true)
    void (async () => {
      try {
        const accepted = await onAccept?.(converted)
        if (
          accepted !== false
          && mountedRef.current
          && acceptAttemptRef.current?.token === attempt.token
          && acceptAttemptRef.current.preview === attempt.preview
          && previewIdentityRef.current === attempt.preview
          && controller.accept() === attempt.preview
        ) {
          acceptAttemptRef.current = null
          setAccepting(false)
          controller.cancel()
        }
      } catch {
        // The current preview remains available; its owner decides how to surface adoption errors.
      } finally {
        if (
          mountedRef.current
          && acceptAttemptRef.current?.token === attempt.token
          && acceptAttemptRef.current.preview === attempt.preview
        ) {
          acceptAttemptRef.current = null
          setAccepting(false)
        }
      }
    })()
  }

  const descriptionIds: string[] = []
  if (state.status === 'install-required') descriptionIds.push('document-conversion-dialog-message')
  if (state.status === 'installing' || state.status === 'converting') {
    descriptionIds.push('document-conversion-dialog-progress')
  }
  if (state.status === 'failed') descriptionIds.push('document-conversion-dialog-error')
  if (state.status === 'preview') descriptionIds.push('document-conversion-dialog-notice')

  return createPortal(
    <div className="document-conversion-backdrop">
      <section
        aria-describedby={descriptionIds.join(' ')}
        aria-labelledby="document-conversion-dialog-title"
        aria-modal="true"
        className="document-conversion-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="document-conversion-dialog__header">
          <div>
            <h2 id="document-conversion-dialog-title">转换文档预览</h2>
            <p className="document-conversion-dialog__source">
              <span className="document-conversion-dialog__filename">{state.fileName}</span>
              <span aria-label={`文档格式 ${state.format.toUpperCase()}`} className="document-conversion-dialog__format">
                {state.format.toUpperCase()}
              </span>
            </p>
          </div>
        </header>

        <div className={`document-conversion-dialog__body document-conversion-dialog__body--${
          state.status === 'install-required' || state.status === 'failed'
            ? 'message'
            : state.status === 'installing' || state.status === 'converting'
              ? 'progress'
              : state.status
        }`}>
          {state.status === 'install-required' && (
            <p id="document-conversion-dialog-message">{state.message}</p>
          )}

          {state.status === 'installing' && (
            <div className="document-conversion-dialog__progress">
              <p className="document-conversion-dialog__preparation-note">
                首次启用插件大约需要1分钟进行准备
              </p>
              {state.progressPercent === null ? (
                <progress aria-label="文档转换组件安装进度" />
              ) : (
                <progress
                  aria-label="文档转换组件安装进度"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={state.progressPercent}
                  aria-valuetext={state.progressText}
                  max={100}
                  value={state.progressPercent}
                >{state.progressPercent}%</progress>
              )}
              <p aria-live="polite" id="document-conversion-dialog-progress" role="status">
                {state.progressText}
              </p>
            </div>
          )}

          {state.status === 'converting' && (
            <div className="document-conversion-dialog__progress">
              <progress aria-label="文档转换进度" />
              <p aria-live="polite" id="document-conversion-dialog-progress" role="status">
                正在转换文档
              </p>
            </div>
          )}

          {state.status === 'failed' && (
            <p id="document-conversion-dialog-error" role="alert">{state.message}</p>
          )}

          {state.status === 'preview' && (
            <>
              <p className="document-conversion-dialog__notice" id="document-conversion-dialog-notice">
                转换结果仅保留可提取结构，可能不包含原始版式。
              </p>
              <SafeReadonlyMarkdown
                allowImages={false}
                aria-label="转换后的 Markdown 预览"
                className="document-conversion-dialog__preview"
                markdown={state.converted.markdown}
              />
            </>
          )}
        </div>

        <footer className="document-conversion-dialog__footer">
          {state.status === 'install-required' && (
            <button
              className="document-conversion-dialog__primary document-conversion-dialog__primary--standard"
              onClick={controller.install}
              type="button"
            >
              {state.actionLabel}
            </button>
          )}
          {state.status === 'installing' && (
            <button
              className="document-conversion-dialog__primary document-conversion-dialog__primary--standard"
              disabled
              type="button"
            >
              {state.source === 'https' ? '正在下载' : '正在安装'}
            </button>
          )}
          {state.status === 'converting' && (
            <button className="document-conversion-dialog__primary" disabled type="button">
              正在转换
            </button>
          )}
          {state.status === 'failed' && (
            <button
              className="document-conversion-dialog__primary document-conversion-dialog__primary--standard"
              onClick={controller.retry}
              type="button"
            >
              重试
            </button>
          )}
          {state.status === 'preview' && (
            <button
              className="document-conversion-dialog__primary document-conversion-dialog__primary--standard"
              disabled={accepting}
              onClick={runAccept}
              type="button"
            >新建 Markdown</button>
          )}
          <button onClick={cancelCurrent} ref={cancelRef} type="button">
            取消
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
