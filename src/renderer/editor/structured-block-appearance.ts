const DARK_SURFACE = { red: 23, green: 25, blue: 26 }
const MIN_TEXT_CONTRAST = 4.5
const PICKER_VIEWPORT_INSET = 8
const PICKER_MAX_INLINE_SIZE = '--arkdown-language-picker-max-inline-size'
const PICKER_MAX_BLOCK_SIZE = '--arkdown-language-picker-max-block-size'
const REQUEST_CODE_EXPLANATION_EVENT = 'arkdown:request-code-explanation'

type RgbColor = typeof DARK_SURFACE & { alpha?: number }
type StructuredBlockMode = 'theme' | 'dark'

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function parseCssColor(value: string): RgbColor | null {
  const hex = /^#([\da-f]{6})$/iu.exec(value.trim())
  if (hex) {
    const numeric = Number.parseInt(hex[1]!, 16)
    return {
      red: numeric >> 16,
      green: (numeric >> 8) & 0xff,
      blue: numeric & 0xff,
    }
  }
  if (!/^rgba?\(/iu.test(value.trim())) return null
  const values = value.match(/[\d.]+/gu)?.map(Number)
  const channels = values?.slice(0, 3)
  if (!channels || channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    return null
  }
  return {
    red: clampChannel(channels[0]!),
    green: clampChannel(channels[1]!),
    blue: clampChannel(channels[2]!),
    alpha: values?.[3] === undefined ? 1 : Math.max(0, Math.min(1, values[3]!)),
  }
}

function formatRgb(color: RgbColor): string {
  return `rgb(${color.red}, ${color.green}, ${color.blue})`
}

function linearChannel(value: number): number {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function luminance(color: RgbColor): number {
  return 0.2126 * linearChannel(color.red)
    + 0.7152 * linearChannel(color.green)
    + 0.0722 * linearChannel(color.blue)
}

function contrastRatio(first: RgbColor, second: RgbColor): number {
  const brightest = Math.max(luminance(first), luminance(second))
  const darkest = Math.min(luminance(first), luminance(second))
  return (brightest + 0.05) / (darkest + 0.05)
}

function mixWithWhite(color: RgbColor, ratio: number): RgbColor {
  return {
    red: clampChannel(color.red + (255 - color.red) * ratio),
    green: clampChannel(color.green + (255 - color.green) * ratio),
    blue: clampChannel(color.blue + (255 - color.blue) * ratio),
  }
}

function compositeColor(foreground: RgbColor, background: RgbColor): RgbColor {
  const alpha = foreground.alpha ?? 1
  return {
    red: clampChannel(foreground.red * alpha + background.red * (1 - alpha)),
    green: clampChannel(foreground.green * alpha + background.green * (1 - alpha)),
    blue: clampChannel(foreground.blue * alpha + background.blue * (1 - alpha)),
    alpha: 1,
  }
}

function opaqueBackgroundFor(element: HTMLElement): RgbColor {
  const ancestry: HTMLElement[] = []
  let current: HTMLElement | null = element
  while (current) {
    ancestry.unshift(current)
    current = current.parentElement
  }
  return ancestry.reduce<RgbColor>((background, item) => {
    const color = parseCssColor(getComputedStyle(item).backgroundColor)
    return color ? compositeColor(color, background) : background
  }, { red: 255, green: 255, blue: 255, alpha: 1 })
}

export function adjustedColorForDarkSurface(value: string): string {
  const color = parseCssColor(value)
  if (!color) return 'rgb(232, 235, 238)'
  if (contrastRatio(color, DARK_SURFACE) >= MIN_TEXT_CONTRAST) return formatRgb(color)

  let low = 0
  let high = 1
  for (let index = 0; index < 12; index += 1) {
    const candidate = (low + high) / 2
    if (contrastRatio(mixWithWhite(color, candidate), DARK_SURFACE) >= MIN_TEXT_CONTRAST) {
      high = candidate
    } else {
      low = candidate
    }
  }
  return formatRgb(mixWithWhite(color, high))
}

function syntaxColorElements(block: HTMLElement): HTMLElement[] {
  return Array.from(block.querySelectorAll<HTMLElement>('.cm-content, .cm-line span'))
}

function clearAdjustedTokenColors(block: HTMLElement): void {
  for (const element of syntaxColorElements(block)) {
    element.removeAttribute('data-arkdown-dark-token')
    element.style.removeProperty('--arkdown-dark-token-color')
  }
}

export function shouldUseDarkStructuredBlockMode(block: HTMLElement): boolean {
  if (block.closest('.editor-content [data-editor-theme="dark"]')) return true
  const background = opaqueBackgroundFor(block)
  return syntaxColorElements(block).some((element) => {
    const parsed = parseCssColor(getComputedStyle(element).color)
    const color = parsed ? compositeColor(parsed, background) : null
    return Boolean(color && luminance(color) >= 0.72 && contrastRatio(color, background) < 3)
  })
}

function paletteIcon(document: Document): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', '0 0 256 256')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('d', 'M200.77 53.89A103.27 103.27 0 0 0 128 24h-1.07A104 104 0 0 0 24 128c0 43 26.58 79.06 69.36 94.17A32 32 0 0 0 136 192a16 16 0 0 1 16-16h46.21a31.81 31.81 0 0 0 31.2-24.88 104.43 104.43 0 0 0 2.59-24A103.28 103.28 0 0 0 200.77 53.89Zm13 93.71A15.89 15.89 0 0 1 198.21 160H152a32 32 0 0 0-32 32 16 16 0 0 1-21.31 15.07C62.49 194.3 40 164 40 128a88 88 0 0 1 87.09-88h.9a88.35 88.35 0 0 1 88 87.25 88.86 88.86 0 0 1-2.18 20.35ZM140 76a12 12 0 1 1-12-12 12 12 0 0 1 12 12Zm-44 24a12 12 0 1 1-12-12 12 12 0 0 1 12 12Zm0 56a12 12 0 1 1-12-12 12 12 0 0 1 12 12Zm88-56a12 12 0 1 1-12-12 12 12 0 0 1 12 12Z')
  svg.append(path)
  return svg
}

function mermaidConvertIcon(document: Document): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(namespace, 'path')
  path.setAttribute('d', 'M16 13.25C13.9 9.6 10.75 10.4 7 8.9C4.65 8 3.15 6.5 2.25 4.5C1.75 10.15 4.25 14.75 9.65 17.65C12.65 19.25 14.15 21.4 13.65 25.65Q16 26.75 18.35 25.65C17.85 21.4 19.35 19.25 22.35 17.65C27.75 14.75 30.25 10.15 29.75 4.5C28.85 6.5 27.35 8 25 8.9C21.25 10.4 18.1 9.6 16 13.25Z')
  path.setAttribute('stroke-width', '1.75')
  svg.append(path)
  return svg
}

