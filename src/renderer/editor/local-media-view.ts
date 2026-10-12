import {
  htmlSchema,
  imageSchema,
} from '@milkdown/kit/preset/commonmark'
import { $view } from '@milkdown/kit/utils'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { documentTypeForPath } from '../../shared/document-types'
import {
  externalAssetUrl,
  isWindowsAbsolutePath,
} from '../../shared/local-resource-path'
import {
  applyHorizontalRuleDomStyle,
  parseHorizontalRuleHtml,
} from './horizontal-rule-styles'
import { applyHorizontalRuleChangeTransaction } from './horizontal-rule-view'
import imageAlignLeftIcon from '../assets/context-menu/image-align-left.png'
import imageAlignCenterIcon from '../assets/context-menu/image-align-center.png'
import imageAlignRightIcon from '../assets/context-menu/image-align-right.png'

export type ImageAlignment = 'left' | 'center' | 'right'

export interface LocalMediaDescriptor {
  kind: 'image' | 'audio' | 'video'
  source: string
  previewSource?: string
  alt: string
  zoom: number | null
  alignment?: ImageAlignment
  width?: number
  height?: number
}

export interface CreatedLocalMediaElement {
  element: HTMLAudioElement | HTMLVideoElement
  destroy(): void
}

interface ParsedAttributes {
  src?: string
  alt?: string
  style?: string
}

const MIN_IMAGE_ZOOM = 5
const MAX_IMAGE_ZOOM = 400
const IMAGE_ALIGNMENT_ICON_VISIBLE_SIZE = 22

export function imageAlignmentIconCssSize(devicePixelRatio: number): number {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1
  return IMAGE_ALIGNMENT_ICON_VISIBLE_SIZE / scale
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }
  return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (entity, name: string) => {
    if (name[0] !== '#') return named[name.toLowerCase()] ?? entity
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

function encodeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function parseAttributes(value: string): ParsedAttributes {
  const result: ParsedAttributes = {}
  const pattern = /\b(src|alt|style)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    const name = match[1]?.toLocaleLowerCase('en-US') as keyof ParsedAttributes
    result[name] = decodeHtml(match[2] ?? match[3] ?? '')
  }
  return result
}

function zoomFromStyle(style: string | undefined): number | null {
  if (!style) return null
  const match = /(?:^|;)\s*zoom\s*:\s*(\d+(?:\.\d+)?)%\s*(?:;|$)/i.exec(style)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value)
    ? Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, value))
    : null
}
function alignmentFromStyle(style: string | undefined): ImageAlignment {
  if (!style) return 'center'
  const normalized = style.toLocaleLowerCase('en-US').replaceAll(/\s+/g, '') + ';'
  if (normalized.includes('margin-left:0;') && normalized.includes('margin-right:auto;')) {
    return 'left'
  }
  if (normalized.includes('margin-left:auto;') && normalized.includes('margin-right:0;')) {
    return 'right'
  }
  return 'center'
}

function hasOnlySupportedAttributes(
  kind: LocalMediaDescriptor['kind'],
  rawAttributes: string,
): boolean {
  const allowed = kind === 'image'
    ? new Set(['src', 'alt', 'style'])
    : new Set(['src', 'controls', 'preload', 'class'])
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null
  while ((match = attributePattern.exec(rawAttributes))) {
    const name = match[1]?.toLocaleLowerCase('en-US') ?? ''
    if (!allowed.has(name)) return false
  }
  return true
}


function expectedCategory(kind: LocalMediaDescriptor['kind']): string {
  return kind
}

function descriptorFor(
  kind: LocalMediaDescriptor['kind'],
  rawAttributes: string,
  documentAbsolutePath: string | null = null,
): LocalMediaDescriptor | null {
  if (kind === 'image') return imageDescriptorFor(rawAttributes, documentAbsolutePath)
  const attributes = parseAttributes(rawAttributes)
  const source = attributes.src ?? ''
  if (!hasOnlySupportedAttributes(kind, rawAttributes)) return null
  if (
    !isWindowsAbsolutePath(source)
    || documentTypeForPath(source)?.category !== expectedCategory(kind)
  ) return null
  return {
    kind,
    source,
    alt: attributes.alt ?? '',
    zoom: null,
  }
}

