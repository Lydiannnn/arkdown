import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TransitionEvent as ReactTransitionEvent,
} from 'react'
import './editor-right-sidebar.css'

export type EditorRightSidebarTab = 'translation' | 'ai-chat' | 'document-view'

export type EditorRightSidebarPanels = Partial<Record<EditorRightSidebarTab, ReactNode>>

export interface EditorRightSidebarState {
  open: boolean
  activeTab: EditorRightSidebarTab
}

export interface EditorRightSidebarProps {
  activeTab: EditorRightSidebarTab
  containerWidth: number
  initialWidth?: number
  onActiveTabChange(tab: EditorRightSidebarTab): void
  onExitComplete?(restoreEditorFocus: boolean): void
  onWidthChange?(width: number): void
  open?: boolean
  panels?: EditorRightSidebarPanels
  children?: ReactNode
}

const DEFAULT_SIDEBAR_WIDTH = 530
const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 1800
const KEYBOARD_RESIZE_STEP = 10
const MOTION_FALLBACK_MS = 320
const MOTION_ENDPOINT_EPSILON_CSS_PX = 0.5

type SidebarMotionPhase = 'closed' | 'entering' | 'opening' | 'open' | 'closing'
type ActiveSidebarMotionPhase = Extract<SidebarMotionPhase, 'opening' | 'closing'>

interface ActiveSidebarMotion {
  generation: number
  phase: ActiveSidebarMotionPhase
  startedAt: number
  targetWidth: number
}

interface ActiveSidebarResize {
  pointerId: number
  stop(updateState?: boolean): void
}

const SIDEBAR_TABS: ReadonlyArray<{ id: EditorRightSidebarTab; label: string }> = [
  { id: 'ai-chat', label: 'AI 对话' },
  { id: 'translation', label: '翻译' },
  { id: 'document-view', label: '文档查看' },
]

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function requestMotionFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return window.setTimeout(() => callback(performance.now()), 16)
}

function cancelMotionFrame(frame: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  else clearTimeout(frame)
}

function safePointerCapture(
  target: HTMLElement,
  method: 'setPointerCapture' | 'releasePointerCapture',
  pointerId: number,
): void {
  try {
    target[method]?.(pointerId)
  } catch {
    // Capture can disappear when the window loses focus or the pointer leaves its native surface.
  }
}

function normalizedEventTimeStamp(event: Event): number {
  return event.timeStamp > performance.timeOrigin
    ? event.timeStamp - performance.timeOrigin
    : event.timeStamp
}

function normalizedMotionTimeNow(): number {
  return Date.now() - performance.timeOrigin
}

export function computeEditorRightSidebarWidth(_containerWidth: number): number {
  return DEFAULT_SIDEBAR_WIDTH
}

