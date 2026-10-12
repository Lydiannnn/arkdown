import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  Ref,
} from 'react'
import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { computePreferencesTocOffset } from './preferences-toc-offset'

const PREFERENCE_SCROLL_SETTLE_MS = 180
const PREFERENCES_SINGLE_COLUMN_QUERY = '(max-width: 900px)'

export function scrollPreferenceTarget(
  viewport: HTMLElement,
  target: HTMLElement,
  viewportRatio = 0.2,
): void {
  const viewportTop = viewport.getBoundingClientRect().top
  const targetTop = viewport.scrollTop + target.getBoundingClientRect().top - viewportTop
  const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const nextScrollTop = Math.min(
    maximumScrollTop,
    Math.max(0, targetTop - viewport.clientHeight * viewportRatio),
  )
  viewport.scrollTo({ top: nextScrollTop, behavior: 'smooth' })
}

export function preferenceSectionAtViewportPosition(
  viewport: HTMLElement,
  targets: readonly HTMLElement[],
  viewportRatio = 0.2,
): string | null {
  if (targets.length === 0) return null
  const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  if (viewport.scrollTop <= 0) return targets[0]?.id ?? null
  if (viewport.scrollTop >= maximumScrollTop - 1) return targets.at(-1)?.id ?? null

  const referenceTop = viewport.getBoundingClientRect().top
    + viewport.clientHeight * viewportRatio
  let activeTarget = targets[0]
  for (const target of targets) {
    if (target.getBoundingClientRect().top > referenceTop) break
    activeTarget = target
  }
  return activeTarget?.id ?? null
}

function sectionIdFromHref(href: string): string | null {
  if (!href.startsWith('#')) return null
  const sectionId = decodeURIComponent(href.slice(1))
  return sectionId || null
}

function markCurrentTocItem(node: ReactNode, activeSectionId: string | null): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; href?: string; 'aria-current'?: string }>(child)) {
      return child
    }
    const sectionId = typeof child.props.href === 'string'
      ? sectionIdFromHref(child.props.href)
      : null
    return cloneElement(child, {
      ...(sectionId
        ? { 'aria-current': sectionId === activeSectionId ? 'location' : undefined }
        : {}),
      ...(child.props.children
        ? { children: markCurrentTocItem(child.props.children, activeSectionId) }
        : {}),
    })
  })
}

function updateRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(value)
    return
  }
  ref.current = value
}

export interface PreferencesShellProps {
  ariaLabel: string
  className?: string
  tocLabel: string
  toc: ReactNode
  children: ReactNode
  footer?: ReactNode
  header?: ReactNode
  contentRef?: Ref<HTMLDivElement>
  footerClassName?: string
  onTocClick?(event: ReactMouseEvent<HTMLElement>): void
  status?: ReactNode
  style?: CSSProperties
}

export function PreferencesShell({
  ariaLabel,
  className = '',
  tocLabel,
  toc,
  children,
  footer,
  header,
  contentRef,
  footerClassName = '',
  onTocClick,
  status,
  style,
}: PreferencesShellProps) {
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const layoutRef = useRef<HTMLDivElement | null>(null)
  const tocRef = useRef<HTMLElement | null>(null)
  const clickLockRef = useRef<string | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [tocOffsetPx, setTocOffsetPx] = useState(0)

  const updateActiveSection = useCallback(() => {
    if (clickLockRef.current) return
    const viewport = scrollViewportRef.current
    const tocElement = tocRef.current
    if (!viewport || !tocElement) return
    const targets = Array.from(tocElement.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))
      .map((link) => sectionIdFromHref(link.getAttribute('href') ?? ''))
      .map((sectionId) => sectionId ? document.getElementById(sectionId) : null)
      .filter((target): target is HTMLElement => Boolean(target))
    const nextSectionId = preferenceSectionAtViewportPosition(viewport, targets)
    if (nextSectionId) setActiveSectionId(nextSectionId)
  }, [])

  const releaseClickLockAfterScroll = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      clickLockRef.current = null
      updateActiveSection()
    }, PREFERENCE_SCROLL_SETTLE_MS)
  }, [updateActiveSection])

  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return undefined
    const handleScroll = () => {
      if (clickLockRef.current) {
        releaseClickLockAfterScroll()
        return
      }
      updateActiveSection()
    }
    viewport.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', updateActiveSection)
    updateActiveSection()
    return () => {
      viewport.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', updateActiveSection)
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
    }
  }, [releaseClickLockAfterScroll, updateActiveSection])

  useEffect(() => {
    updateActiveSection()
  }, [children, toc, updateActiveSection])

  useEffect(() => {
    const layout = layoutRef.current
    const tocElement = tocRef.current
    if (!layout || !tocElement) return undefined

    const singleColumnQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia(PREFERENCES_SINGLE_COLUMN_QUERY)
      : null
    const updateTocOffset = () => {
      if (singleColumnQuery?.matches) {
        setTocOffsetPx(0)
        return
      }
      setTocOffsetPx((currentOffsetPx) => computePreferencesTocOffset({
        availableLeftPx: tocElement.getBoundingClientRect().left + currentOffsetPx,
      }))
    }
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateTocOffset)

    resizeObserver?.observe(layout)
    window.addEventListener('resize', updateTocOffset)
    singleColumnQuery?.addEventListener('change', updateTocOffset)
    updateTocOffset()

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateTocOffset)
      singleColumnQuery?.removeEventListener('change', updateTocOffset)
    }
  }, [])

  const handleTocClick = (event: ReactMouseEvent<HTMLElement>) => {
    onTocClick?.(event)
    if (event.defaultPrevented) return
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
    const sectionId = link ? sectionIdFromHref(link.hash) : null
    const target = sectionId ? document.getElementById(sectionId) : null
    const viewport = scrollViewportRef.current
    if (!target || !viewport) return
    event.preventDefault()
    clickLockRef.current = sectionId
    setActiveSectionId(sectionId)
    scrollPreferenceTarget(viewport, target)
    releaseClickLockAfterScroll()
  }

  return (
    <main
      aria-label={ariaLabel}
      className={`preferences-page preferences-shell${footer == null ? ' preferences-shell--without-footer' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <header aria-label="窗口拖动区域" className="preferences-page-header">
        {header}
      </header>
      <div
        aria-label="设置内容"
        className="preferences-page-content"
        ref={(element) => {
          scrollViewportRef.current = element
          updateRef(contentRef, element)
        }}
        role="region"
      >
        <div
          className="preferences-page-layout"
          ref={layoutRef}
          style={{ '--preferences-toc-offset': `${tocOffsetPx}px` } as CSSProperties}
        >
          <nav
            aria-label={tocLabel}
            className="preferences-toc"
            onClick={handleTocClick}
            ref={tocRef}
          >
            {markCurrentTocItem(toc, activeSectionId)}
          </nav>
          <div className="preferences-settings">
            {status}
            {children}
          </div>
        </div>
      </div>
      {footer != null && <footer
        aria-label="设置操作"
        className={`preferences-page-actions${footerClassName ? ` ${footerClassName}` : ''}`}
      >
        <div className="preferences-footer-layout">
          <div className="preferences-footer-content">{footer}</div>
        </div>
      </footer>}
    </main>
  )
}
