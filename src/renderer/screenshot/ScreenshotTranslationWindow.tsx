import { ModelPreferenceDraft } from '../settings/model-preference-draft'
import { createPreferencePersistence } from '../settings/preference-update-queue'
import type { ClosePreparationAttempt } from '../../shared/close-preparation'
import { areModelRulesReady, useModelRulesReady } from '../settings/model-rules-runtime'
import type { LargeModelSettings } from '../../shared/large-model-settings'
import type { ModelThinkingPreference } from '../../shared/model-thinking'
import { ModelThinkingControls } from '../editor/ModelThinkingControls'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type {
  ScreenshotImage,
  ScreenshotOcrBlock,
  ScreenshotPublicErrorCode,
  ScreenshotTranslatedBlock,
  ScreenshotTranslationEvent,
  ScreenshotTranslationGenerationInput,
} from '../../shared/screenshot-translation'
import type { ScreenshotOcrTier } from '../../shared/screenshot-ocr-models'
import type { ScreenshotTranslationDisplayMode } from '../../shared/screenshot-document-translation'
import { AppIcon } from '../icons/AppIcon'
import { ScreenshotDocumentTranslation } from './ScreenshotDocumentTranslation'
import { ScreenshotTextSidebar } from './ScreenshotTextSidebar'
import { useScreenshotTextMenu } from './ScreenshotTextMenu'
import { computeScreenshotOverlayLayout } from './screenshot-overlay-layout'
import './screenshot-translation-window.css'

type ResultPhase =
  | 'boot'
  | 'ocr-running'
  | 'ocr-empty'
  | 'ready-original'
  | 'translation-running'
  | 'translated'
  | 'translated-hidden'
  | 'translation-failed'
  | 'model-unconfigured'

interface ResultState {
  generation: number
  phase: ResultPhase
  image?: ScreenshotImage
  blocks: readonly ScreenshotOcrBlock[]
  displayMode: ScreenshotTranslationDisplayMode
  translations: readonly ScreenshotTranslatedBlock[]
  cachedTranslations: readonly ScreenshotTranslatedBlock[]
  cachedDisplayMode: ScreenshotTranslationDisplayMode
  documentText: string
  cachedDocumentText: string
  cachedCompletion: 'none' | 'partial' | 'complete'
  cachedFailure?: ScreenshotPublicErrorCode
  previousTranslations: readonly ScreenshotTranslatedBlock[]
  failure?: ScreenshotPublicErrorCode
  rejectedGeneration?: number
  activeAttemptId?: number
  cancelledAttemptId?: number
  announcement: string
  tier: ScreenshotOcrTier
}

type ResultAction =
  | { type: 'event'; event: ScreenshotTranslationEvent }
  | { type: 'cancel-local' }
  | { type: 'hide-translations' }
  | { type: 'show-translations' }
  | { type: 'start-local'; attemptId: number }
  | { type: 'start-accepted'; attemptId: number; generation: number }
  | { type: 'start-failed'; attemptId: number; generation: number }

const INITIAL_STATE: ResultState = {
  generation: 0,
  phase: 'boot',
  blocks: [],
  displayMode: 'overlay',
  translations: [],
  cachedTranslations: [],
  cachedDisplayMode: 'overlay',
  documentText: '',
  cachedDocumentText: '',
  cachedCompletion: 'none',
  previousTranslations: [],
  announcement: '正在准备截图…',
  tier: 'small',
}