function imageDescriptorFor(raw: string, documentAbsolutePath: string | null): LocalMediaDescriptor | null {
  const attributes: Record<string, string> = {}
  const pattern = /\s+([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\d+))/giy
  let offset = 0
  while (offset < raw.length) {
    if (/^\s*\/?\s*$/.test(raw.slice(offset))) break
    pattern.lastIndex = offset
    const match = pattern.exec(raw)
    if (!match) return null
    const name = match[1].toLowerCase()
    if (!['src', 'alt', 'style', 'width', 'height'].includes(name) || name in attributes) return null
    if (match[4] !== undefined && name !== 'width' && name !== 'height') return null
    attributes[name] = decodeHtml(match[2] ?? match[3] ?? match[4])
    offset = pattern.lastIndex
  }
  const source = attributes.src ?? ''
  const previewSource = resolveRelativeMarkdownImageSource(source, documentAbsolutePath)
  if (!previewSource) return null
  const dimensions: { width?: number; height?: number } = {}
  for (const name of ['width', 'height'] as const) {
    if (attributes[name] === undefined) continue
    if (!/^\d+(?:\.\d+)?$/.test(attributes[name].trim())) return null
    const value = Number(attributes[name])
    if (value <= 0 || value > 100_000) return null
    dimensions[name] = value
  }
  for (const declaration of (attributes.style ?? '').split(';')) {
    if (!declaration.trim()) continue
    const match = /^\s*([a-z-]+)\s*:\s*([^:]+?)\s*$/i.exec(declaration)
    if (!match) return null
    const property = match[1].toLowerCase()
    const value = match[2].toLowerCase()
    if (property === 'display' && value === 'block') continue
    if ((property === 'margin-left' || property === 'margin-right') && /^(?:auto|0(?:px)?)$/.test(value)) continue
    if (property === 'zoom' && /^\d+(?:\.\d+)?%$/.test(value)) continue
    if (property === 'max-width' && value === '100%') continue
    if (property === 'width' || property === 'height') {
      if (value === 'auto') continue
      if (!/^\d+(?:\.\d+)?px$/.test(value)) return null
      const size = Number(value.slice(0, -2))
      if (size <= 0 || size > 100_000) return null
      dimensions[property] = size
      continue
    }
    return null
  }
  return { kind: 'image', source, ...(previewSource !== source ? { previewSource } : {}),
    alt: attributes.alt ?? '', zoom: zoomFromStyle(attributes.style),
    alignment: alignmentFromStyle(attributes.style), ...dimensions }
}

type DocumentPath = string | null | (() => string | null)
const currentDocumentPath = (path: DocumentPath): string | null => typeof path === 'function' ? path() : path

export function parseLocalMediaHtml(value: string, documentAbsolutePath: string | null = null): LocalMediaDescriptor | null {
  const image = /^<img\b((?:"[^"]*"|'[^']*'|[^'">])*)\/?>$/i.exec(value.trim())
  if (image?.[1]) return descriptorFor('image', image[1], documentAbsolutePath)

  const media = /^<(audio|video)\b([^>]*)>(?:<\/\1>)?$/i.exec(value.trim())
  if (!media?.[1] || media[2] === undefined) return null
  return descriptorFor(
    media[1].toLocaleLowerCase('en-US') as 'audio' | 'video',
    media[2],
  )
}

const LOCAL_RESOURCE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

