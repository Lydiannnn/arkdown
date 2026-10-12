import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { CaretDown } from '@phosphor-icons/react'
import './preferences-select.css'
import { mainAppPortalMarker } from '../app/ui-selection-guard'
import { AppIcon } from '../icons/AppIcon'

export interface PreferencesSelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

interface PreferencesSelectProps<T extends string> {
  ariaDescribedBy?: string
  autoFocus?: boolean
  className?: string
  menuTitle?: string
  menuClassName?: string
  optionTooltips?: boolean
  disabled?: boolean
  label: string
  onChange(value: T): void
  options: readonly PreferencesSelectOption<T>[]
  value: T
}

interface MenuPosition {
  left: number
  top: number
  width: number
  maxHeight: number
  themeColorRgb: string
}

const VIEWPORT_MARGIN = 8
const MENU_GAP = 4
const MAX_MENU_HEIGHT = 320
const SCROLL_SEQUENCE_FALLBACK_MS = 120
const SCROLL_SEQUENCE_MAX_MS = 400
const SCROLL_INTENT_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
])

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

export function PreferencesSelect<T extends string>({
  ariaDescribedBy,
  autoFocus = false,
  className,
  menuTitle,
  menuClassName,
  optionTooltips = true,
  disabled = false,
  label,
  onChange,
  options,
  value,
}: PreferencesSelectProps<T>) {
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(false)
  const recentScrollTargetRef = useRef<EventTarget | null>(null)
  const ignoredOpeningScrollTargetRef = useRef<EventTarget | null>(null)
  const ignoredOpeningScrollDeadlineRef = useRef<number | null>(null)
  const scrollSequenceTimerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const selected = options.find((option) => option.value === value)

  const clearScrollTracking = useCallback(() => {
    recentScrollTargetRef.current = null
    ignoredOpeningScrollTargetRef.current = null
    ignoredOpeningScrollDeadlineRef.current = null
    if (scrollSequenceTimerRef.current !== null) {
      window.clearTimeout(scrollSequenceTimerRef.current)
      scrollSequenceTimerRef.current = null
    }
  }, [])

  const finishScrollSequence = useCallback((target: EventTarget | null) => {
    if (
      recentScrollTargetRef.current !== target
      && ignoredOpeningScrollTargetRef.current !== target
    ) return
    clearScrollTracking()
  }, [clearScrollTracking])

  const scheduleScrollSequenceFallback = useCallback((target: EventTarget | null) => {
    if (scrollSequenceTimerRef.current !== null) {
      window.clearTimeout(scrollSequenceTimerRef.current)
    }
    const deadline = ignoredOpeningScrollDeadlineRef.current
    const delay = deadline === null
      ? SCROLL_SEQUENCE_FALLBACK_MS
      : Math.min(SCROLL_SEQUENCE_FALLBACK_MS, deadline - Date.now())
    if (delay <= 0) {
      finishScrollSequence(target)
      return
    }
    scrollSequenceTimerRef.current = window.setTimeout(() => {
      scrollSequenceTimerRef.current = null
      finishScrollSequence(target)
    }, delay)
  }, [finishScrollSequence])

  useEffect(() => {
    const trackScroll = (event: Event) => {
      const target = event.target
      if (openRef.current) {
        if (target === ignoredOpeningScrollTargetRef.current) {
          scheduleScrollSequenceFallback(target)
        }
        return
      }
      recentScrollTargetRef.current = target
      ignoredOpeningScrollDeadlineRef.current = null
      scheduleScrollSequenceFallback(target)
    }
    const finishForScrollEnd = (event: Event) => {
      const target = event.target
      if (
        target === recentScrollTargetRef.current
        || target === ignoredOpeningScrollTargetRef.current
      ) finishScrollSequence(target)
    }

    window.addEventListener('scroll', trackScroll, true)
    window.addEventListener('scrollend', finishForScrollEnd, true)
    return () => {
      window.removeEventListener('scroll', trackScroll, true)
      window.removeEventListener('scrollend', finishForScrollEnd, true)
      clearScrollTracking()
    }
  }, [clearScrollTracking, finishScrollSequence, scheduleScrollSequenceFallback])

  const focusSelected = useCallback((fallback: 'first' | 'last' = 'first') => {
    queueMicrotask(() => {
      const menu = menuRef.current
      if (!menu) return
      const selectedOption = menu.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]:not(:disabled)',
      )
      const enabled = Array.from(menu.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      ))
      const target = selectedOption ?? (fallback === 'last' ? enabled.at(-1) : enabled[0])
      target?.scrollIntoView?.({ block: 'nearest' })
      target?.focus({ preventScroll: true })
    })
  }, [])

  const openMenu = useCallback((fallback: 'first' | 'last' = 'first') => {
    if (disabled || options.length === 0) return
    ignoredOpeningScrollTargetRef.current = recentScrollTargetRef.current
    ignoredOpeningScrollDeadlineRef.current = recentScrollTargetRef.current === null
      ? null
      : Date.now() + SCROLL_SEQUENCE_MAX_MS
    openRef.current = true
    setOpen(true)
    focusSelected(fallback)
  }, [disabled, focusSelected, options.length])

  const closeMenu = useCallback((restoreFocus = false) => {
    openRef.current = false
    clearScrollTracking()
    setOpen(false)
    setPosition(null)
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus())
  }, [clearScrollTracking])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const menu = menuRef.current
    const width = Math.max(210, triggerRect.width)
    const desiredHeight = Math.min(menu.scrollHeight, MAX_MENU_HEIGHT, window.innerHeight - 16)
    const roomBelow = window.innerHeight - triggerRect.bottom - VIEWPORT_MARGIN - MENU_GAP
    const roomAbove = triggerRect.top - VIEWPORT_MARGIN - MENU_GAP
    const openAbove = roomBelow < Math.min(desiredHeight, 160) && roomAbove > roomBelow
    const availableHeight = Math.max(80, openAbove ? roomAbove : roomBelow)
    const height = Math.min(desiredHeight, availableHeight)
    const top = openAbove
      ? triggerRect.top - MENU_GAP - height
      : triggerRect.bottom + MENU_GAP
    const left = clamp(
      triggerRect.left,
      VIEWPORT_MARGIN,
      window.innerWidth - width - VIEWPORT_MARGIN,
    )
    const themeColorRgb = getComputedStyle(triggerRef.current)
      .getPropertyValue('--theme-color-rgb')
      .trim()

    setPosition({
      left,
      top: clamp(top, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
      width,
      maxHeight: availableHeight,
      themeColorRgb,
    })
  }, [open, options.length, value])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (
        target
        && !rootRef.current?.contains(target)
        && !menuRef.current?.contains(target)
      ) closeMenu()
    }
    const closeForResize = () => closeMenu()
    const comesFromIgnoredOpeningScrollTarget = (event: Event) => {
      const path = event.composedPath()
      const menu = menuRef.current
      if (menu && path.includes(menu)) return false
      const ignoredTarget = ignoredOpeningScrollTargetRef.current
      return ignoredTarget !== null && path.includes(ignoredTarget)
    }
    const closeForScrollIntent = (event: Event) => {
      if (comesFromIgnoredOpeningScrollTarget(event)) closeMenu()
    }
    const closeForKeyboardScrollIntent = (event: globalThis.KeyboardEvent) => {
      if (
        SCROLL_INTENT_KEYS.has(event.key)
        && comesFromIgnoredOpeningScrollTarget(event)
      ) closeMenu()
    }
    const closeForScroll = (event: Event) => {
      const target = event.target
      if (target === ignoredOpeningScrollTargetRef.current) return
      if (target instanceof Node && menuRef.current?.contains(target)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', closeOutside)
    window.addEventListener('resize', closeForResize)
    window.addEventListener('wheel', closeForScrollIntent, true)
    window.addEventListener('touchstart', closeForScrollIntent, true)
    window.addEventListener('keydown', closeForKeyboardScrollIntent, true)
    window.addEventListener('scroll', closeForScroll, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('resize', closeForResize)
      window.removeEventListener('wheel', closeForScrollIntent, true)
      window.removeEventListener('touchstart', closeForScrollIntent, true)
      window.removeEventListener('keydown', closeForKeyboardScrollIntent, true)
      window.removeEventListener('scroll', closeForScroll, true)
    }
  }, [closeMenu, open])

  const moveFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    mode: 'next' | 'previous' | 'first' | 'last',
  ) => {
    const enabled = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="option"]:not(:disabled)',
    ) ?? [])
    if (enabled.length === 0) return
    const current = enabled.indexOf(event.currentTarget)
    const target = mode === 'first'
      ? enabled[0]
      : mode === 'last'
        ? enabled.at(-1)
        : enabled[
          (current + (mode === 'next' ? 1 : -1) + enabled.length) % enabled.length
        ]
    target?.focus()
  }

  const choose = (nextValue: T) => {
    onChange(nextValue)
    closeMenu(true)
  }

  return (
    <div className="preferences-select-root" ref={rootRef}>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-describedby={ariaDescribedBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        autoFocus={autoFocus}
        className={[
          'preferences-compact-select',
          'preferences-select-trigger',
          className,
        ].filter(Boolean).join(' ')}
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu(true)
          else openMenu()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) openMenu(event.key === 'ArrowUp' ? 'last' : 'first')
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (open) closeMenu(true)
            else openMenu()
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            closeMenu(true)
          }
        }}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="preferences-select-value">{selected?.label ?? value}</span>
        <span aria-hidden="true" className="preferences-select-chevron">
          <CaretDown aria-hidden="true" size={14} weight="regular" />
        </span>
      </button>
      {open && createPortal(
        <div
          aria-label={label}
          className={['preferences-select-menu', menuClassName].filter(Boolean).join(' ')}
          data-ui-selection-portal={mainAppPortalMarker()}
          id={listboxId}
          ref={menuRef}
          role="listbox"
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            width: position?.width ?? 210,
            maxHeight: position?.maxHeight ?? MAX_MENU_HEIGHT,
            visibility: position ? 'visible' : 'hidden',
            '--theme-color-rgb': position?.themeColorRgb || '198 40 40',
          } as CSSProperties}
        >
          {menuTitle && <div className="preferences-select-menu-title" role="presentation">{menuTitle}</div>}
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              disabled={option.disabled}
              key={option.value}
              onClick={() => choose(option.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  moveFocus(event, event.key === 'ArrowDown' ? 'next' : 'previous')
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  moveFocus(event, event.key === 'Home' ? 'first' : 'last')
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  choose(option.value)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  closeMenu(true)
                } else if (event.key === 'Tab') {
                  closeMenu()
                }
              }}
              role="option"
              data-tooltip={optionTooltips ? option.label : undefined}
              type="button"
            >
              <span aria-hidden="true" className="preferences-select-check">
                {option.value === value ? <AppIcon name="check" size={16} /> : null}
              </span>
              <span className="preferences-select-option-label">{option.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