function resultReducer(state: ResultState, action: ResultAction): ResultState {
  if (action.type === 'cancel-local') {
    const hasCachedTranslation = state.cachedTranslations.length > 0 || state.cachedDocumentText.length > 0
    return {
      ...state,
      phase: hasCachedTranslation
        ? 'translated-hidden'
        : state.blocks.length > 0 ? 'ready-original' : 'ocr-empty',
      translations: state.cachedTranslations,
      displayMode: state.cachedDisplayMode,
      documentText: state.cachedDocumentText,
      failure: undefined,
      rejectedGeneration: state.generation,
      cancelledAttemptId: state.activeAttemptId,
      activeAttemptId: undefined,
      announcement: '已取消翻译',
    }
  }
  if (action.type === 'hide-translations') {
    return {
      ...state,
      phase: 'translated-hidden',
      failure: undefined,
      activeAttemptId: undefined,
      announcement: '已显示原图',
    }
  }
  if (action.type === 'show-translations') {
    if (state.cachedTranslations.length === 0 && state.cachedDocumentText.length === 0) return state
    return {
      ...state,
      phase: state.cachedCompletion === 'partial' ? 'translation-failed' : 'translated',
      displayMode: state.cachedDisplayMode,
      translations: state.cachedTranslations,
      documentText: state.cachedDocumentText,
      failure: state.cachedFailure,
      activeAttemptId: undefined,
      announcement: state.cachedCompletion === 'partial' ? '部分内容翻译未完成，可重新翻译' : '翻译完成',
    }
  }
  if (action.type === 'start-local') {
    return {
      ...state,
      phase: 'translation-running',
      translations: state.cachedTranslations,
      documentText: '',
      previousTranslations: state.cachedTranslations,
      failure: undefined,
      rejectedGeneration: state.generation,
      activeAttemptId: action.attemptId,
      cancelledAttemptId: undefined,
      announcement: '正在翻译…',
    }
  }
  if (action.type === 'start-accepted') {
    if (state.cancelledAttemptId !== action.attemptId) return state
    return state
  }
  if (action.type === 'start-failed') {
    if (state.cancelledAttemptId === action.attemptId) {
      return { ...state, cancelledAttemptId: undefined }
    }
    if (state.generation !== action.generation
      || state.activeAttemptId !== action.attemptId
      || state.phase !== 'translation-running') return state
    return {
      ...state,
      phase: 'translation-failed',
      failure: 'TRANSLATION_FAILED',
      activeAttemptId: undefined,
      announcement: failureMessage('TRANSLATION_FAILED'),
    }
  }

  const event = action.event
  if (event.type === 'snapshot-ready') {
    if (state.generation !== 0 && event.generation <= state.generation) return state
    const sameImage = state.image?.dataUrl === event.image.dataUrl
      && state.image.width === event.image.width
      && state.image.height === event.image.height
    const continuingTranslation = state.activeAttemptId !== undefined && sameImage
    const cancelledTranslation = state.rejectedGeneration === event.generation
      || (state.cancelledAttemptId !== undefined && sameImage)
    const cachedTranslations = sameImage ? state.cachedTranslations : []
    const cachedDocumentText = sameImage ? state.cachedDocumentText : ''
    const cachedDisplayMode = sameImage ? state.cachedDisplayMode : 'overlay'
    const cachedCompletion = sameImage ? state.cachedCompletion : 'none'
    const cachedFailure = sameImage ? state.cachedFailure : undefined
    if (cancelledTranslation) {
      return {
        generation: event.generation,
        phase: cachedTranslations.length > 0 || cachedDocumentText.length > 0
          ? 'translated-hidden'
          : state.blocks.length > 0 && sameImage ? 'ready-original' : 'ocr-empty',
        image: event.image,
        blocks: sameImage ? state.blocks : [],
        translations: cachedTranslations,
        cachedTranslations,
        displayMode: cachedDisplayMode,
        cachedDisplayMode,
        documentText: cachedDocumentText,
        cachedDocumentText,
        cachedCompletion,
        cachedFailure,
        previousTranslations: [],
        rejectedGeneration: event.generation,
        announcement: '已取消翻译',
        tier: event.tier,
      }
    }
    return {
      generation: event.generation,
      phase: continuingTranslation ? 'translation-running' : 'ocr-running',
      image: event.image,
      blocks: continuingTranslation ? state.blocks : [],
      translations: sameImage ? cachedTranslations : [],
      cachedTranslations,
      displayMode: continuingTranslation ? state.displayMode : 'overlay',
      cachedDisplayMode,
      documentText: '',
      cachedDocumentText,
      cachedCompletion,
      cachedFailure,
      previousTranslations: continuingTranslation ? state.previousTranslations : [],
      activeAttemptId: continuingTranslation ? state.activeAttemptId : undefined,
      announcement: continuingTranslation ? '正在翻译…' : '识别文字中…',
      tier: event.tier,
    }
  }
  if (event.generation !== state.generation) return state
  if (state.rejectedGeneration === event.generation) return state
  if (event.type === 'ocr-started') {
    return { ...state, phase: 'ocr-running', failure: undefined, announcement: '识别文字中…' }
  }
  if (event.type === 'ocr-completed') {
    const continuingTranslation = state.activeAttemptId !== undefined
    return {
      ...state,
      blocks: event.blocks,
      displayMode: 'overlay',
      phase: continuingTranslation
        ? 'translation-running'
        : event.blocks.length === 0 ? 'ocr-empty' : 'ready-original',
      failure: undefined,
      announcement: continuingTranslation
        ? '正在翻译…'
        : event.blocks.length === 0 ? '未识别到文字' : '文字识别完成',
    }
  }
  if (event.type === 'translation-started') {
    return {
      ...state,
      phase: 'translation-running',
      failure: undefined,
      activeAttemptId: undefined,
      announcement: '正在翻译…',
    }
  }
  if (event.type === 'translation-completed') {
    return {
      ...state,
      phase: 'translated',
      displayMode: 'overlay',
      previousTranslations: state.cachedTranslations,
      translations: event.translations,
      cachedTranslations: event.translations,
      cachedDisplayMode: 'overlay',
      documentText: '',
      cachedDocumentText: '',
      cachedCompletion: 'complete',
      cachedFailure: undefined,
      failure: undefined,
      activeAttemptId: undefined,
      announcement: '翻译完成',
    }
  }
  if (event.type === 'document-translation-progress') {
    return {
      ...state,
      phase: 'translation-running',
      displayMode: 'document',
      translations: [],
      documentText: event.text,
      failure: undefined,
      activeAttemptId: undefined,
      announcement: '正在翻译…',
    }
  }
  if (event.type === 'document-translation-completed') {
    return {
      ...state,
      phase: 'translated',
      displayMode: 'document',
      translations: [],
      cachedTranslations: [],
      cachedDisplayMode: 'document',
      documentText: event.text,
      cachedDocumentText: event.text,
      cachedCompletion: 'complete',
      cachedFailure: undefined,
      failure: undefined,
      activeAttemptId: undefined,
      announcement: '翻译完成',
    }
  }
  if (event.type === 'translation-cancelled') {
    const hasCachedTranslation = state.cachedTranslations.length > 0 || state.cachedDocumentText.length > 0
    return {
      ...state,
      phase: hasCachedTranslation
        ? 'translated-hidden'
        : state.blocks.length > 0 ? 'ready-original' : 'ocr-empty',
      translations: state.cachedTranslations,
      displayMode: state.cachedDisplayMode,
      documentText: state.cachedDocumentText,
      rejectedGeneration: event.generation,
      activeAttemptId: undefined,
      announcement: '已取消翻译',
    }
  }
  if (event.type !== 'failed') return state
  if (event.stage === 'translation') {
    const hasPartialDocument = state.displayMode === 'document' && state.documentText.length > 0
    return {
      ...state,
      phase: event.code === 'MODEL_NOT_CONFIGURED' ? 'model-unconfigured' : 'translation-failed',
      cachedDisplayMode: hasPartialDocument ? 'document' : state.cachedDisplayMode,
      cachedDocumentText: hasPartialDocument ? state.documentText : state.cachedDocumentText,
      cachedTranslations: hasPartialDocument ? [] : state.cachedTranslations,
      cachedCompletion: hasPartialDocument ? 'partial' : state.cachedCompletion,
      cachedFailure: hasPartialDocument ? event.code : state.cachedFailure,
      failure: event.code,
      activeAttemptId: undefined,
      announcement: event.code === 'MODEL_NOT_CONFIGURED'
        ? '尚未配置截图翻译使用的大模型'
        : hasPartialDocument ? '部分内容翻译未完成，可重新翻译' : failureMessage(event.code),
    }
  }
  return {
    ...state,
    phase: 'ocr-empty',
    blocks: [],
    translations: [],
    documentText: '',
    previousTranslations: [],
    failure: event.code,
    activeAttemptId: undefined,
    announcement: failureMessage(event.code),
  }
}

