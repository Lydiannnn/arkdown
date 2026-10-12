import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../../src/shared/contracts'
import type { DocumentViewApi, DocumentViewResult } from '../../src/shared/document-view'
import { useDocumentView } from '../../src/renderer/document-view/use-document-view'

function document(id: string, path: string): DocumentViewResult {
  return { kind: 'document', document: { id, absolutePath: path, displayName: path.split('\\').at(-1)!, text: id, kind: 'markdown', revision: '1' } }
}
function harness(navigate: DocumentViewApi['navigateDocumentView'] = async ({ href }) => ({ ok: true, value: document(href, `C:\\notes\\${href}`) })) {
  const api: DocumentViewApi = {
    navigateDocumentView: navigate,
    refreshDocumentView: async (id) => ({ ok: true, value: { id, absolutePath: `C:\\notes\\${id}`, displayName: id, text: 'changed', kind: 'markdown', revision: '2' } }),
    inspectDocumentView: async () => ({ ok: true, value: { changed: true, exists: true } }),
    openDocumentView: async () => ({ ok: true, value: null }),
  }
  const onReturnToSource = vi.fn()
  const props = { api, sourceKey: 'one', sourcePath: 'C:\\notes\\A.md', sourceName: 'A.md', onOpenView: vi.fn(), onReturnToSource }
  return { props, onReturnToSource, ...renderHook((input) => useDocumentView(input), { initialProps: props }) }
}

