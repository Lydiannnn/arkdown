import {
  useCallback,
  createElement,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useModalEscape } from './use-modal-escape'
import { registerModalLayer } from './modal-background-manager'
import './arkdown-dialog.css'

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function meaningfulActiveElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement
    && document.activeElement !== document.body
    && document.activeElement !== document.documentElement
    ? document.activeElement
    : null
}

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export type ArkdownDialogSize = 'small' | 'medium' | 'large'
export type ArkdownDialogTone = 'default' | 'danger'

export interface ArkdownDialogControls {
  closing: boolean
  requestClose(onClosed?: () => void): void
}

export type ArkdownDialogActions =
  | ReactNode
  | ((controls: ArkdownDialogControls) => ReactNode)

export type ArkdownDialogContent =
  | ReactNode
  | ((controls: ArkdownDialogControls) => ReactNode)

export type ArkdownDialogSubmitHandler = (
  event: FormEvent<HTMLElement>,
  controls: ArkdownDialogControls,
) => void

export interface ArkdownDialogProps {
  actions?: ArkdownDialogActions
  actionsClassName?: string
  ariaDescribedBy?: string
  backdropClassName?: string
  backdropData?: Record<`data-${string}`, string>
  cancelOnBackdrop?: boolean
  children?: ArkdownDialogContent
  className?: string
  description?: ReactNode
  descriptionClassName?: string
  error?: ReactNode
  errorClassName?: string
  errorData?: Record<`data-${string}`, string>
  errorProps?: Omit<HTMLAttributes<HTMLParagraphElement>, 'children' | 'className'>
  escapeEnabled?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  onCancel(): void
  onSubmit?: ArkdownDialogSubmitHandler
  portal?: boolean
  role?: 'dialog' | 'alertdialog'
  restoreFocusElement?: HTMLElement | null
  size?: ArkdownDialogSize
  surface?: 'div' | 'form' | 'section'
  title: ReactNode
  tone?: ArkdownDialogTone
}

export function ArkdownDialog({
  actions,
  actionsClassName,
  ariaDescribedBy,
  backdropClassName,
  backdropData,
  cancelOnBackdrop = true,
  children,
  className,
  description,
  descriptionClassName,
  error,
  errorClassName,
  errorData,
  errorProps,
  escapeEnabled = true,
  initialFocusRef,
  onCancel,
  onSubmit,
  portal = true,
  role = 'dialog',
  restoreFocusElement,
  size = 'medium',
  surface = 'section',
  title,
  tone = 'default',
}: ArkdownDialogProps) {
  const [closing, setClosing] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(
    restoreFocusElement === undefined ? meaningfulActiveElement() : restoreFocusElement,
  )
  const contextualBackgroundRef = useRef(
    restoreFocusRef.current?.closest<HTMLElement>('.preferences-page, .app-shell')
      ?? document.querySelector<HTMLElement>('.preferences-page, .app-shell'),
  )
  const themeColorSource = restoreFocusRef.current ?? contextualBackgroundRef.current
  const themeColorRgbRef = useRef(
    themeColorSource
      ? getComputedStyle(themeColorSource).getPropertyValue('--theme-color-rgb').trim()
      : '',
  )
  const closingRef = useRef(false)
  const closeLifecycleGenerationRef = useRef(0)
  const closeCompletionRef = useRef<(() => void) | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const describedBy = [description ? descriptionId : null, ariaDescribedBy]
    .filter(Boolean)
    .join(' ') || undefined

  const finishClose = useCallback(() => {
    if (!closingRef.current) return
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    const completion = closeCompletionRef.current
    closeCompletionRef.current = null
    completion?.()
  }, [])

  const requestClose = useCallback((onClosed: () => void = onCancel) => {
    if (closingRef.current) return
    closingRef.current = true
    closeCompletionRef.current = onClosed
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) {
      finishClose()
      return
    }
    setClosing(true)
    closeTimerRef.current = setTimeout(finishClose, 120)
  }, [finishClose, onCancel])

  const controls = useMemo<ArkdownDialogControls>(() => ({
    closing,
    requestClose,
  }), [closing, requestClose])

  useModalEscape(dialogRef, requestClose, escapeEnabled && !closing)

  useLayoutEffect(() => {
    const generation = ++closeLifecycleGenerationRef.current
    return () => {
      queueMicrotask(() => {
        if (closeLifecycleGenerationRef.current !== generation) return
        finishClose()
      })
    }
  }, [finishClose])

  useLayoutEffect(() => {
    const backdrop = backdropRef.current
    const dialog = dialogRef.current
    if (!backdrop || !dialog) return

    const unregisterModal = registerModalLayer(
      backdrop,
      dialog,
      restoreFocusRef.current,
      contextualBackgroundRef.current,
    )

    const existingDialogFocus = dialog.contains(document.activeElement)
      && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    ;(initialFocusRef?.current ?? existingDialogFocus ?? dialog).focus({ preventScroll: true })

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const activeModals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]')
      if (activeModals.item(activeModals.length - 1) !== dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', trapFocus, true)

    return () => {
      document.removeEventListener('keydown', trapFocus, true)
      unregisterModal()
    }
  }, [initialFocusRef])

  const surfaceElement = createElement(
    surface,
    {
      'aria-describedby': describedBy,
      'aria-labelledby': titleId,
      'aria-modal': true,
      className: classes(
        'arkdown-dialog',
        `arkdown-dialog--${size}`,
        className,
      ),
      'data-tone': tone,
      onSubmit: onSubmit ? (event: FormEvent<HTMLElement>) => {
        if (closingRef.current) {
          event.preventDefault()
          return
        }
        onSubmit(event, controls)
      } : undefined,
      ref: dialogRef,
      role,
      tabIndex: -1,
    },
    <>
      <header className="arkdown-dialog__header">
        <h2 className="arkdown-dialog__title" id={titleId}>{title}</h2>
        {description && (
          <p
            className={classes('arkdown-dialog__description', descriptionClassName)}
            id={descriptionId}
          >{description}</p>
        )}
      </header>
      {children && (
        <div className="arkdown-dialog__content">
          {typeof children === 'function' ? children(controls) : children}
        </div>
      )}
      {error && (
        <p
          {...errorProps}
          {...errorData}
          aria-live="assertive"
          className={classes('arkdown-dialog__error', errorClassName)}
          role="alert"
        >
          {error}
        </p>
      )}
      {actions && (
        <div className={classes('arkdown-dialog__actions', actionsClassName)}>
          {typeof actions === 'function' ? actions(controls) : actions}
        </div>
      )}
    </>,
  )

  const layer = (
    <div
      {...backdropData}
      className={classes('arkdown-dialog-backdrop', backdropClassName)}
      data-arkdown-dialog-backdrop="true"
      data-state={closing ? 'closing' : 'open'}
      data-tooltip-layer="modal"
      onMouseDown={(event) => {
        if (
          cancelOnBackdrop
          && escapeEnabled
          && event.target === event.currentTarget
        ) requestClose()
      }}
      ref={backdropRef}
      style={{
        ...(themeColorRgbRef.current
          ? { '--theme-color-rgb': themeColorRgbRef.current }
          : {}),
      } as CSSProperties}
    >
      {surfaceElement}
    </div>
  )

  return portal ? createPortal(layer, document.body) : layer
}