function codeExplanationIcon(document: Document): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('width', '24')
  svg.setAttribute('height', '24')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const bubble = document.createElementNS(namespace, 'path')
  bubble.setAttribute('d', 'M8 10h8M8 14h5m6-10H5a2 2 0 0 0-2 2v15l4-3h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z')
  svg.append(bubble)
  return svg
}

function isReliablyReadOnly(root: HTMLElement): boolean {
  if (root.closest('[contenteditable="false"]')) return true
  const editor = root.matches('.ProseMirror[contenteditable]')
    ? root
    : root.querySelector<HTMLElement>('.ProseMirror[contenteditable]')
  return editor?.getAttribute('contenteditable') === 'false'
}

function setMode(block: HTMLElement, button: HTMLButtonElement, mode: StructuredBlockMode): void {
  clearAdjustedTokenColors(block)
  block.dataset.arkdownColorMode = mode
  const nextMode = mode === 'dark' ? '主题色' : '深色'
  const label = `切换为${nextMode}模式`
  button.setAttribute('aria-label', label)
  button.dataset.tooltip = label
  button.setAttribute('aria-pressed', String(mode === 'dark'))
  if (mode === 'dark') {
    for (const element of syntaxColorElements(block)) {
      element.style.setProperty(
        '--arkdown-dark-token-color',
        adjustedColorForDarkSurface(getComputedStyle(element).color),
      )
      element.setAttribute('data-arkdown-dark-token', '')
    }
  }
}

function editorScrollBoundary(root: HTMLElement, hostWindow: Window): HTMLElement | null {
  let current = root.parentElement
  while (current) {
    const style = hostWindow.getComputedStyle(current)
    if ([style.overflowX, style.overflowY].some((value) => value === 'auto' || value === 'scroll')) {
      return current
    }
    current = current.parentElement
  }
  return null
}