describe('document view navigation', () => {
  it('opens a preview-relative target without changing its snapshot, scroll or change notice', async () => {
    const h = harness()
    const opened: string[] = []
    h.props.api.openDocumentView = async (id) => { opened.push(id); return { ok: true, value: null } }
    await act(() => h.result.current.navigate('B.md'))
    act(() => h.result.current.setScroll(260))
    await act(() => h.result.current.checkForChanges())
    const snapshot = h.result.current.current
    await act(() => h.result.current.openLink('C.md'))
    expect(opened).toEqual(['C.md'])
    expect(h.result.current.current).toBe(snapshot)
    expect(h.result.current.current?.scrollTop).toBe(260)
    expect(h.result.current.state.changed).toBe(true)
    expect(h.result.current.state.loading).toBe(false)
  })

  it('does not open a resolved link after the source session has changed', async () => {
    let finish!: (value: ApiResult<DocumentViewResult>) => void
    const h = harness(({ href }) => href === 'C.md'
      ? new Promise((resolve) => { finish = resolve })
      : Promise.resolve({ ok: true, value: document('b', 'C:\\notes\\B.md') }))
    const opened: string[] = []
    h.props.api.openDocumentView = async (id) => { opened.push(id); return { ok: true, value: null } }
    await act(() => h.result.current.navigate('B.md'))
    let pending!: Promise<void>
    act(() => { pending = h.result.current.openLink('C.md') })
    h.rerender({ ...h.props, sourceKey: 'another-document' })
    await act(async () => { finish({ ok: true, value: document('c', 'C:\\notes\\C.md') }); await pending })
    expect(opened).toEqual([])
    expect(h.result.current.current).toBeNull()
    expect(h.result.current.state.error).toBeNull()
  })

  it('retains the readable document and permits retry when the editing window cannot open', async () => {
    const h = harness()
    let available = false
    h.props.api.openDocumentView = async () => available ? { ok: true, value: null }
      : { ok: false, error: { code: 'OPEN_FAILED', message: '无法打开目标' } }
    await act(() => h.result.current.navigate('B.md'))
    await act(() => h.result.current.openLink('C.md'))
    expect(h.result.current.current?.displayName).toBe('B.md')
    expect(h.result.current.state.error).toBe('无法打开目标')
    expect(h.result.current.state.loading).toBe(false)
    available = true
    await act(() => h.result.current.openLink('C.md'))
    expect(h.result.current.state.error).toBeNull()
    expect(h.result.current.current?.displayName).toBe('B.md')
  })

  it('returns A → B → A to the original editor without replacing its unsaved text', async () => {
    const h = harness()
    await act(() => h.result.current.navigate('B.md'))
    expect(h.result.current.current?.displayName).toBe('B.md')
    await act(() => h.result.current.navigate('A.md', 'B.md'))
    expect(h.result.current.current?.displayName).toBe('B.md')
    expect(h.onReturnToSource).toHaveBeenCalledOnce()
  })

  it('forwards a root-return anchor and line once while a plain root crumb only focuses', async () => {
    const h = harness(async () => ({ ok: true, value: { kind: 'document', document: { id: 'root-copy', absolutePath: 'C:\\notes\\A.md', displayName: 'A.md', text: 'disk text must not replace unsaved text', kind: 'markdown', revision: '1', anchor: 'section', line: 13 } } }))
    await act(() => h.result.current.navigate('A.md:13#section', 'b'))
    expect(h.onReturnToSource).toHaveBeenLastCalledWith({ anchor: 'section', line: 13 })
    expect(h.result.current.state.entries).toHaveLength(0)
    act(() => h.result.current.select('source'))
    expect(h.onReturnToSource).toHaveBeenLastCalledWith(undefined)
    expect(h.onReturnToSource).toHaveBeenCalledTimes(2)
  })

  it('distinguishes equal basenames and restores scroll when selecting a previous full path', async () => {
    const h = harness()
    await act(() => h.result.current.navigate('one\\browser.json'))
    act(() => h.result.current.setScroll(275))
    await act(() => h.result.current.navigate('two\\browser.json', 'one\\browser.json'))
    expect(h.result.current.state.entries).toHaveLength(2)
    act(() => h.result.current.back())
    expect(h.result.current.current?.absolutePath).toBe('C:\\notes\\one\\browser.json')
    expect(h.result.current.current?.scrollTop).toBe(275)
  })

  it('truncates cycles to an existing path while retaining its scroll', async () => {
    let serial = 0
    const h = harness(async ({ href }) => ({ ok: true, value: document(`${++serial}`, `C:\\notes\\${href}`) }))
    await act(() => h.result.current.navigate('B.md'))
    act(() => h.result.current.setScroll(140))
    await act(() => h.result.current.navigate('C.md', '1'))
    await act(() => h.result.current.navigate('B.md', '2'))
    expect(h.result.current.state.entries).toHaveLength(1)
    expect(h.result.current.current?.scrollTop).toBe(140)
  })

  it('starts a new breadcrumb branch for links clicked in the original source', async () => {
    const h = harness()
    await act(() => h.result.current.navigate('B.md'))
    await act(() => h.result.current.navigate('C.md', 'B.md'))
    await act(() => h.result.current.navigate('D.md'))
    expect(h.result.current.state.entries.map((entry) => entry.displayName)).toEqual(['D.md'])
  })

  it('keeps same-document anchor navigation when an older target finishes afterward', async () => {
    let finish!: (value: ApiResult<DocumentViewResult>) => void
    const h = harness(({ href }) => href === 'C.md'
      ? new Promise((resolve) => { finish = resolve })
      : Promise.resolve({ ok: true, value: document('b', 'C:\\notes\\B.md') }))
    await act(() => h.result.current.navigate('B.md'))
    let pending!: Promise<void>
    act(() => { pending = h.result.current.navigate('C.md', 'b') })
    await act(() => h.result.current.navigate('#section', 'b'))
    await act(async () => { finish({ ok: true, value: document('c', 'C:\\notes\\C.md') }); await pending })
    expect(h.result.current.current?.id).toBe('b')
    expect(h.result.current.state.anchor).toBe('section')
    expect(h.result.current.state.loading).toBe(false)
  })

  it('discards old reads that finish after a newer target or source change', async () => {
    const pending: Array<(value: ApiResult<DocumentViewResult>) => void> = []
    const h = harness(() => new Promise((resolve) => pending.push(resolve)))
    let first!: Promise<void>, second!: Promise<void>
    act(() => { first = h.result.current.navigate('B.md'); second = h.result.current.navigate('C.md') })
    await act(async () => { pending[1]!({ ok: true, value: document('c', 'C:\\notes\\C.md') }); await second })
    await act(async () => { pending[0]!({ ok: true, value: document('b', 'C:\\notes\\B.md') }); await first })
    expect(h.result.current.current?.id).toBe('c')
    let third!: Promise<void>
    act(() => { third = h.result.current.navigate('D.md') })
    h.rerender({ ...h.props, sourceKey: 'two' })
    await act(async () => { pending[2]!({ ok: true, value: document('d', 'C:\\notes\\D.md') }); await third })
    expect(h.result.current.current).toBeNull()
  })

  it('retains navigation during parent rerenders and surfaces explicit read errors', async () => {
    const h = harness(async ({ href }) => href === 'missing.md'
      ? { ok: false, error: { code: 'NOT_FOUND', message: '找不到目标文件' } }
      : { ok: true, value: document('b', 'C:\\notes\\B.md') })
    await act(() => h.result.current.navigate('B.md'))
    h.rerender({ ...h.props })
    expect(h.result.current.current?.id).toBe('b')
    await act(() => h.result.current.navigate('missing.md'))
    expect(h.result.current.state.error).toBe('找不到目标文件')
    expect(h.result.current.current?.id).toBe('b')
  })

  it('does not silently replace rendered text when an external change is detected', async () => {
    const h = harness()
    await act(() => h.result.current.navigate('B.md'))
    await act(() => h.result.current.checkForChanges())
    expect(h.result.current.state.changed).toBe(true)
    expect(h.result.current.current?.result).toMatchObject({ document: { text: 'B.md' } })
    await act(() => h.result.current.refresh())
    expect(h.result.current.state.changed).toBe(false)
    expect(h.result.current.current?.result).toMatchObject({ document: { text: 'changed' } })
  })

  it('bounds long reading chains while retaining the current target and pinning visible tokens', async () => {
    const requests: unknown[] = []
    const h = harness(async (input) => {
      requests.push(input)
      return { ok: true, value: document(input.href, `C:\\notes\\${input.href}`) }
    })
    for (let index = 0; index < 35; index += 1) {
      await act(() => h.result.current.navigate(`page-${index}.md`, h.result.current.current?.id))
    }
    expect(h.result.current.state.entries).toHaveLength(32)
    expect(h.result.current.state.entries[0]?.displayName).toBe('page-3.md')
    expect(h.result.current.current?.displayName).toBe('page-34.md')
    expect(requests.at(-1)).toMatchObject({ activeIds: Array.from({ length: 32 }, (_, index) => `page-${index + 2}.md`) })
  })

  it('bounds cached text memory and updates revisited snapshots without losing their scroll', async () => {
    const text = 'x'.repeat(1024 * 1024)
    let revision = 0
    const h = harness(async ({ href }) => ({ ok: true, value: { kind: 'document', document: { id: href, absolutePath: `C:\\notes\\${href}`, displayName: href, text, kind: 'text', revision: `${++revision}` } } }))
    for (let index = 0; index < 10; index += 1) {
      await act(() => h.result.current.navigate(`page-${index}.txt`, h.result.current.current?.id))
    }
    expect(h.result.current.state.entries).toHaveLength(8)
    expect(h.result.current.state.entries[0]?.displayName).toBe('page-2.txt')
    act(() => h.result.current.setScroll(310))
    await act(() => h.result.current.navigate('extra.txt', h.result.current.current?.id))
    await act(() => h.result.current.navigate('page-9.txt', h.result.current.current?.id))
    expect(h.result.current.current?.scrollTop).toBe(310)
    expect(h.result.current.current?.result).toMatchObject({ document: { revision: '12' } })
  })
})
