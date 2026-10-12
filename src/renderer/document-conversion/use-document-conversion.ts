import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiError, ArkdownApi } from '../../shared/contracts'
import {
  type ConvertedDocument,
  type DocumentConversionComponentSource,
  type DocumentConversionComponentState,
  type DocumentConversionFormat,
} from '../../shared/document-conversion'
import { isMarkItDownConversionPath } from '../../shared/document-types'
import { PUBLIC_ERROR_MESSAGES } from '../../shared/public-errors'

interface DocumentConversionSourceState {
  relativePath: string
  fileName: string
  format: DocumentConversionFormat
}

export interface DocumentConversionIdleState {
  status: 'idle'
}

export interface DocumentConversionInstallRequiredState extends DocumentConversionSourceState {
  status: 'install-required'
  source: DocumentConversionComponentSource
  actionLabel: '安装' | '下载'
  message: string
}

export interface DocumentConversionInstallingState extends DocumentConversionSourceState {
  status: 'installing'
  source: DocumentConversionComponentSource
  progressPercent: number | null
  progressText: string
}

export interface DocumentConversionConvertingState extends DocumentConversionSourceState {
  status: 'converting'
}

export interface DocumentConversionPreviewState extends DocumentConversionSourceState {
  status: 'preview'
  converted: ConvertedDocument
}

export type DocumentConversionRetryKind = 'query' | 'install' | 'conversion'

export interface DocumentConversionFailedState extends DocumentConversionSourceState {
  status: 'failed'
  message: string
  retryKind: DocumentConversionRetryKind
}

export type DocumentConversionState =
  | DocumentConversionIdleState
  | DocumentConversionInstallRequiredState
  | DocumentConversionInstallingState
  | DocumentConversionConvertingState
  | DocumentConversionPreviewState
  | DocumentConversionFailedState

export interface DocumentConversionController {
  state: DocumentConversionState
  begin(relativePath: string): void
  install(): void
  retry(): void
  cancel(): void
  accept(): ConvertedDocument | null
}

interface RequestOwner extends DocumentConversionSourceState {
  generation: number
  token: symbol
  installRequestId: string | null
  conversionRequestId: string | null
  pendingInstallCancellation: Promise<void> | null
  installCancellationTimeoutId: ReturnType<typeof setTimeout> | null
}

const INSTALL_REQUIRED_MESSAGE = '转换此文档需要安装文档转换组件。'
const INVALID_SOURCE_MESSAGE = '无法转换此文档，请重新选择。'
const API_UNAVAILABLE_MESSAGE = '当前版本不支持文档转换，请更新 Arkdown 后重试。'
const COMPONENT_BUSY_MESSAGE = '文档转换组件正在由其他界面安装，请稍后重试。'
const INSTALL_CANCELLATION_HANDOFF_TIMEOUT_MS = 1_000

const PHASE_LABELS: Record<NonNullable<DocumentConversionComponentState['progress']>['phase'], string> = {
  reading: '正在读取组件',
  downloading: '正在下载组件',
  verifying: '正在校验组件',
  extracting: '正在解压组件',
}

function safeSource(relativePath: string): DocumentConversionSourceState | null {
  if (
    relativePath.length === 0
    || relativePath.length > 32_767
    || relativePath.includes('\0')
    || relativePath.includes(':')
    || /^[\\/]/u.test(relativePath)
    || !isMarkItDownConversionPath(relativePath)
  ) return null
  const segments = relativePath.split(/[\\/]/u)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  const fileName = segments.at(-1)!
  const format = fileName.slice(fileName.lastIndexOf('.') + 1)
    .toLocaleLowerCase('en-US') as DocumentConversionFormat
  return { relativePath, fileName, format }
}

function isInstalledRuntime(state: DocumentConversionComponentState): boolean {
  return state.status === 'installed'
    || state.status === 'update-available'
    || (state.status === 'failed' && state.installedVersion !== null)
}