export function EditorRightSidebar({
  activeTab,
  containerWidth,
  initialWidth,
  onActiveTabChange,
  onExitComplete,
  onWidthChange,
  open = true,
  panels,
  children,
}: EditorRightSidebarProps) {
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ))
  const [motionPhase, setMotionPhaseState] = useState<SidebarMotionPhase>(
    open ? 'open' : 'closed',
  )
  const motionPhaseRef = useRef(motionPhase)
  const openRef = useRef(open)
  const trackRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Record<EditorRightSidebarTab, HTMLButtonElement | null>>({
    translation: null,
    'ai-chat': null,
    'document-view': null,
  })
  const motionGenerationRef = useRef(0)
  const activeMotionRef = useRef<ActiveSidebarMotion | null>(null)
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const restoreEditorFocusRef = useRef(false)
  const onExitCompleteRef = useRef(onExitComplete)
  const retainedPanelsRef = useRef<EditorRightSidebarPanels>({
    translation: children,
    'ai-chat': null,
    ...panels,
  })
  const activeResizeRef = useRef<ActiveSidebarResize | null>(null)
  openRef.current = open
  onExitCompleteRef.current = onExitComplete
  if (open) {
    retainedPanelsRef.current = {
      translation: children,
      'ai-chat': null,
      ...panels,
    }
  }
  const width = clamp(
    draggedWidth ?? initialWidth ?? computeEditorRightSidebarWidth(containerWidth),
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
  )

  useEffect(() => {
    setDraggedWidth(null)
  }, [initialWidth])

  const setMotionPhase = (nextPhase: SidebarMotionPhase) => {
    motionPhaseRef.current = nextPhase
    setMotionPhaseState(nextPhase)
  }

  const clearMotionCompletion = () => {
    if (completionTimerRef.current !== null) {
      clearTimeout(completionTimerRef.current)
      completionTimerRef.current = null
    }
    if (animationFrameRef.current !== null) {
      cancelMotionFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }

  const completeExit = (generation: number | null) => {
    const activeMotion = activeMotionRef.current
    if (
      motionPhaseRef.current !== 'closing'
      || (
        generation !== null
        && (
          activeMotion?.generation !== generation
          || activeMotion.phase !== 'closing'
          || motionGenerationRef.current !== generation
        )
      )
    ) return
    const restoreEditorFocus = restoreEditorFocusRef.current
      && Boolean(trackRef.current?.contains(document.activeElement))
    restoreEditorFocusRef.current = false
    clearMotionCompletion()
    activeMotionRef.current = null
    setMotionPhase('closed')
    onExitCompleteRef.current?.(restoreEditorFocus)
  }

  const completeOpening = (generation: number) => {
    const activeMotion = activeMotionRef.current
    if (
      motionPhaseRef.current !== 'opening'
      || activeMotion?.generation !== generation
      || activeMotion.phase !== 'opening'
      || motionGenerationRef.current !== generation
    ) return
    clearMotionCompletion()
    activeMotionRef.current = null
    setMotionPhase('open')
  }

  const startMotion = (phase: ActiveSidebarMotionPhase, targetWidth: number) => {
    clearMotionCompletion()
    const generation = motionGenerationRef.current + 1
    motionGenerationRef.current = generation
    activeMotionRef.current = {
      generation,
      phase,
      startedAt: normalizedMotionTimeNow(),
      targetWidth,
    }
    setMotionPhase(phase)
    completionTimerRef.current = setTimeout(() => {
      if (phase === 'closing') completeExit(generation)
      else completeOpening(generation)
    }, MOTION_FALLBACK_MS)
  }

  const invalidateMotion = () => {
    clearMotionCompletion()
    motionGenerationRef.current += 1
    activeMotionRef.current = null
  }

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    clearMotionCompletion()
    if (open) {
      restoreEditorFocusRef.current = false
      if (reducedMotion) {
        invalidateMotion()
        setMotionPhase('open')
        return
      }
      if (motionPhaseRef.current === 'closed') {
        invalidateMotion()
        setMotionPhase('entering')
        animationFrameRef.current = requestMotionFrame(() => {
          animationFrameRef.current = null
          if (!openRef.current || motionPhaseRef.current !== 'entering') return
          startMotion('opening', width)
        })
        return
      }
      if (motionPhaseRef.current === 'closing') {
        startMotion('opening', width)
      }
      return
    }

    activeResizeRef.current?.stop()
    if (motionPhaseRef.current === 'closed') return
    restoreEditorFocusRef.current = Boolean(
      trackRef.current?.contains(document.activeElement),
    )
    if (reducedMotion) {
      invalidateMotion()
      setMotionPhase('closing')
      completeExit(null)
      return
    }
    startMotion('closing', 0)
  }, [open, reducedMotion])

  useEffect(() => () => {
    clearMotionCompletion()
    activeResizeRef.current?.stop(false)
  }, [])

  const updateWidth = (nextWidth: number) => {
    const boundedWidth = clamp(nextWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
    setDraggedWidth(boundedWidth)
    onWidthChange?.(boundedWidth)
  }

  const startDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0
      || motionPhaseRef.current !== 'open'
      || activeResizeRef.current !== null
    ) return
    event.preventDefault()
    const captureTarget = event.currentTarget
    const startX = event.clientX
    const startWidth = width
    const pointerId = event.pointerId
    const move = (moveEvent: PointerEvent) => {
      if (activeResizeRef.current?.pointerId !== moveEvent.pointerId) return
      updateWidth(startWidth + startX - moveEvent.clientX)
    }
    const finish = (finishEvent: PointerEvent) => {
      const activeResize = activeResizeRef.current
      if (activeResize?.pointerId !== finishEvent.pointerId) return
      activeResize.stop()
    }
    const blur = () => gesture.stop()
    const gesture: ActiveSidebarResize = {
      pointerId,
      stop(updateState = true) {
        if (activeResizeRef.current !== gesture) return
        activeResizeRef.current = null
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', finish)
        document.removeEventListener('pointercancel', finish)
        window.removeEventListener('blur', blur)
        captureTarget.removeEventListener('lostpointercapture', finish)
        safePointerCapture(captureTarget, 'releasePointerCapture', pointerId)
        if (updateState) setIsResizing(false)
      },
    }
    activeResizeRef.current = gesture
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    window.addEventListener('blur', blur)
    captureTarget.addEventListener('lostpointercapture', finish)
    setIsResizing(true)
    safePointerCapture(captureTarget, 'setPointerCapture', pointerId)
  }

  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (motionPhaseRef.current !== 'open') return
    let nextWidth: number
    switch (event.key) {
      case 'ArrowLeft':
        nextWidth = width + KEYBOARD_RESIZE_STEP
        break
      case 'ArrowRight':
        nextWidth = width - KEYBOARD_RESIZE_STEP
        break
      case 'Home':
        nextWidth = MIN_SIDEBAR_WIDTH
        break
      case 'End':
        nextWidth = MAX_SIDEBAR_WIDTH
        break
      default:
        return
    }
    event.preventDefault()
    updateWidth(nextWidth)
  }

  const selectTabFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: EditorRightSidebarTab,
  ) => {
    const currentIndex = SIDEBAR_TABS.findIndex((tab) => tab.id === currentTab)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + SIDEBAR_TABS.length) % SIDEBAR_TABS.length
        break
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % SIDEBAR_TABS.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = SIDEBAR_TABS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const nextTab = SIDEBAR_TABS[nextIndex].id
    onActiveTabChange(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  const finishMotion = (event: ReactTransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== 'width') return
    const activeMotion = activeMotionRef.current
    if (
      !activeMotion
      || activeMotion.generation !== motionGenerationRef.current
      || activeMotion.phase !== motionPhaseRef.current
      || normalizedEventTimeStamp(event.nativeEvent) < activeMotion.startedAt
    ) return
    const computedWidth = Number.parseFloat(getComputedStyle(event.currentTarget).width)
    if (
      !Number.isFinite(computedWidth)
      || Math.abs(computedWidth - activeMotion.targetWidth) > MOTION_ENDPOINT_EPSILON_CSS_PX
    ) return
    if (activeMotion.phase === 'closing') completeExit(activeMotion.generation)
    else completeOpening(activeMotion.generation)
  }

  if (motionPhase === 'closed') return null

  const expanded = motionPhase === 'opening' || motionPhase === 'open'
  const activePanelId = `editor-right-sidebar-panel-${activeTab}`
  const activeTabId = `editor-right-sidebar-tab-${activeTab}`
  const activePanel = retainedPanelsRef.current[activeTab]
  const trackStyle = {
    '--editor-right-sidebar-width': `${width}px`,
    pointerEvents: motionPhase === 'closing' ? 'none' : undefined,
    width: expanded ? width : 0,
  } as CSSProperties

  return (
    <div
      className="editor-right-sidebar-motion-track"
      data-phase={motionPhase}
      data-resizing={isResizing ? 'true' : undefined}
      data-testid="editor-right-sidebar-motion-track"
      onTransitionEnd={finishMotion}
      ref={trackRef}
      style={trackStyle}
    >
      <div
        aria-label="调整右侧栏宽度"
        aria-orientation="vertical"
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={width}
        className="editor-right-sidebar-splitter"
        onKeyDown={resizeFromKeyboard}
        onPointerDown={startDragging}
        role="separator"
        tabIndex={motionPhase === 'open' ? 0 : -1}
      />
      <div className="editor-right-sidebar-motion-clip">
        <aside aria-label="右侧栏" className="editor-right-sidebar" style={{ width }}>
          <div aria-label="右侧栏功能" className="editor-right-sidebar-tabs" role="tablist">
            {SIDEBAR_TABS.map((tab) => (
              <button
                aria-controls={activeTab === tab.id
                  ? `editor-right-sidebar-panel-${tab.id}`
                  : undefined}
                aria-selected={activeTab === tab.id}
                className="editor-right-sidebar-tab"
                data-tab={tab.id}
                id={`editor-right-sidebar-tab-${tab.id}`}
                key={tab.id}
                onClick={() => onActiveTabChange(tab.id)}
                onKeyDown={(event) => selectTabFromKeyboard(event, tab.id)}
                ref={(element) => { tabRefs.current[tab.id] = element }}
                role="tab"
                tabIndex={activeTab === tab.id ? 0 : -1}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div
            aria-labelledby={activeTabId}
            className="editor-right-sidebar-panel"
            id={activePanelId}
            role="tabpanel"
          >
            {activePanel}
          </div>
        </aside>
      </div>
    </div>
  )
}