export function resolveRelativeMarkdownImageSource(
  source: string,
  documentAbsolutePath: string | null,
): string | null {
  const trimmed = source.trim()
  if (/[\u0000-\u001f]/.test(trimmed)) return null
  if (isWindowsAbsolutePath(trimmed)) {
    return documentTypeForPath(trimmed)?.category === 'image' ? trimmed : null
  }
  if (/^file:/i.test(trimmed)) {
    try {
      const uri = new URL(trimmed)
      if (uri.search || uri.hash || uri.username || uri.password || /%(?:2f|5c)/i.test(uri.pathname)) return null
      const path = decodeURIComponent(uri.pathname)
      const absolute = uri.hostname && uri.hostname !== 'localhost'
        ? `\\\\${uri.hostname}${path.replaceAll('/', '\\')}`
        : path.replace(/^\/([a-z]:)/i, '$1').replaceAll('/', '\\')
      return isWindowsAbsolutePath(absolute) && !/[\u0000-\u001f]/.test(absolute)
        && documentTypeForPath(absolute)?.category === 'image' ? absolute : null
    } catch { return null }
  }
  if (!documentAbsolutePath || !isWindowsAbsolutePath(documentAbsolutePath)) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    return null
  }
  if (
    !decoded
    || /[\u0000-\u001f]/.test(decoded)
    || decoded.startsWith('/')
    || LOCAL_RESOURCE_SCHEME.test(decoded)
  ) return null

  const resolvedSegments = documentAbsolutePath.replaceAll('\\', '/').split('/')
  resolvedSegments.pop()
  for (const segment of decoded.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (resolvedSegments.length <= 1) return null
      resolvedSegments.pop()
      continue
    }
    resolvedSegments.push(segment)
  }

  const resolved = resolvedSegments.join('\\')
  return (
    isWindowsAbsolutePath(resolved)
    && documentTypeForPath(resolved)?.category === 'image'
  ) ? resolved : null
}

export function parseLocalMarkdownImage(
  attrs: Record<string, unknown>,
  documentAbsolutePath: string | null = null,
): LocalMediaDescriptor | null {
  const source = typeof attrs.src === 'string' ? attrs.src : ''
  const previewSource = resolveRelativeMarkdownImageSource(source, documentAbsolutePath)
  if (!previewSource) return null
  return {
    kind: 'image',
    source,
    ...(previewSource !== source ? { previewSource } : {}),
    alt: typeof attrs.alt === 'string' ? attrs.alt : '',
    zoom: null,
    alignment: 'center',
  }
}

export function serializeLocalImage(
  descriptor: Pick<LocalMediaDescriptor, 'source' | 'alt' | 'zoom' | 'alignment' | 'width' | 'height'>,
): string {
  const alignment = descriptor.alignment ?? 'center'
  const margins = alignment === 'left'
    ? 'margin-left:0;margin-right:auto;'
    : alignment === 'right'
      ? 'margin-left:auto;margin-right:0;'
      : 'margin-left:auto;margin-right:auto;'
  const zoom = descriptor.zoom === null
    ? ''
    : `zoom:${Number(descriptor.zoom.toFixed(1))}%;`
  const style = `${zoom}display:block;${margins}`
  const dimensions = (['width', 'height'] as const).map((name) => descriptor[name] === undefined
    ? '' : ` ${name}="${descriptor[name]}"`).join('')
  return `<img src="${encodeHtml(descriptor.source)}" alt="${encodeHtml(descriptor.alt)}"${dimensions} style="${style}" />`
}

export interface LocalImageUpdate {
  source?: string
  alt?: string
  zoom?: number | null
  alignment?: ImageAlignment
}

export function updateLocalImageDescriptor(
  current: LocalMediaDescriptor,
  update: LocalImageUpdate,
): LocalMediaDescriptor | null {
  if (current.kind !== 'image' || typeof update !== 'object' || update === null) return null
  let source = current.source
  let previewSource = current.previewSource
  if (Object.prototype.hasOwnProperty.call(update, 'source')) {
    if (
      typeof update.source !== 'string'
      || !isWindowsAbsolutePath(update.source)
      || documentTypeForPath(update.source)?.category !== 'image'
    ) return null
    source = update.source
    previewSource = undefined
  }
  let alt = current.alt
  if (Object.prototype.hasOwnProperty.call(update, 'alt')) {
    if (typeof update.alt !== 'string' || update.alt.length > 4096) return null
    alt = update.alt
  }
  let zoom = current.zoom
  if (Object.prototype.hasOwnProperty.call(update, 'zoom')) {
    if (update.zoom === null) zoom = null
    else if (typeof update.zoom === 'number' && Number.isFinite(update.zoom)) {
      zoom = Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, update.zoom))
    } else return null
  }
  let alignment = current.alignment ?? 'center'
  if (Object.prototype.hasOwnProperty.call(update, 'alignment')) {
    if (update.alignment !== 'left' && update.alignment !== 'center' && update.alignment !== 'right') {
      return null
    }
    alignment = update.alignment
  }
  return {
    ...(current.width === undefined ? {} : { width: current.width }),
    ...(current.height === undefined ? {} : { height: current.height }),
    kind: 'image',
    source,
    ...(previewSource ? { previewSource } : {}),
    alt,
    zoom,
    alignment,
  }
}