function failureMessage(code: ScreenshotPublicErrorCode | undefined): string {
  switch (code) {
    case 'MODEL_TIMEOUT': return '翻译超时，请重试'
    case 'TRANSLATION_FAILED': return '翻译未能完成，请尝试将窗口拉大后重试'
    case 'MODEL_AUTHENTICATION_FAILED': return '模型认证失败，请检查 API Key 或 CLI 登录状态'
    case 'MODEL_NOT_FOUND': return '未找到所选模型，请在设置中重新选择'
    case 'MODEL_UNAVAILABLE': return '无法连接模型服务，请检查网络和服务地址后重试'
    case 'MODEL_RATE_LIMITED': return '模型请求过于频繁，请稍后重试'
    case 'MODEL_QUOTA_EXCEEDED': return '模型额度不足，请检查账户额度或更换模型'
    case 'MODEL_RESPONSE_INVALID': return '模型返回的译文不完整或格式不正确，请重新翻译'
    case 'OCR_LANGUAGE_UNAVAILABLE': return '系统未提供可用的文字识别语言'
    case 'OCR_TIMEOUT': return '文字识别超时'
    case 'OCR_UNAVAILABLE':
    case 'OCR_FAILED': return '文字识别未能完成'
    case 'CAPTURE_UNAVAILABLE':
    case 'CAPTURE_EMPTY': return '无法显示该截图'
    default: return ''
  }
}

