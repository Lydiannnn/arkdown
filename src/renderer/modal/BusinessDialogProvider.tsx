import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ArkdownDialog,
  type ArkdownDialogTone,
} from './ArkdownDialog'

export type BusinessDialogResult = 'confirm' | 'cancel' | 'discard'

interface BusinessDialogOptions {
  title: string
  description?: string
  tone?: ArkdownDialogTone
}

export interface BusinessConfirmOptions extends BusinessDialogOptions {
  signal?: AbortSignal
  confirmLabel: string
  cancelLabel: string
  discardLabel?: string
  actionOrder?: 'cancel-confirm' | 'confirm-cancel'
}

export interface BusinessAlertOptions extends BusinessDialogOptions {
  confirmLabel?: string
}

export interface BusinessPromptOptions extends BusinessDialogOptions {
  defaultValue?: string
  inputLabel?: string
  /** Retained for existing callers; all prompts now use the standard field. */
  fieldStyle?: 'standard'
  confirmLabel?: string
  cancelLabel?: string
}

export interface BusinessDialogController {
  alert(options: BusinessAlertOptions): Promise<void>
  confirm(options: BusinessConfirmOptions): Promise<BusinessDialogResult>
  prompt(options: BusinessPromptOptions): Promise<string | null>
}

interface PendingRequestBase {
  id: number
  settled: boolean
  cancel(): void
}

interface PendingAlertRequest extends PendingRequestBase {
  kind: 'alert'
  options: BusinessAlertOptions
  resolve(): void
}

interface PendingConfirmRequest extends PendingRequestBase {
  kind: 'confirm'
  options: BusinessConfirmOptions
  resolve(result: BusinessDialogResult): void
}

interface PendingPromptRequest extends PendingRequestBase {
  kind: 'prompt'
  options: BusinessPromptOptions
  resolve(result: string | null): void
}

type PendingRequest = PendingAlertRequest | PendingConfirmRequest | PendingPromptRequest
type SettleRequest = (request: PendingRequest, complete: () => void) => void

const BusinessDialogContext = createContext<BusinessDialogController | null>(null)

export function useBusinessDialog(): BusinessDialogController {
  const value = useContext(BusinessDialogContext)
  if (!value) throw new Error('useBusinessDialog must be used within BusinessDialogProvider')
  return value
}

export function useOptionalBusinessDialog(): BusinessDialogController | null {
  return useContext(BusinessDialogContext)
}

function AlertRequestDialog({
  request,
  restoreFocusElement,
  settle,
}: {
  request: PendingAlertRequest
  restoreFocusElement: HTMLElement | null
  settle: SettleRequest
}) {
  const accept = () => settle(request, request.resolve)
  return (
    <ArkdownDialog
      actions={({ requestClose }) => (
        <button
          className="arkdown-dialog__primary"
          onClick={() => requestClose(accept)}
          type="button"
        >{request.options.confirmLabel ?? '确定'}</button>
      )}
      description={request.options.description}
      onCancel={accept}
      role="alertdialog"
      restoreFocusElement={restoreFocusElement}
      title={request.options.title}
      tone={request.options.tone}
    />
  )
}

function ConfirmRequestDialog({
  request,
  restoreFocusElement,
  settle,
}: {
  request: PendingConfirmRequest
  restoreFocusElement: HTMLElement | null
  settle: SettleRequest
}) {
  const complete = (result: BusinessDialogResult) => () => (
    settle(request, () => request.resolve(result))
  )
  return (
    <ArkdownDialog
      actions={({ requestClose }) => {
        const confirmAction = <button
          className="arkdown-dialog__primary"
          onClick={() => requestClose(complete('confirm'))}
          type="button"
        >{request.options.confirmLabel}</button>
        const cancelAction = <button
          onClick={() => requestClose(complete('cancel'))}
          type="button"
        >{request.options.cancelLabel}</button>
        return request.options.discardLabel ? <>
          {confirmAction}
          <button
            onClick={() => requestClose(complete('discard'))}
            type="button"
          >{request.options.discardLabel}</button>
          {cancelAction}
        </> : request.options.actionOrder === 'confirm-cancel'
          ? <>{confirmAction}{cancelAction}</>
          : <>{cancelAction}{confirmAction}</>
      }}
      description={request.options.description}
      onCancel={complete('cancel')}
      restoreFocusElement={restoreFocusElement}
      title={request.options.title}
      tone={request.options.discardLabel ? 'default' : request.options.tone}
    />
  )
}