export function isLocalMediaClosingHtml(value: string): boolean {
  return value.trim() === '</audio>' || value.trim() === '</video>'
}

export function localMediaClosingMatchesOpening(
  closingValue: string,
  precedingValue: string | null,
): boolean {
  if (!isLocalMediaClosingHtml(closingValue) || !precedingValue) return false
  const preceding = parseLocalMediaHtml(precedingValue)
  return preceding?.kind === (closingValue.trim() === '</audio>' ? 'audio' : 'video')
}

export function createLocalMediaElement(
  value: string,
  ownerDocument: Document,
): CreatedLocalMediaElement | null {
  const descriptor = parseLocalMediaHtml(value)
  if (!descriptor || descriptor.kind === 'image') return null

  if (descriptor.kind === 'audio') {
    const audio = ownerDocument.createElement('audio')
    audio.className = 'arkdown-audio'
    audio.controls = true
    audio.preload = 'metadata'
    audio.setAttribute('src', externalAssetUrl(descriptor.source))
    audio.contentEditable = 'false'
    return { element: audio, destroy: () => undefined }
  }

  const video = ownerDocument.createElement('video')
  video.className = 'arkdown-video'
  video.controls = false
  video.preload = 'metadata'
  video.setAttribute('src', externalAssetUrl(descriptor.source))
  video.contentEditable = 'false'
  video.tabIndex = 0

  let hovered = false
  let focused = false
  let playing = false
  const syncControls = () => {
    video.controls = hovered || focused || playing
  }
  const onMouseEnter = () => { hovered = true; syncControls() }
  const onMouseLeave = () => { hovered = false; syncControls() }
  const onFocus = () => { focused = true; syncControls() }
  const onBlur = () => { focused = false; syncControls() }
  const onPlay = () => { playing = true; syncControls() }
  const onPause = () => { playing = false; syncControls() }
  video.addEventListener('mouseenter', onMouseEnter)
  video.addEventListener('mouseleave', onMouseLeave)
  video.addEventListener('focus', onFocus)
  video.addEventListener('blur', onBlur)
  video.addEventListener('play', onPlay)
  video.addEventListener('pause', onPause)

  return {
    element: video,
    destroy: () => {
      video.removeEventListener('mouseenter', onMouseEnter)
      video.removeEventListener('mouseleave', onMouseLeave)
      video.removeEventListener('focus', onFocus)
      video.removeEventListener('blur', onBlur)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    },
  }
}