function progressPresentation(state: DocumentConversionComponentState): {
  progressPercent: number | null
  progressText: string
} {
  if (!state.progress) {
    return {
      progressPercent: null,
      progressText: state.source === 'https'
        ? '正在准备下载组件'
        : '正在准备安装组件',
    }
  }
  const progressPercent = Math.round(
    (state.progress.receivedBytes / state.progress.totalBytes) * 100,
  )
  return {
    progressPercent,
    progressText: `${PHASE_LABELS[state.progress.phase]}，${progressPercent}%`,
  }
}

function publicFailure(error: ApiError | null | undefined, fallback: string): string {
  const code = error?.code
  const message = code && Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_MESSAGES, code)
    ? PUBLIC_ERROR_MESSAGES[code as keyof typeof PUBLIC_ERROR_MESSAGES]
    : fallback
  return /[.。！？]$/u.test(message) ? message : `${message}。`
}

function immutableConverted(value: ConvertedDocument): ConvertedDocument {
  const source = Object.freeze({ ...value.source })
  const warnings = Object.freeze([...value.warnings])
  return Object.freeze({ ...value, source, warnings })
}

export function useDocumentConversion(): DocumentConversionController {
  const [state, setReactState] = useState<DocumentConversionState>({ status: 'idle' })
  const stateRef = useRef<DocumentConversionState>(state)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const ownerRef = useRef<RequestOwner | null>(null)
  const authoritativeRevisionRef = useRef(-1)
  const currentComponentStateRef = useRef<DocumentConversionComponentState | null>(null)

  const publish = useCallback((next: DocumentConversionState) => {
    stateRef.current = next
    if (mountedRef.current) setReactState(next)
  }, [])

  const ownerIsCurrent = useCallback((owner: RequestOwner): boolean => (
    mountedRef.current
    && ownerRef.current === owner
    && owner.generation === generationRef.current
    && owner.token === ownerRef.current.token
  ), [])

  const cancelOwnedRequests = useCallback((
    owner: RequestOwner | null,
    api: ArkdownApi | undefined,
  ): Promise<void> | null => {
    if (!owner) return null
    if (owner.installCancellationTimeoutId !== null) {
      clearTimeout(owner.installCancellationTimeoutId)
      owner.installCancellationTimeoutId = null
    }
    const installRequestId = owner.installRequestId
    const conversionRequestId = owner.conversionRequestId
    owner.installRequestId = null
    owner.conversionRequestId = null
    owner.pendingInstallCancellation = null
    let pendingInstallCancellation: Promise<void> | null = null
    if (installRequestId) {
      try {
        const action = api?.cancelDocumentConversionComponentInstall
        pendingInstallCancellation = action
          ? Promise.resolve(action(installRequestId)).then(() => undefined, () => undefined)
          : Promise.resolve()
      } catch {
        pendingInstallCancellation = Promise.resolve()
      }
    }
    if (conversionRequestId) {
      try {
        void api?.cancelWorkspaceDocumentConversion?.(conversionRequestId)
          .catch(() => undefined)
      } catch {
        // Cancellation is best-effort after synchronous ownership surrender.
      }
    }
    return pendingInstallCancellation
  }, [])

  const replaceOwner = useCallback((source: DocumentConversionSourceState): RequestOwner => {
    const api = window.arkdown
    const previousOwner = ownerRef.current
    const inheritedCancellation = previousOwner?.pendingInstallCancellation ?? null
    const startedCancellation = cancelOwnedRequests(previousOwner, api)
    const owner: RequestOwner = {
      relativePath: source.relativePath,
      fileName: source.fileName,
      format: source.format,
      generation: ++generationRef.current,
      token: Symbol('document-conversion-owner'),
      installRequestId: null,
      conversionRequestId: null,
      pendingInstallCancellation: startedCancellation ?? inheritedCancellation,
      installCancellationTimeoutId: null,
    }
    ownerRef.current = owner
    return owner
  }, [cancelOwnedRequests])

  const acceptComponentState = useCallback((
    componentState: DocumentConversionComponentState,
    event: boolean,
  ): boolean => {
    const revision = authoritativeRevisionRef.current
    if (event ? componentState.revision <= revision : componentState.revision < revision) return false
    authoritativeRevisionRef.current = componentState.revision
    currentComponentStateRef.current = componentState
    return true
  }, [])

  const fail = useCallback((
    owner: RequestOwner,
    message: string,
    retryKind: DocumentConversionRetryKind,
  ) => {
    if (!ownerIsCurrent(owner)) return
    publish({
      status: 'failed',
      relativePath: owner.relativePath,
      fileName: owner.fileName,
      format: owner.format,
      message,
      retryKind,
    })
  }, [ownerIsCurrent, publish])

  const startConversionRef = useRef<(owner: RequestOwner) => void>(() => undefined)
  const startInstallRef = useRef<(owner: RequestOwner) => void>(() => undefined)
  const queryAndContinueRef = useRef<(owner: RequestOwner) => void>(() => undefined)

  const continueFromComponentState = useCallback((
    owner: RequestOwner,
    componentState: DocumentConversionComponentState,
  ) => {
    if (!ownerIsCurrent(owner)) return
    if (isInstalledRuntime(componentState)) {
      startConversionRef.current(owner)
      return
    }
    if (componentState.status === 'absent'
      || (componentState.status === 'failed' && componentState.installedVersion === null)) {
      publish({
        status: 'install-required',
        relativePath: owner.relativePath,
        fileName: owner.fileName,
        format: owner.format,
        source: componentState.source,
        actionLabel: componentState.source === 'https' ? '下载' : '安装',
        message: INSTALL_REQUIRED_MESSAGE,
      })
      return
    }
    fail(owner, COMPONENT_BUSY_MESSAGE, 'query')
  }, [fail, ownerIsCurrent, publish])

  const startConversion = useCallback((owner: RequestOwner) => {
    if (!ownerIsCurrent(owner) || owner.conversionRequestId) return
    const action = window.arkdown?.convertWorkspaceDocument
    if (!action) {
      fail(owner, API_UNAVAILABLE_MESSAGE, 'query')
      return
    }
    const requestId = crypto.randomUUID()
    owner.conversionRequestId = requestId
    publish({
      status: 'converting',
      relativePath: owner.relativePath,
      fileName: owner.fileName,
      format: owner.format,
    })
    void (async () => {
      try {
        const result = await action(owner.relativePath, requestId)
        if (!ownerIsCurrent(owner) || owner.conversionRequestId !== requestId) return
        owner.conversionRequestId = null
        if (!result.ok) {
          if (result.error.code === 'DOCUMENT_CONVERSION_COMPONENT_MISSING') {
            publish({
              status: 'install-required',
              relativePath: owner.relativePath,
              fileName: owner.fileName,
              format: owner.format,
              source: currentComponentStateRef.current?.source ?? 'packaged',
              actionLabel: currentComponentStateRef.current?.source === 'https' ? '下载' : '安装',
              message: INSTALL_REQUIRED_MESSAGE,
            })
            return
          }
          fail(owner, publicFailure(result.error, '文档转换未能完成，请重试'), 'conversion')
          return
        }
        const converted = immutableConverted(result.value)
        publish({
          status: 'preview',
          relativePath: owner.relativePath,
          fileName: converted.source.fileName,
          format: converted.source.format,
          converted,
        })
      } catch {
        if (ownerIsCurrent(owner) && owner.conversionRequestId === requestId) {
          owner.conversionRequestId = null
          fail(owner, '文档转换未能完成，请重试。', 'conversion')
        }
      }
    })()
  }, [fail, ownerIsCurrent, publish])
  startConversionRef.current = startConversion

  const startInstall = useCallback((owner: RequestOwner) => {
    if (!ownerIsCurrent(owner) || owner.installRequestId) return
    const action = window.arkdown?.installDocumentConversionComponent
    if (!action) {
      fail(owner, API_UNAVAILABLE_MESSAGE, 'install')
      return
    }
    const source = currentComponentStateRef.current?.source ?? 'packaged'
    const startingRevision = authoritativeRevisionRef.current
    const requestId = crypto.randomUUID()
    owner.installRequestId = requestId
    const initialProgress = progressPresentation({
      revision: authoritativeRevisionRef.current < 0 ? 0 : authoritativeRevisionRef.current,
      source,
      status: 'installing',
      installedVersion: null,
      availableVersion: currentComponentStateRef.current?.availableVersion ?? 'unknown',
      progress: null,
      errorCode: null,
      busy: true,
    })
    publish({
      status: 'installing',
      relativePath: owner.relativePath,
      fileName: owner.fileName,
      format: owner.format,
      source,
      ...initialProgress,
    })
    void (async () => {
      try {
        const result = await action(requestId)
        if (!ownerIsCurrent(owner) || owner.installRequestId !== requestId) return
        owner.installRequestId = null
        if (!result.ok) {
          const newer = currentComponentStateRef.current
          if (
            newer
            && newer.revision > startingRevision
            && newer.status !== 'installing'
          ) {
            continueFromComponentState(owner, newer)
            return
          }
          fail(owner, publicFailure(result.error, '文档转换组件安装失败，请重试'), 'install')
          return
        }
        const responseAccepted = acceptComponentState(result.value, false)
        const authoritative = responseAccepted ? result.value : currentComponentStateRef.current
        if (!authoritative || !isInstalledRuntime(authoritative)) {
          if (authoritative?.status === 'failed' && authoritative.installedVersion === null) {
            fail(owner, publicFailure(
              authoritative.errorCode === null
                ? undefined
                : { code: authoritative.errorCode, message: '' },
              '文档转换组件安装失败，请重试',
            ), 'install')
          } else if (authoritative?.installedVersion === null) {
            publish({
              status: 'install-required',
              relativePath: owner.relativePath,
              fileName: owner.fileName,
              format: owner.format,
              source: authoritative.source,
              actionLabel: authoritative.source === 'https' ? '下载' : '安装',
              message: INSTALL_REQUIRED_MESSAGE,
            })
          } else {
            fail(owner, '文档转换组件安装失败，请重试。', 'install')
          }
          return
        }
        startConversionRef.current(owner)
      } catch {
        if (ownerIsCurrent(owner) && owner.installRequestId === requestId) {
          owner.installRequestId = null
          const newer = currentComponentStateRef.current
          if (
            newer
            && newer.revision > startingRevision
            && newer.status !== 'installing'
          ) {
            continueFromComponentState(owner, newer)
            return
          }
          fail(owner, '文档转换组件安装失败，请重试。', 'install')
        }
      }
    })()
  }, [acceptComponentState, continueFromComponentState, fail, ownerIsCurrent, publish])
  startInstallRef.current = startInstall

  const queryAndContinue = useCallback((owner: RequestOwner) => {
    if (!ownerIsCurrent(owner)) return
    const action = window.arkdown?.getDocumentConversionComponentState
    if (!action) {
      fail(owner, API_UNAVAILABLE_MESSAGE, 'query')
      return
    }
    publish({
      status: 'converting',
      relativePath: owner.relativePath,
      fileName: owner.fileName,
      format: owner.format,
    })
    void (async () => {
      try {
        const result = await action()
        if (!ownerIsCurrent(owner)) return
        if (!result.ok) {
          fail(owner, publicFailure(result.error, '无法获取文档转换组件状态，请重试'), 'query')
          return
        }
        const accepted = acceptComponentState(result.value, false)
        const authoritative = accepted ? result.value : currentComponentStateRef.current
        if (authoritative) continueFromComponentState(owner, authoritative)
      } catch {
        fail(owner, '无法获取文档转换组件状态，请重试。', 'query')
      }
    })()
  }, [acceptComponentState, continueFromComponentState, fail, ownerIsCurrent, publish])
  queryAndContinueRef.current = queryAndContinue

  useEffect(() => {
    mountedRef.current = true
    const api = window.arkdown
    const unsubscribe = api?.onDocumentConversionComponentState?.((componentState) => {
      const owner = ownerRef.current
      if (!owner || !owner.installRequestId || !ownerIsCurrent(owner)) return
      if (!acceptComponentState(componentState, true)) return
      if (componentState.status === 'installing') {
        publish({
          status: 'installing',
          relativePath: owner.relativePath,
          fileName: owner.fileName,
          format: owner.format,
          source: componentState.source,
          ...progressPresentation(componentState),
        })
      }
    }) ?? (() => undefined)

    return () => {
      mountedRef.current = false
      generationRef.current += 1
      const owner = ownerRef.current
      ownerRef.current = null
      cancelOwnedRequests(owner, api)
      unsubscribe()
    }
  }, [acceptComponentState, cancelOwnedRequests, ownerIsCurrent, publish])

  const begin = useCallback((relativePath: string) => {
    const source = safeSource(relativePath)
    if (!source) {
      cancelOwnedRequests(ownerRef.current, window.arkdown)
      generationRef.current += 1
      ownerRef.current = null
      publish({
        status: 'failed',
        relativePath,
        fileName: relativePath.split(/[\\/]/u).at(-1) ?? '',
        format: 'pdf',
        message: INVALID_SOURCE_MESSAGE,
        retryKind: 'query',
      })
      return
    }
    const owner = replaceOwner(source)
    const pendingCancellation = owner.pendingInstallCancellation
    if (!pendingCancellation) {
      queryAndContinueRef.current(owner)
      return
    }
    publish({
      status: 'converting',
      relativePath: owner.relativePath,
      fileName: owner.fileName,
      format: owner.format,
    })
    let continued = false
    const continueAfterHandoff = () => {
      if (continued) return
      continued = true
      if (owner.installCancellationTimeoutId !== null) {
        clearTimeout(owner.installCancellationTimeoutId)
        owner.installCancellationTimeoutId = null
      }
      if (owner.pendingInstallCancellation === pendingCancellation) {
        owner.pendingInstallCancellation = null
      }
      if (ownerIsCurrent(owner)) queryAndContinueRef.current(owner)
    }
    owner.installCancellationTimeoutId = setTimeout(
      continueAfterHandoff,
      INSTALL_CANCELLATION_HANDOFF_TIMEOUT_MS,
    )
    void pendingCancellation.then(continueAfterHandoff)
  }, [cancelOwnedRequests, ownerIsCurrent, publish, replaceOwner])

  const install = useCallback(() => {
    const current = stateRef.current
    if (current.status !== 'install-required') return
    const owner = replaceOwner(current)
    startInstallRef.current(owner)
  }, [replaceOwner])

  const retry = useCallback(() => {
    const current = stateRef.current
    if (current.status !== 'failed') return
    const source = safeSource(current.relativePath)
    if (!source) return
    const owner = replaceOwner(source)
    if (current.retryKind === 'install') startInstallRef.current(owner)
    else if (current.retryKind === 'conversion') startConversionRef.current(owner)
    else queryAndContinueRef.current(owner)
  }, [replaceOwner])

  const cancel = useCallback(() => {
    const owner = ownerRef.current
    generationRef.current += 1
    ownerRef.current = null
    cancelOwnedRequests(owner, window.arkdown)
    publish({ status: 'idle' })
  }, [cancelOwnedRequests, publish])

  const accept = useCallback((): ConvertedDocument | null => {
    const current = stateRef.current
    return current.status === 'preview' ? current.converted : null
  }, [])

  return { state, begin, install, retry, cancel, accept }
}