function PromptRequestDialog({
  request,
  restoreFocusElement,
  settle,
}: {
  request: PendingPromptRequest
  restoreFocusElement: HTMLElement | null
  settle: SettleRequest
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(request.options.defaultValue ?? '')
  const cancel = () => settle(request, () => request.resolve(null))
  const confirm = () => settle(request, () => request.resolve(value))
  return (
    <ArkdownDialog
      actions={({ requestClose }) => <>
        <button onClick={() => requestClose(cancel)} type="button">
          {request.options.cancelLabel ?? '取消'}
        </button>
        <button className="arkdown-dialog__primary" type="submit">
          {request.options.confirmLabel ?? '确定'}
        </button>
      </>}
      description={request.options.description}
      initialFocusRef={inputRef}
      onCancel={cancel}
      onSubmit={(event, { requestClose }) => {
        event.preventDefault()
        requestClose(confirm)
      }}
      restoreFocusElement={restoreFocusElement}
      size="small"
      surface="form"
      title={request.options.title}
      tone={request.options.tone}
    >
      <label className="arkdown-dialog__prompt-field">
        <span>{request.options.inputLabel ?? request.options.title}</span>
        <input
          aria-label={request.options.inputLabel ?? request.options.title}
          onChange={(event) => setValue(event.target.value)}
          ref={inputRef}
          value={value}
        />
      </label>
    </ArkdownDialog>
  )
}

export function BusinessDialogProvider({ children }: { children: ReactNode }) {
  const sequenceRef = useRef(0)
  const acceptingRef = useRef(true)
  const lifecycleGenerationRef = useRef(0)
  const queueOpenerRef = useRef<HTMLElement | null>(null)
  const queueRef = useRef<PendingRequest[]>([])
  const activeRef = useRef<PendingRequest | null>(null)
  const [active, setActive] = useState<PendingRequest | null>(null)

  const presentNext = useCallback(() => {
    if (!acceptingRef.current || activeRef.current) return
    const next = queueRef.current.shift() ?? null
    activeRef.current = next
    if (!next) queueOpenerRef.current = null
    setActive(next)
  }, [])

  const settle = useCallback<SettleRequest>((request, complete) => {
    if (request.settled || activeRef.current !== request) return
    request.settled = true
    activeRef.current = null
    complete()
    const next = queueRef.current.shift() ?? null
    activeRef.current = next
    setActive(next)
  }, [])

  const enqueue = useCallback((request: PendingRequest) => {
    if (!acceptingRef.current) {
      request.settled = true
      request.cancel()
      return
    }
    if (!activeRef.current && queueRef.current.length === 0) {
      queueOpenerRef.current = document.activeElement instanceof HTMLElement
        && document.activeElement !== document.body
        && document.activeElement !== document.documentElement
        ? document.activeElement
        : null
    }
    queueRef.current.push(request)
    presentNext()
  }, [presentNext])

  const alert = useCallback((options: BusinessAlertOptions) => (
    new Promise<void>((resolve) => {
      enqueue({
        id: ++sequenceRef.current,
        kind: 'alert',
        options,
        resolve,
        cancel: resolve,
        settled: false,
      })
    })
  ), [enqueue])

  const confirm = useCallback((options: BusinessConfirmOptions) => (
    new Promise<BusinessDialogResult>((resolve) => {
      if (options.signal?.aborted) { resolve('cancel'); return }
      const finish = (result: BusinessDialogResult) => {
        options.signal?.removeEventListener('abort', abort)
        resolve(result)
      }
      const request: PendingConfirmRequest = {
        id: ++sequenceRef.current,
        kind: 'confirm',
        options,
        resolve: finish,
        cancel: () => finish('cancel'),
        settled: false,
      }
      const abort = () => {
        if (request.settled) return
        if (activeRef.current === request) settle(request, request.cancel)
        else {
          queueRef.current = queueRef.current.filter((queued) => queued !== request)
          request.settled = true
          request.cancel()
        }
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      enqueue(request)
    })
  ), [enqueue, settle])

  const prompt = useCallback((options: BusinessPromptOptions) => (
    new Promise<string | null>((resolve) => {
      enqueue({
        id: ++sequenceRef.current,
        kind: 'prompt',
        options,
        resolve,
        cancel: () => resolve(null),
        settled: false,
      })
    })
  ), [enqueue])

  const cancelPending = useCallback(() => {
    const pending = [activeRef.current, ...queueRef.current]
    activeRef.current = null
    queueRef.current = []
    for (const request of pending) {
      if (!request || request.settled) continue
      request.settled = true
      request.cancel()
    }
  }, [])

  useEffect(() => {
    const generation = ++lifecycleGenerationRef.current
    acceptingRef.current = true
    return () => {
      acceptingRef.current = false
      queueMicrotask(() => {
        if (
          lifecycleGenerationRef.current !== generation
          || acceptingRef.current
        ) return
        cancelPending()
      })
    }
  }, [cancelPending])

  const controller = useMemo<BusinessDialogController>(() => ({
    alert,
    confirm,
    prompt,
  }), [alert, confirm, prompt])

  return (
    <BusinessDialogContext.Provider value={controller}>
      {children}
      {active?.kind === 'alert' && (
        <AlertRequestDialog
          key={active.id}
          request={active}
          restoreFocusElement={queueOpenerRef.current}
          settle={settle}
        />
      )}
      {active?.kind === 'confirm' && (
        <ConfirmRequestDialog
          key={active.id}
          request={active}
          restoreFocusElement={queueOpenerRef.current}
          settle={settle}
        />
      )}
      {active?.kind === 'prompt' && (
        <PromptRequestDialog
          key={active.id}
          request={active}
          restoreFocusElement={queueOpenerRef.current}
          settle={settle}
        />
      )}
    </BusinessDialogContext.Provider>
  )
}