function createImageNodeView(
  initialDescriptor: LocalMediaDescriptor,
  initialNode: ProseMirrorNode,
  view: EditorView,
  getPos: () => number | undefined,
  onMarkdownChange: () => void,
  syntax: 'html' | 'markdown',
  documentAbsolutePath: DocumentPath = null,
  interactive = true,
) {
  const ownerDocument = view.dom.ownerDocument
  const abort = new AbortController()
  const wrapper = ownerDocument.createElement('span')
  wrapper.className = 'arkdown-local-image'
  wrapper.contentEditable = 'false'

  const image = ownerDocument.createElement('img')
  image.draggable = false
  wrapper.append(image)

  const errorLabel = ownerDocument.createElement('span')
  errorLabel.className = 'arkdown-local-image-error'
  wrapper.append(errorLabel)

  let descriptor = initialDescriptor
  let currentNode = initialNode
  let currentZoom = descriptor.zoom
  const alignmentButtons = new Map<ImageAlignment, HTMLButtonElement>()

  const applyDescriptor = (next: LocalMediaDescriptor) => {
    descriptor = next
    currentZoom = next.zoom
    const previewSource = next.previewSource ?? next.source
    wrapper.dataset.source = previewSource
    const alignment = next.alignment ?? 'center'
    wrapper.dataset.alignment = alignment
    wrapper.classList.toggle('is-align-left', alignment === 'left')
    wrapper.classList.toggle('is-align-center', alignment === 'center')
    wrapper.classList.toggle('is-align-right', alignment === 'right')
    for (const [value, button] of alignmentButtons) {
      button.setAttribute('aria-pressed', String(value === alignment))
    }
    image.dataset.source = previewSource
    image.src = externalAssetUrl(previewSource)
    image.alt = next.alt
    for (const name of ['width', 'height'] as const) {
      if (next[name] === undefined) {
        image.removeAttribute(name)
        image.style.removeProperty(name)
      } else {
        image.setAttribute(name, String(next[name]))
        image.style.setProperty(name, `${next[name]}px`)
      }
    }
    errorLabel.textContent = `无法预览：${next.alt || next.source}`
    wrapper.classList.toggle('is-adaptive', next.zoom === null)
    wrapper.classList.remove('is-preview-error')
    if (next.zoom === null) image.style.removeProperty('zoom')
    else image.style.setProperty('zoom', `${next.zoom}%`)
  }

  const commitDescriptor = (next: LocalMediaDescriptor) => {
    const position = getPos()
    if (typeof position !== 'number') return
    const actual = view.state.doc.nodeAt(position)
    if (!actual || actual.type !== currentNode.type) return
    const value = serializeLocalImage(next)
    if (syntax === 'markdown') {
      if (next.zoom !== null || (next.alignment ?? 'center') !== 'center') {
        const html = view.state.schema.nodes.html?.create({ value })
        if (!html) return
        view.dispatch(view.state.tr.replaceWith(
          position,
          position + actual.nodeSize,
          html,
        ))
      } else {
        view.dispatch(view.state.tr.setNodeMarkup(position, undefined, {
          ...actual.attrs,
          src: next.source,
          alt: next.alt,
          title: next.alt,
        }))
      }
      applyDescriptor(next)
      queueMicrotask(onMarkdownChange)
      return
    }
    currentNode = actual
    applyDescriptor(next)
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, {
      ...actual.attrs,
      value,
    }))
    queueMicrotask(onMarkdownChange)
  }

  const commitZoom = (zoom: number | null) => {
    const next = updateLocalImageDescriptor(descriptor, { zoom })
    if (next) commitDescriptor(next)
  }

  const commitAlignment = (alignment: ImageAlignment) => {
    const next = updateLocalImageDescriptor(descriptor, { alignment })
    if (next) commitDescriptor(next)
  }

  const alignmentToolbar = ownerDocument.createElement('span')
  alignmentToolbar.className = 'arkdown-image-alignment-toolbar'
  alignmentToolbar.setAttribute('role', 'toolbar')
  alignmentToolbar.setAttribute('aria-label', '图片对齐方式')
  const alignmentOptions = [
    ['left', '左对齐', imageAlignLeftIcon],
    ['center', '居中对齐', imageAlignCenterIcon],
    ['right', '右对齐', imageAlignRightIcon],
  ] as const
  for (const [alignment, label, iconSource] of alignmentOptions) {
    const button = ownerDocument.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', label)
    button.dataset.tooltip = label
    const iconImage = ownerDocument.createElement('img')
    iconImage.alt = ''
    iconImage.draggable = false
    iconImage.src = iconSource
    const iconCssSize = imageAlignmentIconCssSize(
      ownerDocument.defaultView?.devicePixelRatio ?? 1,
    )
    iconImage.style.width = `${iconCssSize}px`
    iconImage.style.height = `${iconCssSize}px`
    button.append(iconImage)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      commitAlignment(alignment)
    }, { signal: abort.signal })
    alignmentButtons.set(alignment, button)
    alignmentToolbar.append(button)
  }
  wrapper.append(alignmentToolbar)

  wrapper.addEventListener('arkdown:image-update', (event) => {
    const detail = (event as CustomEvent<unknown>).detail
    if (typeof detail !== 'object' || detail === null) return
    const candidate = detail as Record<string, unknown>
    const update: LocalImageUpdate = {}
    if (Object.prototype.hasOwnProperty.call(candidate, 'source')) {
      update.source = candidate.source as string
    }
    if (Object.prototype.hasOwnProperty.call(candidate, 'alt')) {
      update.alt = candidate.alt as string
    }
    if (Object.prototype.hasOwnProperty.call(candidate, 'zoom')) {
      update.zoom = candidate.zoom as number | null
    }
    if (Object.prototype.hasOwnProperty.call(candidate, 'alignment')) {
      update.alignment = candidate.alignment as ImageAlignment
    }
    const next = updateLocalImageDescriptor(descriptor, update)
    if (next) commitDescriptor(next)
  }, { signal: abort.signal })

  image.addEventListener('error', () => {
    wrapper.classList.add('is-preview-error')
  }, { signal: abort.signal })
  image.addEventListener('load', () => {
    wrapper.classList.remove('is-preview-error')
  }, { signal: abort.signal })

  const corners = [
    ['north-west', -1],
    ['north-east', 1],
    ['south-west', -1],
    ['south-east', 1],
  ] as const

  for (const [corner, direction] of corners) {
    const handle = ownerDocument.createElement('button')
    handle.type = 'button'
    handle.className = `arkdown-image-resize-handle is-${corner}`
    handle.setAttribute('aria-label', '按比例缩放图片')
    wrapper.append(handle)
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const startWidth = Math.max(1, image.getBoundingClientRect().width)
      const startZoom = currentZoom ?? 100
      const startX = event.clientX
      let pendingZoom = startZoom
      handle.setPointerCapture(event.pointerId)

      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return
        const targetWidth = Math.max(1, startWidth + ((moveEvent.clientX - startX) * direction))
        pendingZoom = Math.min(
          MAX_IMAGE_ZOOM,
          Math.max(MIN_IMAGE_ZOOM, startZoom * targetWidth / startWidth),
        )
        image.style.setProperty('zoom', `${pendingZoom}%`)
        wrapper.classList.remove('is-adaptive')
      }
      const finish = (finishEvent: PointerEvent) => {
        if (finishEvent.pointerId !== event.pointerId) return
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', finish)
        handle.removeEventListener('pointercancel', finish)
        commitZoom(Number(pendingZoom.toFixed(1)))
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', finish)
      handle.addEventListener('pointercancel', finish)
    }, { signal: abort.signal })
  }

  if (!interactive) {
    alignmentToolbar.remove()
    wrapper.querySelectorAll('.arkdown-image-resize-handle').forEach((handle) => handle.remove())
  }

  applyDescriptor(initialDescriptor)

  return {
    dom: wrapper,
    update: (nextNode: typeof initialNode) => {
      if (nextNode.type !== initialNode.type) return false
      const next = syntax === 'html'
        ? parseLocalMediaHtml(typeof nextNode.attrs.value === 'string' ? nextNode.attrs.value : '', currentDocumentPath(documentAbsolutePath))
        : parseLocalMarkdownImage(nextNode.attrs, currentDocumentPath(documentAbsolutePath))
      if (!next || next.kind !== 'image') return false
      currentNode = nextNode
      applyDescriptor(next)
      return true
    },
    destroy: () => {
      abort.abort()
    },
  }
}