function scrollPortRect(element: HTMLElement): Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'> {
  const rect = element.getBoundingClientRect()
  const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1
  const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1
  const left = rect.left + element.clientLeft * scaleX
  const top = rect.top + element.clientTop * scaleY
  return {
    left,
    top,
    right: left + element.clientWidth * scaleX,
    bottom: top + element.clientHeight * scaleY,
  }
}

function clearPickerConstraints(picker: HTMLElement): void {
  picker.style.removeProperty('translate')
  picker.style.removeProperty(PICKER_MAX_INLINE_SIZE)
  picker.style.removeProperty(PICKER_MAX_BLOCK_SIZE)
}

export function installStructuredBlockAppearance(root: HTMLElement): () => void {
  const manualModes = new WeakMap<HTMLElement, StructuredBlockMode>()
  const hostWindow = root.ownerDocument.defaultView
  const scrollBoundary = hostWindow ? editorScrollBoundary(root, hostWindow) : null
  let disposed = false
  let refreshPending = false
  let boundsFrame = 0

  const constrainLanguagePickers = () => {
    boundsFrame = 0
    if (disposed || !hostWindow) return
    const scrollRect = scrollBoundary ? scrollPortRect(scrollBoundary) : null
    const minLeft = Math.max(PICKER_VIEWPORT_INSET, scrollRect?.left ?? 0)
    const maxRight = Math.min(
      hostWindow.innerWidth - PICKER_VIEWPORT_INSET,
      scrollRect?.right ?? hostWindow.innerWidth,
    )
    const minTop = Math.max(PICKER_VIEWPORT_INSET, scrollRect?.top ?? 0)
    const maxBottom = Math.min(
      hostWindow.innerHeight - PICKER_VIEWPORT_INSET,
      scrollRect?.bottom ?? hostWindow.innerHeight,
    )
    const availableInlineSize = Math.max(0, maxRight - minLeft)
    const availableBlockSize = Math.max(0, maxBottom - minTop)
    for (const picker of root.querySelectorAll<HTMLElement>('.language-picker')) {
      clearPickerConstraints(picker)
      const block = picker.closest<HTMLElement>('.milkdown-code-block')
      if (block?.dataset.arkdownFrontmatter === 'true' || !picker.querySelector('.list-wrapper')) {
        continue
      }
      const pickerStyle = hostWindow.getComputedStyle(picker)
      const verticalPadding = Number.parseFloat(pickerStyle.paddingBlockStart || '0')
        + Number.parseFloat(pickerStyle.paddingBlockEnd || '0')
      picker.style.setProperty(PICKER_MAX_INLINE_SIZE, `${availableInlineSize}px`)
      picker.style.setProperty(
        PICKER_MAX_BLOCK_SIZE,
        `${Math.max(0, availableBlockSize - verticalPadding)}px`,
      )
      const rect = picker.getBoundingClientRect()
      let horizontal = rect.right > maxRight ? maxRight - rect.right : 0
      if (rect.left + horizontal < minLeft) horizontal += minLeft - (rect.left + horizontal)
      let vertical = rect.bottom > maxBottom ? maxBottom - rect.bottom : 0
      if (rect.top + vertical < minTop) vertical += minTop - (rect.top + vertical)
      if (horizontal || vertical) picker.style.translate = `${horizontal}px ${vertical}px`
    }
  }
  const schedulePickerBounds = () => {
    if (disposed || !hostWindow) return
    if (boundsFrame) hostWindow.cancelAnimationFrame(boundsFrame)
    boundsFrame = hostWindow.requestAnimationFrame(constrainLanguagePickers)
  }

  const refresh = () => {
    refreshPending = false
    if (disposed) return
    for (const block of root.querySelectorAll<HTMLElement>('.milkdown-code-block')) {
      const group = block.querySelector<HTMLElement>('.tools-button-group')
      if (!group) continue
      if (block.dataset.arkdownFrontmatter === 'true') {
        clearAdjustedTokenColors(block)
        delete block.dataset.arkdownColorMode
        group.querySelector('.arkdown-block-theme-toggle')?.remove()
        block.querySelector('.arkdown-mermaid-convert-button')?.remove()
        block.querySelector('.arkdown-code-explanation-button')?.remove()
        continue
      }
      let button = group.querySelector<HTMLButtonElement>('.arkdown-block-theme-toggle')
      if (!button) {
        button = root.ownerDocument.createElement('button')
        button.type = 'button'
        button.className = 'arkdown-block-theme-toggle'
        button.append(paletteIcon(root.ownerDocument))
        button.addEventListener('click', () => {
          const current = block.dataset.arkdownColorMode === 'dark' ? 'dark' : 'theme'
          const next = current === 'dark' ? 'theme' : 'dark'
          manualModes.set(block, next)
          setMode(block, button!, next)
        })
        group.prepend(button)
      }

      let convertButton = block.querySelector<HTMLButtonElement>('.arkdown-mermaid-convert-button')
      let explanationButton = block.querySelector<HTMLButtonElement>('.arkdown-code-explanation-button')
      if (isReliablyReadOnly(root)) {
        convertButton?.remove()
        explanationButton?.remove()
      } else if (!convertButton) {
        convertButton = root.ownerDocument.createElement('button')
        convertButton.type = 'button'
        convertButton.className = 'arkdown-mermaid-convert-button'
        convertButton.setAttribute('aria-label', '将此代码块转换为 Mermaid 图形')
        convertButton.dataset.tooltip = '将此代码块转换为 Mermaid 图形'
        convertButton.append(mermaidConvertIcon(root.ownerDocument))
        convertButton.addEventListener('click', () => {
          convertButton!.dispatchEvent(new CustomEvent('arkdown:convert-code-block-to-mermaid', {
            bubbles: true,
          }))
        })
        const languageButton = block.querySelector<HTMLElement>('.language-button')
        languageButton?.insertAdjacentElement('afterend', convertButton)
      }
      if (!isReliablyReadOnly(root)) {
        if (!explanationButton) {
          explanationButton = root.ownerDocument.createElement('button')
          explanationButton.type = 'button'
          explanationButton.className = 'arkdown-code-explanation-button'
          explanationButton.setAttribute('aria-label', '使用 AI 解读此代码块')
          explanationButton.dataset.tooltip = '使用 AI 解读此代码块'
          explanationButton.append(codeExplanationIcon(root.ownerDocument))
          explanationButton.addEventListener('click', () => {
            explanationButton!.dispatchEvent(new CustomEvent(REQUEST_CODE_EXPLANATION_EVENT, {
              bubbles: true,
            }))
          })
        }
        const languageButton = block.querySelector<HTMLElement>('.language-button')
        const anchor = convertButton ?? languageButton
        if (anchor && anchor.nextElementSibling !== explanationButton) {
          anchor.insertAdjacentElement('afterend', explanationButton)
        }
      }

      const manualMode = manualModes.get(block)
      if (manualMode) {
        setMode(block, button, manualMode)
        continue
      }
      block.dataset.arkdownColorMode = 'theme'
      clearAdjustedTokenColors(block)
      setMode(block, button, shouldUseDarkStructuredBlockMode(block) ? 'dark' : 'theme')
    }
    schedulePickerBounds()
  }
  const scheduleRefresh = () => {
    if (refreshPending || disposed) return
    refreshPending = true
    queueMicrotask(refresh)
  }
  const observer = new MutationObserver(scheduleRefresh)
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'data-arkdown-frontmatter', 'data-editor-theme'],
  })
  const themeHost = root.closest('[data-editor-theme]')
  if (themeHost && themeHost !== root) observer.observe(themeHost, { attributes: true, attributeFilter: ['data-editor-theme'] })
  hostWindow?.addEventListener('resize', schedulePickerBounds)
  hostWindow?.addEventListener('scroll', schedulePickerBounds, true)
  const boundaryResizeObserver = hostWindow?.ResizeObserver && scrollBoundary
    ? new hostWindow.ResizeObserver(schedulePickerBounds)
    : null
  if (boundaryResizeObserver && scrollBoundary) boundaryResizeObserver.observe(scrollBoundary)
  refresh()

  return () => {
    disposed = true
    observer.disconnect()
    if (boundsFrame && hostWindow) hostWindow.cancelAnimationFrame(boundsFrame)
    hostWindow?.removeEventListener('resize', schedulePickerBounds)
    hostWindow?.removeEventListener('scroll', schedulePickerBounds, true)
    boundaryResizeObserver?.disconnect()
    for (const block of root.querySelectorAll<HTMLElement>('.milkdown-code-block')) {
      clearAdjustedTokenColors(block)
      delete block.dataset.arkdownColorMode
      block.querySelector('.arkdown-block-theme-toggle')?.remove()
      block.querySelector('.arkdown-mermaid-convert-button')?.remove()
      block.querySelector('.arkdown-code-explanation-button')?.remove()
      const picker = block.querySelector<HTMLElement>('.language-picker')
      if (picker) clearPickerConstraints(picker)
    }
  }
}
