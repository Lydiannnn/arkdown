import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import {
  TableMap,
  columnResizingPluginKey,
  tableNodes,
} from '@milkdown/kit/prose/tables'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundedColumnResizingPlugin } from '../../src/renderer/editor/bounded-column-resizing-plugin'
import { createResponsiveTableLayout } from '../../src/renderer/editor/responsive-table-layout'

let mountedView: EditorView | null = null

afterEach(() => {
  mountedView?.destroy()
  mountedView = null
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function createSchema(): Schema {
  const table = tableNodes({
    tableGroup: 'block',
    cellContent: 'paragraph',
    cellAttributes: {},
  })
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
      text: { group: 'inline' },
      table: table.table,
      table_row: table.table_row,
      table_cell: table.table_cell,
      table_header: table.table_header,
    },
  })
}

async function createPlugin() {
  let plugins: unknown[] = []
  const setup = boundedColumnResizingPlugin({
    wait: async () => undefined,
    update: (_slice: unknown, updater: (value: unknown[]) => unknown[]) => {
      plugins = updater(plugins)
    },
  } as never)
  await setup()
  return plugins[0] as never
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

describe('bounded column resize release regression', () => {
  it('keeps an in-bounds drag width after mouseup and responsive recalculation', async () => {
    let resizeLayout = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resizeLayout = callback
      }
      observe() {}
      disconnect() {}
    })

    const schema = createSchema()
    const header = schema.nodes.table_header.create(
      { colspan: 1, rowspan: 1, colwidth: [100] },
      schema.nodes.paragraph.create(null, schema.text('Header')),
    )
    const row = schema.nodes.table_row.create(null, [header, header])
    const table = schema.nodes.table.create(null, [row])
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(null, [table]),
      plugins: [await createPlugin()],
    })
    const host = document.body.appendChild(document.createElement('div'))
    mountedView = new EditorView(host, { state })
    const wrapper = host.querySelector<HTMLElement>('.tableWrapper')!
    Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: 250 })
    const detachResponsiveLayout = createResponsiveTableLayout(host)
    await nextFrame()

    const activeHandle = 1 + TableMap.get(table).map[0]
    mountedView.dispatch(
      mountedView.state.tr.setMeta(columnResizingPluginKey, { setHandle: activeHandle }),
    )
    const handle = host.querySelector<HTMLElement>('.column-resize-handle')!
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => handle,
    })
    handle.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: 100,
    }))
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      buttons: 1,
      clientX: 120,
    }))

    const columns = host.querySelectorAll<HTMLTableColElement>('col')
    expect([...columns].map((column) => column.style.width)).toEqual(['120px', '100px'])

    window.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      button: 0,
      clientX: 120,
    }))
    resizeLayout()
    await nextFrame()

    expect([...columns].map((column) => column.style.width)).toEqual(['120px', '100px'])
    expect(mountedView.state.doc.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([120])
    detachResponsiveLayout()
  })
})