export function createLocalMediaHtmlView(
  onMarkdownChange: () => void = () => undefined,
  interactive = true,
  documentAbsolutePath: DocumentPath = null,
) {
  return $view(htmlSchema.node, () => (node, view, getPos) => {
    const value = typeof node.attrs.value === 'string' ? node.attrs.value : ''
    const horizontalRuleStyle = parseHorizontalRuleHtml(value)
    if (horizontalRuleStyle) {
      const horizontalRule = view.dom.ownerDocument.createElement('hr')
      horizontalRule.contentEditable = 'false'
      horizontalRule.dataset.arkdownStyle = horizontalRuleStyle.id

      applyHorizontalRuleDomStyle(horizontalRule, horizontalRuleStyle.id)
      const commitChange = (event: Event) => (
        applyHorizontalRuleChangeTransaction(event, view, getPos)
      )
      horizontalRule.addEventListener('arkdown:horizontal-rule-change', commitChange)

      return {
        dom: horizontalRule,
        update: (nextNode: typeof node) => {
          if (nextNode.type !== node.type) return false
          const nextValue = typeof nextNode.attrs.value === 'string' ? nextNode.attrs.value : ''
          const nextStyle = parseHorizontalRuleHtml(nextValue)
          if (!nextStyle) return false
          horizontalRule.dataset.arkdownStyle = nextStyle.id
          applyHorizontalRuleDomStyle(horizontalRule, nextStyle.id)
          return true
        },
        destroy: () => {
          horizontalRule.removeEventListener('arkdown:horizontal-rule-change', commitChange)
        },
      }
    }
    const descriptor = parseLocalMediaHtml(value, currentDocumentPath(documentAbsolutePath))
    if (descriptor?.kind === 'image') {
      return createImageNodeView(
        descriptor,
        node,
        view,
        getPos,
        onMarkdownChange,
        'html',
        documentAbsolutePath,
        interactive,
      )
    }

    const created = createLocalMediaElement(value, view.dom.ownerDocument)
    if (created) return { dom: created.element, destroy: created.destroy }

    if (isLocalMediaClosingHtml(value)) {
      const position = getPos()
      const preceding = position == null ? null : view.state.doc.resolve(position).nodeBefore
      const precedingValue = preceding?.type.name === 'html' && typeof preceding.attrs.value === 'string'
        ? preceding.attrs.value
        : null
      if (localMediaClosingMatchesOpening(value, precedingValue)) {
        const closing = view.dom.ownerDocument.createElement('span')
        closing.dataset.type = 'local-media-closing'
        closing.dataset.value = value
        closing.hidden = true
        closing.textContent = value
        return { dom: closing }
      }
    }

    const span = view.dom.ownerDocument.createElement('span')
    span.dataset.type = 'html'
    span.dataset.value = value
    span.textContent = value
    return { dom: span }
  })
}

