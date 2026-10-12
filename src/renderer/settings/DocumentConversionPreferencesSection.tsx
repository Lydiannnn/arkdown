import { useEffect, useRef, useState } from 'react'
import type { ApiResult } from '../../shared/contracts'
import type { DocumentConversionComponentState } from '../../shared/document-conversion'
import { PUBLIC_ERROR_MESSAGES } from '../../shared/public-errors'
import { ArkdownDialog } from '../modal/ArkdownDialog'
import './document-conversion-preferences.css'

type ComponentStateResult = ApiResult<DocumentConversionComponentState>
type MutationKind = 'install' | 'remove'

const PHASE_LABELS: Record<NonNullable<DocumentConversionComponentState['progress']>['phase'], string> = {
  reading: '正在读取组件',
  downloading: '正在下载组件',
  verifying: '正在校验组件',
  extracting: '正在解压组件',
}

function progressPercent(state: DocumentConversionComponentState): number | null {
  if (!state.progress) return null
  return Math.min(100, Math.max(0, Math.round(
    state.progress.receivedBytes / state.progress.totalBytes * 100,
  )))
}

function stateFailureMessage(state: DocumentConversionComponentState): string | null {
  if (state.status !== 'failed') return null
  return PUBLIC_ERROR_MESSAGES[state.errorCode ?? 'DOCUMENT_CONVERSION_INSTALL_FAILED']
}