function safeGeneration(generation: number): number {
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 1
}

interface MeasuredTranslationBlockProps {
  block: NonNullable<ReturnType<typeof computeScreenshotOverlayLayout>>['blocks'][number]
}

// OCR rectangles shrink with the image. A readability floor must never remove
// their translations; enlarging the window will remeasure at a larger size.
// Subpixel font sizes can have zero-height glyphs in Chromium. Keep at least
// one CSS pixel, and paint overflow if the source rectangle is smaller still.
const MIN_MEASURED_FONT_SIZE = 1
const MAX_MEASUREMENT_PROBES = 18
const MEASUREMENT_PRECISION = 0.25

interface TranslationMeasurement {
  phase: 'measuring' | 'fit' | 'unfit'
  candidate: number
  probes: number
  lowerFit?: number
  upperOverflow?: number
}

function middleFontSize(lower: number, upper: number): number {
  return Math.round(((lower + upper) / 2) * 100) / 100
}

function MeasuredTranslationBlock({ block }: MeasuredTranslationBlockProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [measurement, setMeasurement] = useState<TranslationMeasurement>(() => ({
    phase: 'measuring',
    candidate: Math.max(MIN_MEASURED_FONT_SIZE, block.fontSizeCss),
    probes: 0,
  }))
  useLayoutEffect(() => {
    if (measurement.phase !== 'measuring') return
    const element = ref.current
    if (!element) return
    const overflow = element.scrollWidth > element.clientWidth + 1
      || element.scrollHeight > element.clientHeight + 1
    const probes = measurement.probes + 1

    if (!overflow) {
      const lowerFit = Math.max(measurement.lowerFit ?? MIN_MEASURED_FONT_SIZE, measurement.candidate)
      const upperOverflow = measurement.upperOverflow
      if (upperOverflow === undefined
        || upperOverflow - lowerFit <= MEASUREMENT_PRECISION
        || probes >= MAX_MEASUREMENT_PROBES) {
        setMeasurement({ phase: 'fit', candidate: lowerFit, probes })
        return
      }
      setMeasurement({
        phase: 'measuring',
        candidate: middleFontSize(lowerFit, upperOverflow),
        probes,
        lowerFit,
        upperOverflow,
      })
      return
    }

    const upperOverflow = Math.min(measurement.upperOverflow ?? measurement.candidate, measurement.candidate)
    if (measurement.candidate <= MIN_MEASURED_FONT_SIZE
      || probes >= MAX_MEASUREMENT_PROBES) {
      setMeasurement(measurement.lowerFit === undefined
        ? { phase: 'unfit', candidate: MIN_MEASURED_FONT_SIZE, probes }
        : { phase: 'fit', candidate: measurement.lowerFit, probes })
      return
    }
    if (measurement.lowerFit === undefined) {
      setMeasurement({
        phase: 'measuring',
        candidate: MIN_MEASURED_FONT_SIZE,
        probes,
        upperOverflow,
      })
      return
    }
    if (upperOverflow - measurement.lowerFit <= MEASUREMENT_PRECISION) {
      setMeasurement({ phase: 'fit', candidate: measurement.lowerFit, probes })
      return
    }
    setMeasurement({
      phase: 'measuring',
      candidate: middleFontSize(measurement.lowerFit, upperOverflow),
      probes,
      lowerFit: measurement.lowerFit,
      upperOverflow,
    })
  }, [measurement])

  const verified = measurement.phase !== 'measuring'
  const measuredFit = measurement.phase === 'unfit' ? 'unfit'
    : measurement.candidate < block.fontSizeCss || block.fit === 'unfit'
    ? 'shrunk'
    : block.fit
  return (
    <div
      aria-hidden={!verified}
      className={`screenshot-translated-block${verified ? '' : ' is-measuring'}`}
      data-block-id={block.id}
      data-fit={measuredFit}
      ref={ref}
      style={{
        left: block.rectCss.x,
        top: block.rectCss.y,
        width: block.rectCss.width,
        height: block.rectCss.height,
        fontSize: measurement.candidate,
        userSelect: 'text',
      }}
    >{block.text}</div>
  )
}

