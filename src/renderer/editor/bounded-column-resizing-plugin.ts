import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { SchemaReady, prosePluginsCtx } from '@milkdown/kit/core'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  TableMap,
  columnResizing,
  columnResizingPluginKey,
} from '@milkdown/kit/prose/tables'

const COLUMN_SELECTOR = ':scope > colgroup > col'
const DEFAULT_CELL_MIN_WIDTH = 25

export const TABLE_COLUMN_RESIZING_ATTRIBUTE = 'data-arkdown-column-resizing'
export const TABLE_COLUMN_RESIZE_END_EVENT = 'arkdown:table-column-resize-end'

export interface BoundedColumnResizeInput {
  startWidth: number
  pointerDelta: number
  tableWidth: number
  availableWidth: number
  minimumWidth: number
}

export interface ResizeRenderedColumnWidthsInput {
  widths: readonly number[]
  columnIndex: number
  pointerDelta: number
  availableWidth: number
  minimumWidth: number
}

export interface TableColumnResizeEndDetail {
  widths: number[]
}

export function clampDraggedColumnWidth({
  startWidth,
  pointerDelta,
  tableWidth,
  availableWidth,
  minimumWidth,
}: BoundedColumnResizeInput): number {
  const availableGrowth = Math.max(0, availableWidth - tableWidth)
  const maximumWidth = startWidth + availableGrowth
  return Math.min(maximumWidth, Math.max(minimumWidth, startWidth + pointerDelta))
}

export function normalizeRenderedColumnWidths(widths: readonly number[]): number[] {
  return widths.map((width) => Math.max(DEFAULT_CELL_MIN_WIDTH, Math.floor(width)))
}

export function totalColumnWidth(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width, 0)
}

export function resizeRenderedColumnWidths({
  widths,
  columnIndex,
  pointerDelta,
  availableWidth,
  minimumWidth,
}: ResizeRenderedColumnWidthsInput): number[] {
  if (columnIndex < 0 || columnIndex >= widths.length) return [...widths]
  const nextWidths = [...widths]
  nextWidths[columnIndex] = clampDraggedColumnWidth({
    startWidth: widths[columnIndex],
    pointerDelta,
    tableWidth: totalColumnWidth(widths),
    availableWidth,
    minimumWidth,
  })
  return nextWidths
}

function readRenderedColumnWidths(table: HTMLTableElement): number[] | null {
  const columns = Array.from(table.querySelectorAll<HTMLTableColElement>(COLUMN_SELECTOR))
  if (!columns.length) return null
  const widths = columns.map((column) => {
    const inlineWidth = Number.parseFloat(column.style.width)
    if (Number.isFinite(inlineWidth) && inlineWidth > 0) return inlineWidth
    const attributeWidth = Number(column.getAttribute('width'))
    if (Number.isFinite(attributeWidth) && attributeWidth > 0) return attributeWidth
    const renderedWidth = column.getBoundingClientRect().width
    return Number.isFinite(renderedWidth) && renderedWidth > 0
      ? renderedWidth
      : Number.NaN
  })
  if (widths.some((width) => !Number.isFinite(width) || width <= 0)) return null
  return normalizeRenderedColumnWidths(widths)
}

function findTableDom(view: EditorView, tableStart: number): HTMLTableElement | null {
  let dom: globalThis.Node | null = view.domAtPos(tableStart).node
  if (dom.nodeType === globalThis.Node.TEXT_NODE) dom = dom.parentNode
  while (dom && (!(dom instanceof HTMLTableElement))) dom = dom.parentNode
  return dom instanceof HTMLTableElement ? dom : null
}

function displayColumnWidths(table: HTMLTableElement, widths: readonly number[]): void {
  const columns = Array.from(table.querySelectorAll<HTMLTableColElement>(COLUMN_SELECTOR))
  if (columns.length !== widths.length) return
  columns.forEach((column, index) => {
    column.style.width = `${widths[index]}px`
  })
  table.style.width = `${totalColumnWidth(widths)}px`
  table.style.maxWidth = '100%'
  table.style.minWidth = '0'
}

function sameWidths(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((width, index) => width === right[index])
}

