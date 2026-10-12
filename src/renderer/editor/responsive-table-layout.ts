import {
  TABLE_COLUMN_RESIZE_END_EVENT,
  TABLE_COLUMN_RESIZING_ATTRIBUTE,
  type TableColumnResizeEndDetail,
} from './bounded-column-resizing-plugin'

const COLUMN_SELECTOR = ':scope > colgroup > col'

export function scaleColumnWidths(
  preferredWidths: readonly number[],
  availableWidth: number,
): number[] | null {
  if (
    !Number.isFinite(availableWidth)
    || availableWidth <= 0
    || preferredWidths.length === 0
    || preferredWidths.some((width) => !Number.isFinite(width) || width <= 0)
  ) return null

  const total = preferredWidths.reduce((sum, width) => sum + width, 0)
  const scale = Math.min(1, availableWidth / total)
  return preferredWidths.map((width) => width * scale)
}

function readColumnWidths(table: HTMLTableElement): number[] | null {
  const columns = Array.from(table.querySelectorAll<HTMLTableColElement>(COLUMN_SELECTOR))
  if (!columns.length) return null
  const widths = columns.map((column) => {
    const inlineWidth = Number.parseFloat(column.style.width)
    if (Number.isFinite(inlineWidth) && inlineWidth > 0) return inlineWidth
    const attributeWidth = Number(column.getAttribute('width'))
    return Number.isFinite(attributeWidth) && attributeWidth > 0 ? attributeWidth : Number.NaN
  })
  return widths.every((width) => Number.isFinite(width) && width > 0) ? widths : null
}

export function createResponsiveTableLayout(root: HTMLElement): () => void {
  const preferredWidths = new WeakMap<HTMLTableElement, number[]>()
  let animationFrame = 0

  const fitTable = (table: HTMLTableElement) => {
    if (table.hasAttribute(TABLE_COLUMN_RESIZING_ATTRIBUTE)) return
    const wrapper = table.closest<HTMLElement>('.tableWrapper')
    if (!wrapper || wrapper.clientWidth <= 0) return
    const columns = Array.from(table.querySelectorAll<HTMLTableColElement>(COLUMN_SELECTOR))
    const preferred = preferredWidths.get(table) ?? readColumnWidths(table)
    if (!preferred || preferred.length !== columns.length) return
    preferredWidths.set(table, preferred)

    const rendered = scaleColumnWidths(preferred, wrapper.clientWidth)
    if (!rendered) return
    columns.forEach((column, index) => {
      column.style.width = `${rendered[index]}px`
    })
    table.style.width = `${rendered.reduce((sum, width) => sum + width, 0)}px`
    table.style.maxWidth = '100%'
    table.style.minWidth = '0'
  }

  const fitAll = () => {
    animationFrame = 0
    root.querySelectorAll<HTMLTableElement>('.tableWrapper table').forEach(fitTable)
  }
  const scheduleFit = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame)
    animationFrame = requestAnimationFrame(fitAll)
  }

  const mutationObserver = new MutationObserver(scheduleFit)
  mutationObserver.observe(root, { childList: true, subtree: true })
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(scheduleFit)
    : null
  resizeObserver?.observe(root)

  const onResizeEnd = (event: Event) => {
    const table = event.target
    if (!(table instanceof HTMLTableElement)) return
    const widths = (event as CustomEvent<TableColumnResizeEndDetail>).detail?.widths
    const updated = widths?.length ? widths : readColumnWidths(table)
    if (updated) preferredWidths.set(table, [...updated])
    scheduleFit()
  }
  root.addEventListener(TABLE_COLUMN_RESIZE_END_EVENT, onResizeEnd)
  scheduleFit()

  return () => {
    if (animationFrame) cancelAnimationFrame(animationFrame)
    mutationObserver.disconnect()
    resizeObserver?.disconnect()
    root.removeEventListener(TABLE_COLUMN_RESIZE_END_EVENT, onResizeEnd)
  }
}