export function createLocalMarkdownImageView(
  onMarkdownChange: () => void = () => undefined,
  documentAbsolutePath: DocumentPath = null,
  interactive = true,
) {
  return $view(imageSchema.node, () => (node, view, getPos) => {
    const descriptor = parseLocalMarkdownImage(node.attrs, currentDocumentPath(documentAbsolutePath))
    if (descriptor) {
      return createImageNodeView(
        descriptor,
        node,
        view,
        getPos,
        onMarkdownChange,
        'markdown',
        documentAbsolutePath,
        interactive,
      )
    }

    const image = view.dom.ownerDocument.createElement('img')
    const apply = (nextNode: typeof node) => {
      image.src = typeof nextNode.attrs.src === 'string' ? nextNode.attrs.src : ''
      image.alt = typeof nextNode.attrs.alt === 'string' ? nextNode.attrs.alt : ''
      image.dataset.tooltip = typeof nextNode.attrs.title === 'string' ? nextNode.attrs.title : ''
    }
    apply(node)
    return {
      dom: image,
      update: (nextNode) => {
        if (nextNode.type !== node.type || parseLocalMarkdownImage(nextNode.attrs, currentDocumentPath(documentAbsolutePath))) {
          return false
        }
        apply(nextNode)
        return true
      },
    }
  })
}

export const localMediaHtmlView = createLocalMediaHtmlView()
export const localMarkdownImageView = createLocalMarkdownImageView()