function DocumentConversionRemoveDialog({
  onCancel,
  onConfirm,
}: {
  onCancel(): void
  onConfirm(): void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return <ArkdownDialog
    title="是否删除文档转换组件？"
    description="删除后将无法预览转换 PDF、PPTX、XLSX 和 EPUB，相关文档功能也将停止使用该组件；源文件不会被删除。"
    descriptionClassName="preferences-confirm-dialog__hint"
    className="preferences-dialog preferences-confirm-dialog"
    backdropClassName="preferences-confirm-backdrop"
    cancelOnBackdrop={false}
    initialFocusRef={cancelRef}
    onCancel={onCancel}
    size="small"
    tone="danger"
    actions={({ requestClose }) => <>
      <button onClick={() => requestClose(onCancel)} ref={cancelRef} type="button">取消</button>
      <button className="arkdown-dialog__danger preferences-confirm-dialog__confirm"
        onClick={() => requestClose(onConfirm)} type="button">删除</button>
    </>}
  />
}

export function DocumentConversionPreferencesSection() {
  const [componentState, setComponentState] = useState<DocumentConversionComponentState | null>(null)
  const [queryStatus, setQueryStatus] = useState<
    'loading' | 'ready' | 'failed' | 'unavailable'
  >('loading')
  const [mutation, setMutation] = useState<MutationKind | null>(null)
  const [mutationFailure, setMutationFailure] = useState<MutationKind | 'cancel' | null>(null)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const lifecycleRef = useRef(0)
  const authoritativeRevisionRef = useRef(-1)
  const querySerialRef = useRef(0)
  const mutationLockRef = useRef<symbol | null>(null)
  const cancelLockRef = useRef<symbol | null>(null)
  const ownedInstallRequestIdRef = useRef<string | null>(null)

  const acceptComponentState = (
    state: DocumentConversionComponentState,
    event: boolean,
  ): boolean => {
    const currentRevision = authoritativeRevisionRef.current
    if (event ? state.revision <= currentRevision : state.revision < currentRevision) return false
    authoritativeRevisionRef.current = state.revision
    setComponentState(state)
    setQueryStatus('ready')
    setMutationFailure(null)
    if (state.busy || state.status !== 'installed') setRemoveConfirmOpen(false)
    return true
  }

  const queryComponentState = () => {
    const lifecycle = lifecycleRef.current
    const querySerial = ++querySerialRef.current
    const revision = authoritativeRevisionRef.current
    setQueryStatus('loading')
    setMutationFailure(null)
    void (async () => {
      try {
        const action = window.arkdown?.getDocumentConversionComponentState
        if (!action) {
          if (
            lifecycleRef.current === lifecycle
            && querySerialRef.current === querySerial
            && authoritativeRevisionRef.current === revision
          ) setQueryStatus('unavailable')
          return
        }
        const result = await action()
        if (
          lifecycleRef.current !== lifecycle
          || querySerialRef.current !== querySerial
        ) return
        if (!result.ok) throw new Error('Component state query failed')
        acceptComponentState(result.value, false)
      } catch {
        if (
          lifecycleRef.current === lifecycle
          && querySerialRef.current === querySerial
          && authoritativeRevisionRef.current === revision
        ) setQueryStatus('failed')
      }
    })()
  }

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current
    const api = window.arkdown
    const unsubscribe = api?.onDocumentConversionComponentState?.((state) => {
      if (lifecycleRef.current !== lifecycle) return
      acceptComponentState(state, true)
    }) ?? (() => undefined)
    queryComponentState()

    return () => {
      if (lifecycleRef.current === lifecycle) lifecycleRef.current += 1
      cancelLockRef.current = null
      const ownedRequestId = ownedInstallRequestIdRef.current
      ownedInstallRequestIdRef.current = null
      if (ownedRequestId) {
        void api?.cancelDocumentConversionComponentInstall?.(ownedRequestId)
          .catch(() => undefined)
      }
      unsubscribe()
    }
  }, [])

  const runInstall = async () => {
    if (mutationLockRef.current || componentState?.busy) return
    const action = window.arkdown?.installDocumentConversionComponent
    const lock = Symbol('document-conversion-install')
    const requestId = crypto.randomUUID()
    mutationLockRef.current = lock
    ownedInstallRequestIdRef.current = requestId
    const revision = authoritativeRevisionRef.current
    const lifecycle = lifecycleRef.current
    setMutation('install')
    setMutationFailure(null)
    setCancelPending(false)
    try {
      if (!action) throw new Error('Component install API unavailable')
      const result: ComponentStateResult = await action(requestId)
      if (lifecycleRef.current !== lifecycle || mutationLockRef.current !== lock) return
      if (!result.ok) throw new Error('Component install failed')
      acceptComponentState(result.value, false)
    } catch {
      if (
        lifecycleRef.current === lifecycle
        && mutationLockRef.current === lock
        && authoritativeRevisionRef.current === revision
      ) {
        setMutationFailure('install')
      }
    } finally {
      if (ownedInstallRequestIdRef.current === requestId) {
        ownedInstallRequestIdRef.current = null
      }
      if (lifecycleRef.current === lifecycle) {
        setMutation(null)
        setCancelPending(false)
      }
      if (mutationLockRef.current === lock) mutationLockRef.current = null
    }
  }

  const cancelOwnedInstall = async () => {
    const requestId = ownedInstallRequestIdRef.current
    const installOperation = mutationLockRef.current
    if (!requestId || !installOperation || cancelLockRef.current) return
    const cancelToken = Symbol('document-conversion-cancel')
    const lifecycle = lifecycleRef.current
    const revision = authoritativeRevisionRef.current
    cancelLockRef.current = cancelToken
    ownedInstallRequestIdRef.current = null
    setCancelPending(true)
    setMutationFailure(null)
    try {
      const action = window.arkdown?.cancelDocumentConversionComponentInstall
      if (!action) throw new Error('Component cancellation API unavailable')
      const result = await action(requestId)
      if (!result.ok) throw new Error('Component cancellation failed')
    } catch {
      if (
        lifecycleRef.current === lifecycle
        && mutationLockRef.current === installOperation
        && cancelLockRef.current === cancelToken
        && authoritativeRevisionRef.current === revision
      ) {
        ownedInstallRequestIdRef.current = requestId
        setMutationFailure('cancel')
      }
    } finally {
      if (cancelLockRef.current === cancelToken) cancelLockRef.current = null
      if (lifecycleRef.current === lifecycle) setCancelPending(false)
    }
  }

  const runRemove = async () => {
    if (mutationLockRef.current || componentState?.busy) return
    const lock = Symbol('document-conversion-remove')
    mutationLockRef.current = lock
    const revision = authoritativeRevisionRef.current
    const lifecycle = lifecycleRef.current
    setMutation('remove')
    setMutationFailure(null)
    try {
      const action = window.arkdown?.removeDocumentConversionComponent
      if (!action) throw new Error('Component remove API unavailable')
      const result = await action()
      if (lifecycleRef.current !== lifecycle || mutationLockRef.current !== lock) return
      if (!result.ok) throw new Error('Component removal failed')
      acceptComponentState(result.value, false)
    } catch {
      if (
        lifecycleRef.current === lifecycle
        && mutationLockRef.current === lock
        && authoritativeRevisionRef.current === revision
      ) {
        setMutationFailure('remove')
      }
    } finally {
      if (lifecycleRef.current === lifecycle) setMutation(null)
      if (mutationLockRef.current === lock) mutationLockRef.current = null
    }
  }

  const stateInstalling = componentState?.status === 'installing'
  const installing = mutation === 'install' || stateInstalling
  const locallyOwnedInstall = mutation === 'install'
    && (ownedInstallRequestIdRef.current !== null || cancelPending)
  const bundled = componentState?.bundled === true && componentState.status === 'installed'
  const actionDisabled = Boolean(mutation) || installing || Boolean(componentState?.busy) || bundled
  const failed = mutationFailure === 'install' || componentState?.status === 'failed'
  const actionLabel = (() => {
    if (mutation === 'remove') return '正在删除'
    if (installing) return componentState?.source === 'https' ? '正在下载' : '正在安装'
    if (queryStatus === 'failed' || failed) return '重试'
    if (!componentState) return ''
    if (componentState.status === 'installed') return bundled ? '已内置' : '已安装'
    if (componentState.status === 'update-available') {
      return componentState.source === 'https' ? '下载并更新' : '更新'
    }
    return componentState.source === 'https' ? '下载并安装' : '安装'
  })()
  const progress = componentState ? progressPercent(componentState) : null
  const progressText = componentState?.progress && progress !== null
    ? `${PHASE_LABELS[componentState.progress.phase]}，${progress}%`
    : installing
      ? componentState?.source === 'https' ? '正在准备下载组件' : '正在准备安装组件'
      : null
  const publicFailure = queryStatus === 'failed'
    ? '无法获取组件状态，请重试。'
    : mutationFailure === 'remove'
      ? '删除失败，请重试。'
      : mutationFailure === 'cancel'
        ? '取消失败，请重试。'
        : mutationFailure === 'install'
          ? componentState?.installedVersion ? '更新失败，请重试。' : '安装失败，请重试。'
          : componentState ? stateFailureMessage(componentState) : null
  const statusText = progressText
    ?? (queryStatus === 'loading' && !componentState
      ? '正在获取文档转换组件状态'
      : mutation === 'remove'
      ? '正在删除文档转换组件'
      : queryStatus === 'unavailable'
        ? '当前版本不支持文档转换组件管理'
      : componentState?.status === 'installed'
        ? `文档转换组件${bundled ? '已内置' : '已安装'}，版本 ${componentState.installedVersion}`
        : componentState?.status === 'update-available'
          ? `文档转换组件可更新至版本 ${componentState.availableVersion}`
          : componentState?.status === 'absent'
            ? '文档转换组件尚未安装'
            : null)

  const activateAction = () => {
    if (mutation || installing || componentState?.busy) return
    if (queryStatus === 'failed') {
      queryComponentState()
      return
    }
    if (componentState?.status === 'installed' && mutationFailure !== 'install') {
      setRemoveConfirmOpen(true)
      return
    }
    void runInstall()
  }

  return (
    <section
      aria-labelledby="preferences-document-conversion-heading"
      className="preferences-section document-conversion-preferences"
    >
      <h2 id="preferences-document-conversion-heading">文档转换</h2>
      <div
        aria-label="文档转换组件"
        className="document-conversion-preferences__group"
        role="group"
      >
        <div className="document-conversion-preferences__row">
          <div className="document-conversion-preferences__description">
            <p>
              安装本地 MarkItDown 文档转换组件，以支持 PDF、PPTX、XLSX、EPUB 转换为 Markdown 预览和相关文档使用。
            </p>
          </div>
          <div className="document-conversion-preferences__controls">
            <div className="document-conversion-preferences__actions">
              {actionLabel ? (
                <button
                  className="preferences-screenshot-action"
                  disabled={actionDisabled}
                  onClick={activateAction}
                  type="button"
                >{actionLabel}</button>
              ) : (
                <span
                  aria-hidden="true"
                  className="document-conversion-preferences__action-placeholder"
                />
              )}
              {locallyOwnedInstall ? (
                  <button
                    className="document-conversion-preferences__cancel"
                    disabled={cancelPending}
                    onClick={() => void cancelOwnedInstall()}
                    type="button"
                  >取消安装</button>
              ) : null}
            </div>
            <div className="document-conversion-preferences__progress-slot">
              {componentState?.progress && progress !== null && progressText ? (
                <progress
                  aria-label="文档转换组件安装进度"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={progress}
                  aria-valuetext={progressText}
                  max={100}
                  value={progress}
                >{progress}%</progress>
              ) : null}
            </div>
          </div>
          <div className="document-conversion-preferences__meta">
            <p>源文件保持不变，转换结果需在预览中确认。</p>
            <p
              {...(statusText ? { role: 'status' as const } : { 'aria-hidden': true })}
              className="document-conversion-preferences__status"
            >{statusText ?? '\u00a0'}</p>
          </div>
        </div>
        {publicFailure && (
          <p className="preferences-screenshot-error" role="alert">{publicFailure}</p>
        )}
      </div>

      {removeConfirmOpen && (
        <DocumentConversionRemoveDialog
          onCancel={() => setRemoveConfirmOpen(false)}
          onConfirm={() => {
            setRemoveConfirmOpen(false)
            void runRemove()
          }}
        />
      )}
    </section>
  )
}