export function ScreenshotTranslationWindow({ sessionId }: { sessionId: string }) {
  const [state, dispatch] = useReducer(resultReducer, INITIAL_STATE)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [persistence] = useState(() => createPreferencePersistence())
  const [modelPreferences] = useState(() => new ModelPreferenceDraft(persistence))
  const preparedClose = useRef<ClosePreparationAttempt | null>(null)
  const [closePrepared, setClosePrepared] = useState(false)
  useEffect(() => {
    const unsubscribe = window.arkdown.onPrepareCloseStructured?.(async context => {
      preparedClose.current = context
      setClosePrepared(true)
      context.enter('settle-preferences')
      const outcome = await persistence.drain()
      if (preparedClose.current !== context) return { status: 'cancelled' }
      return outcome.ok ? { status: 'ready' } : { status: 'failed', code: 'preferences-save-failed' }
    }) ?? (() => {})
    const release = window.arkdown.onClosePreparationReleased?.(attempt => {
      if (preparedClose.current?.attemptId !== attempt.attemptId || preparedClose.current.generation !== attempt.generation) return
      preparedClose.current = null
      setClosePrepared(false)
    }) ?? (() => {})
    return () => { unsubscribe(); release(); preparedClose.current = null }
  }, [persistence])
  const [modelSettings, setModelSettings] = useState<LargeModelSettings | null>(null)
  useEffect(() => modelPreferences.subscribe(() => {
    setModelSettings(modelPreferences.getSnapshot().settings ?? null)
  }), [modelPreferences])
  const modelRulesReady = useModelRulesReady()
  const [settingsPending, setSettingsPending] = useState(false)
  const settingsPendingRef = useRef(false)
  const settingsReadEpoch = useRef(0)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    const refresh = () => {
      if (settingsPendingRef.current) return
      const epoch = ++settingsReadEpoch.current
      void window.arkdown.getModelSettingsSnapshot().then((result) => {
        if (!current || epoch !== settingsReadEpoch.current) return
        if (!result.ok) throw new Error(result.error.message)
        modelPreferences.accept(result.value)
        setSettingsError(modelPreferences.getSnapshot().error)
      }).catch((error: unknown) => {
        if (current && epoch === settingsReadEpoch.current) {
          setModelSettings(modelPreferences.getSnapshot().settings ?? null)
          setSettingsError(error instanceof Error ? error.message : '无法读取截图翻译设置')
        }
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { current = false; settingsReadEpoch.current += 1; window.removeEventListener('focus', refresh) }
  }, [sessionId, modelPreferences])
  const saveThinking = async (change: Partial<ModelThinkingPreference>) => {
    if (!areModelRulesReady() || preparedClose.current) return
    if (settingsPendingRef.current || state.phase === 'translation-running') return
    const observed = modelPreferences.getSnapshot().observed
    if (!observed) return
    settingsPendingRef.current = true
    const epoch = ++settingsReadEpoch.current
    setSettingsPending(true)
    setSettingsError(null)
    try {
      const result = await modelPreferences.mutate(`feature.screenshotTranslation.${Object.keys(change)[0]}`, observed,
        original => window.arkdown.setScreenshotTranslationSettings(change, original),
        { feature: 'screenshotTranslation', patch: change })
      if (epoch !== settingsReadEpoch.current) return
      if (!result.ok) throw new Error(result.error.message)
      if (result.value.status === 'conflict') throw new Error('截图翻译设置已在其他窗口更改。你的修改仍保留，请重新加载后调整。')
    } catch (error) {
      if (epoch === settingsReadEpoch.current) setSettingsError(error instanceof Error ? error.message : '截图翻译设置保存失败')
    } finally {
      settingsPendingRef.current = false
      setSettingsPending(false)
    }
  }
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const attemptSequenceRef = useRef(0)
  const commandTokenRef = useRef<ScreenshotTranslationGenerationInput>({ sessionId, generation: 1 })
  const pendingStartRef = useRef<Promise<ScreenshotTranslationGenerationInput> | undefined>(undefined)

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Arkdown截图翻译'
    return () => { document.title = previousTitle }
  }, [])

  useEffect(() => window.arkdown.onScreenshotTranslationEvent?.((event) => {
    if (event.sessionId !== sessionId) return
    if (event.generation >= commandTokenRef.current.generation) {
      commandTokenRef.current = { sessionId, generation: event.generation }
    }
    dispatch({ type: 'event', event })
  }), [sessionId])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return undefined
    let frame = 0
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setViewportSize({ width: rect.width, height: rect.height })
    }
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    schedule()
    if (typeof ResizeObserver === 'undefined') return () => { if (frame) cancelAnimationFrame(frame) }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [sidebarOpen, state.image])

  const layout = useMemo(() => {
    if (!state.image) return undefined
    const width = viewportSize.width > 0 ? viewportSize.width : state.image.width
    const height = viewportSize.height > 0 ? viewportSize.height : state.image.height
    return computeScreenshotOverlayLayout({
      imageSizePx: state.image,
      containerRectCss: { x: 0, y: 0, width, height },
      blocks: state.blocks,
      translations: state.translations,
      devicePixelRatio: window.devicePixelRatio || 1,
    })
  }, [state.image, state.blocks, state.translations, viewportSize])

  const generationInput = { sessionId, generation: safeGeneration(state.generation) }
  const currentCommandToken = (): Promise<ScreenshotTranslationGenerationInput> => (
    pendingStartRef.current?.catch(() => commandTokenRef.current)
      ?? Promise.resolve(commandTokenRef.current)
  )
  const invokeWithCurrentToken = (
    operation: ((input: ScreenshotTranslationGenerationInput) => Promise<unknown>) | undefined,
  ): void => {
    if (!operation) return
    const pending = pendingStartRef.current
    if (pending) {
      void currentCommandToken().then((input) => operation(input)).catch(() => undefined)
    } else {
      void operation(commandTokenRef.current).catch(() => undefined)
    }
  }
  const partialTranslationVisible = state.phase === 'translation-failed'
    && state.displayMode === 'document' && state.documentText.length > 0
  const translateLabel = state.phase === 'ocr-running' || state.phase === 'boot'
    ? '识别文字中…'
    : state.phase === 'translation-running'
      ? '翻译中…'
      : state.phase === 'translated' || partialTranslationVisible ? '显示原文' : '显示译文'
  const translateDisabled = state.phase === 'boot'
    || state.phase === 'ocr-running'
    || state.phase === 'ocr-empty'
    || (!modelRulesReady && state.phase !== 'translation-running' && state.phase !== 'translated'
      && !partialTranslationVisible && state.cachedTranslations.length === 0 && state.cachedDocumentText.length === 0)
  const retranslateDisabled = translateDisabled || !modelRulesReady || state.phase === 'translation-running'
  const documentVisible = state.displayMode === 'document'
    && state.documentText.length > 0
    && (state.phase === 'translation-running'
      || state.phase === 'translated'
      || state.phase === 'translation-failed')
  const overlayVisible = state.displayMode === 'overlay' && state.phase === 'translated'
  const textMenuVersion = useMemo(() => [state.translations, state.documentText, overlayVisible, documentVisible],
    [state.translations, state.documentText, overlayVisible, documentVisible])
  const textMenu = useScreenshotTextMenu({
    scopeRef: viewportRef, contentVersion: textMenuVersion,
    getTextElements: () => [...(viewportRef.current?.querySelectorAll<HTMLElement>(
      '.screenshot-translated-block:not(.is-measuring), .screenshot-document-translation__text',
    ) ?? [])],
  })
  const extractionBlocks = useMemo(() => {
    if (documentVisible) return [{ id: 'document', text: state.documentText }]
    if (!overlayVisible) return state.blocks
    const translations = new Map(state.translations.map(({ id, text }) => [id, text]))
    return state.blocks.map((block) => ({
      ...block,
      text: translations.get(block.id) ?? block.text,
    }))
  }, [documentVisible, overlayVisible, state.blocks, state.documentText, state.translations])

  const beginTranslation = () => {
    if (!areModelRulesReady() || settingsPendingRef.current || modelPreferences.hasUnsettledFeature('screenshotTranslation')) return
    const attemptId = ++attemptSequenceRef.current
    const attemptGeneration = generationInput.generation
    dispatch({ type: 'start-local', attemptId })
    const start = window.arkdown.startScreenshotTranslation
    if (!start) {
      dispatch({ type: 'start-failed', attemptId, generation: attemptGeneration })
      return
    }
    const previousStart = pendingStartRef.current
    const requestForInput = async (
      input: ScreenshotTranslationGenerationInput,
    ): Promise<ScreenshotTranslationGenerationInput> => {
      const result = await start(input)
      if (!result.ok
        || result.value.sessionId !== sessionId
        || result.value.generation !== input.generation + 1) throw new Error('retry generation was not accepted')
      commandTokenRef.current = result.value
      dispatch({ type: 'start-accepted', attemptId, generation: result.value.generation })
      return result.value
    }
    const request = previousStart
      ? previousStart.catch(() => commandTokenRef.current).then(requestForInput)
      : requestForInput(commandTokenRef.current)
    pendingStartRef.current = request
    void request.then(undefined, () => {
      dispatch({ type: 'start-failed', attemptId, generation: attemptGeneration })
    }).finally(() => {
      if (pendingStartRef.current === request) pendingStartRef.current = undefined
    })
  }

  const activateTranslation = () => {
    if (state.phase === 'translation-running') {
      dispatch({ type: 'cancel-local' })
      invokeWithCurrentToken(window.arkdown.cancelScreenshotTranslation)
      return
    }
    if (state.phase === 'translated' || partialTranslationVisible) {
      dispatch({ type: 'hide-translations' })
      return
    }
    if (state.cachedTranslations.length > 0 || state.cachedDocumentText.length > 0) {
      dispatch({ type: 'show-translations' })
      return
    }
    if (!translateDisabled) beginTranslation()
  }

  const retranslate = () => {
    if (retranslateDisabled) return
    beginTranslation()
  }

  const fixedError = failureMessage(state.failure)
  const partialDocumentFailure = documentVisible && state.phase === 'translation-failed'

  return (
    <main className="screenshot-result-window">
      <header className="screenshot-result-titlebar">
        <span>截图翻译</span>
        <div className="screenshot-result-titlebar__controls">
          <button
            aria-label="最小化截图翻译窗口"
            onClick={() => invokeWithCurrentToken(window.arkdown.minimizeScreenshotTranslation)}
            data-tooltip="最小化"
          ><AppIcon name="minimize" size={16} /></button>
          <button
            aria-label="关闭截图翻译窗口"
            onClick={() => invokeWithCurrentToken(window.arkdown.closeScreenshotTranslation)}
            data-tooltip="关闭"
          ><AppIcon name="close" size={16} /></button>
        </div>
      </header>

      <div className="screenshot-result-content">
        <div className="screenshot-result-viewport" ref={viewportRef} tabIndex={0} aria-label="截图文字区域"
          onContextMenu={textMenu.onContextMenu} onKeyDown={textMenu.onKeyDown}>
          {state.image && (
            <img
              alt="截图原文"
              className={overlayVisible ? 'is-translated' : undefined}
              draggable={false}
              src={state.image.dataUrl}
            />
          )}
          {documentVisible && (
            <ScreenshotDocumentTranslation partial={partialDocumentFailure} text={state.documentText} />
          )}
          {overlayVisible && layout?.blocks.map((block) => {
            const measurementKey = JSON.stringify([
              state.generation,
              block.id,
              block.text,
              block.rectCss.x,
              block.rectCss.y,
              block.rectCss.width,
              block.rectCss.height,
              block.fontSizeCss,
              block.fit,
            ])
            return <MeasuredTranslationBlock
              block={block}
              key={measurementKey}
            />
          })}
          <div
            aria-label={state.phase === 'ocr-running' ? 'OCR识别状态' : undefined}
            className={`screenshot-result-status${state.phase === 'ocr-running' ? ' is-ocr-running' : ''}`}
          >
            {state.phase === 'boot' && '正在准备截图…'}
            {state.phase === 'ocr-running' && <>
              <span aria-hidden="true" className="screenshot-result-status__spinner" />
              <span>识别文字中…</span>
            </>}
            {state.phase === 'ocr-empty' && !fixedError && '未识别到文字'}
          </div>
          <div aria-atomic="true" aria-live="polite" className="screenshot-result-live" role="status">
            {state.announcement}
          </div>
          {state.phase === 'model-unconfigured' && (
            <div className="screenshot-result-guidance" role="alert">
              <p>尚未配置截图翻译使用的大模型</p>
              <p>截图和提取文字仍可在本机使用，只有识别出的文字会发送给已配置的模型。</p>
              <button onClick={() => invokeWithCurrentToken(window.arkdown.openScreenshotTranslationSettings)}>
                前往设置
              </button>
            </div>
          )}
          {fixedError && state.phase !== 'model-unconfigured' && !partialDocumentFailure && (
            <div className="screenshot-result-error" role="alert">{fixedError}</div>
          )}
        </div>
        <ScreenshotTextSidebar
          blocks={extractionBlocks}
          loading={state.phase === 'boot' || state.phase === 'ocr-running'}
          open={sidebarOpen}
          returnFocusRef={sidebarToggleRef}
        />
      </div>

      {textMenu.menu}
      <footer className="screenshot-result-toolbar">
        {settingsError && <div className="screenshot-settings-error">
          <p role="alert">{settingsError}</p>
          <button type="button" disabled={settingsPending} onClick={() => {
            void modelPreferences.reload(window.arkdown).then(() => setSettingsError(modelPreferences.getSnapshot().error))
          }}>重新加载截图翻译设置</button>
        </div>}
        <ModelThinkingControls label="截图翻译" thinkingConnection={modelSettings?.connections.find(({ id }) => id === modelSettings.screenshotTranslation.connectionId)}
          thinkingPreference={modelSettings?.screenshotTranslation} thinkingPending={settingsPending || closePrepared || state.phase === 'translation-running'}
          onThinkingChange={(change) => { void saveThinking(change) }} />
        <button
          className="screenshot-result-toolbar__translate"
          disabled={translateDisabled || (settingsPending && state.phase !== 'translation-running')}
          onClick={activateTranslation}
        >
          <AppIcon name="translate" size={18} />
          <span>{translateLabel}</span>
        </button>
        <button
          className="screenshot-result-toolbar__retranslate"
          disabled={retranslateDisabled || settingsPending}
          onClick={retranslate}
        >
          <AppIcon name="reload" size={18} />
          <span>重新翻译</span>
        </button>
        <button
          aria-expanded={sidebarOpen}
          className="screenshot-result-toolbar__extract"
          onClick={() => setSidebarOpen((open) => !open)}
          ref={sidebarToggleRef}
        >
          <AppIcon name="paragraph" size={18} />
          <span>{sidebarOpen ? '关闭侧窗' : '打开侧窗'}</span>
        </button>
      </footer>
    </main>
  )
}