function commitColumnWidths(
  view: EditorView,
  activeHandle: number,
  widths: readonly number[],
): void {
  const resolvedCell = view.state.doc.resolve(activeHandle)
  const table = resolvedCell.node(-1)
  const tableStart = resolvedCell.start(-1)
  const map = TableMap.get(table)
  if (widths.length !== map.width) return

  const visited = new Set<number>()
  const transaction = view.state.tr
  for (const relativePosition of map.map) {
    if (visited.has(relativePosition)) continue
    visited.add(relativePosition)
    const cell = table.nodeAt(relativePosition)
    if (!cell) continue
    const firstColumn = map.colCount(relativePosition)
    const columnWidths = widths.slice(firstColumn, firstColumn + Number(cell.attrs.colspan))
    const previousWidths = Array.isArray(cell.attrs.colwidth)
      ? cell.attrs.colwidth.map((width: unknown) => Number(width))
      : []
    if (sameWidths(previousWidths, columnWidths)) continue
    transaction.setNodeMarkup(tableStart + relativePosition, null, {
      ...cell.attrs,
      colwidth: columnWidths,
    })
  }
  if (transaction.docChanged) view.dispatch(transaction)
}

function activeResizeColumn(
  documentNode: ProseMirrorNode,
  activeHandle: number,
): { columnIndex: number; tableStart: number } | null {
  const resolvedCell = documentNode.resolve(activeHandle)
  const cell = resolvedCell.nodeAfter
  if (!cell) return null
  const table = resolvedCell.node(-1)
  const tableStart = resolvedCell.start(-1)
  const map = TableMap.get(table)
  return {
    columnIndex: map.colCount(resolvedCell.pos - tableStart) + Number(cell.attrs.colspan) - 1,
    tableStart,
  }
}

function handleBoundedMouseDown(
  view: EditorView,
  event: MouseEvent,
  minimumWidth = DEFAULT_CELL_MIN_WIDTH,
): boolean {
  if (!view.editable) return false
  const pluginState = columnResizingPluginKey.getState(view.state)
  if (!pluginState || pluginState.activeHandle < 0 || pluginState.dragging) return false

  const active = activeResizeColumn(view.state.doc, pluginState.activeHandle)
  if (!active) return false
  const table = findTableDom(view, active.tableStart)
  const wrapper = table?.closest<HTMLElement>('.tableWrapper')
  const startWidths = table ? readRenderedColumnWidths(table) : null
  const availableWidth = Math.floor(wrapper?.clientWidth ?? 0)
  if (
    !table
    || !startWidths
    || active.columnIndex >= startWidths.length
    || availableWidth <= 0
  ) return false

  const startX = event.clientX
  const activeHandle = pluginState.activeHandle
  const ownerWindow = view.dom.ownerDocument.defaultView ?? window
  table.setAttribute(TABLE_COLUMN_RESIZING_ATTRIBUTE, 'true')
  displayColumnWidths(table, startWidths)
  view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, {
    setDragging: {
      startX,
      startWidth: startWidths[active.columnIndex],
    },
  }))

  const widthsAt = (clientX: number) => resizeRenderedColumnWidths({
    widths: startWidths,
    columnIndex: active.columnIndex,
    pointerDelta: clientX - startX,
    availableWidth,
    minimumWidth,
  })

  let finished = false
  const finish = (finishEvent: MouseEvent) => {
    if (finished) return
    finished = true
    ownerWindow.removeEventListener('mouseup', finish)
    ownerWindow.removeEventListener('mousemove', move)

    const finalWidths = widthsAt(finishEvent.clientX)
    displayColumnWidths(table, finalWidths)
    if (!sameWidths(startWidths, finalWidths)) {
      commitColumnWidths(view, activeHandle, finalWidths)
    }
    const latestPluginState = columnResizingPluginKey.getState(view.state)
    if (latestPluginState?.dragging) {
      view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null }))
    }
    table.removeAttribute(TABLE_COLUMN_RESIZING_ATTRIBUTE)
    table.dispatchEvent(new CustomEvent<TableColumnResizeEndDetail>(
      TABLE_COLUMN_RESIZE_END_EVENT,
      {
        bubbles: true,
        detail: { widths: finalWidths },
      },
    ))
  }

  const move = (moveEvent: MouseEvent) => {
    if (!moveEvent.buttons && !moveEvent.which) {
      finish(moveEvent)
      return
    }
    displayColumnWidths(table, widthsAt(moveEvent.clientX))
  }

  ownerWindow.addEventListener('mouseup', finish)
  ownerWindow.addEventListener('mousemove', move)
  event.preventDefault()
  return true
}

export const boundedColumnResizingPlugin: MilkdownPlugin = (context) => async () => {
  await context.wait(SchemaReady)
  const plugin = columnResizing({})
  const handlers = plugin.props.handleDOMEvents
  if (handlers) handlers.mousedown = handleBoundedMouseDown
  context.update(prosePluginsCtx, (plugins) => [...plugins, plugin])

  return () => {
    context.update(prosePluginsCtx, (plugins) => plugins.filter(
      (registeredPlugin) => registeredPlugin !== plugin,
    ))
  }
}
