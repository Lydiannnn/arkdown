import { StrictMode, useEffect } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentViewApi, DocumentViewSnapshot } from '../../src/shared/document-view'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { DocumentViewPanel } from '../../src/renderer/document-view/DocumentViewPanel'
import { DocumentViewMarkdown } from '../../src/renderer/document-view/DocumentViewMarkdown'
import { useDocumentView } from '../../src/renderer/document-view/use-document-view'
import { BusinessDialogProvider } from '../../src/renderer/modal/BusinessDialogProvider'

afterEach(() => vi.unstubAllGlobals())

function setup(text: string, kind: DocumentViewSnapshot['kind'] = 'markdown', line?: number) {
  const opened: string[] = []
  const requests: Array<{ href: string; sourceId?: string }> = []
  const external = vi.fn(async () => ({ ok: true as const, value: null }))
  const source = vi.fn()
  const api: DocumentViewApi = {
    navigateDocumentView: async (request) => {
      requests.push(request)
      if (request.href === 'missing.md') return { ok: false, error: { code: 'NOT_FOUND', message: '找不到目标文件' } }
      if (request.href === 'folder') return { ok: true, value: { kind: 'directory', id: 'folder', absolutePath: 'C:\\notes\\folder', displayName: 'folder' } }
      return { ok: true, value: { kind: 'document', document: { id: request.href, absolutePath: `C:\\notes\\${request.href}`, displayName: request.href.split(/[\\/]/).at(-1)!, text, kind, revision: '1', line } } }
    },
    refreshDocumentView: async (id) => ({ ok: true, value: { id, absolutePath: 'C:\\notes\\B.md', displayName: 'B.md', text: 'Updated', kind, revision: '2' } }),
    inspectDocumentView: async () => ({ ok: true, value: { changed: true, exists: true } }),
    openDocumentView: async (id) => { opened.push(id); return { ok: true, value: null } },
  }
  function Host({ visible = true }: { visible?: boolean }) {
    const controller = useDocumentView({ api, sourceKey: 'one', sourcePath: 'C:\\notes\\A.md', sourceName: 'A.md', onOpenView() {}, onReturnToSource: source })
    useEffect(() => { void controller.navigate(kind === 'code' ? 'sample.ts' : 'B.md') }, [])
    return <BusinessDialogProvider><ContextMenuProvider>{visible && <DocumentViewPanel controller={controller} openExternal={external} />}</ContextMenuProvider></BusinessDialogProvider>
  }
  return { ...render(<Host />), Host, opened, requests, external, source }
}

describe('readonly document view panel', () => {
  it.each(['../target.md', 'file:///C:/notes/target.md', 'C:/notes/中文 hello world.md', 'C:/notes/literal%20name.md'])(
    'reveals %s using the current preview token without navigating the preview', async (href) => {
      const revealLocalFileLink = vi.fn(async () => ({ ok: true, value: null }))
      vi.stubGlobal('arkdown', { revealLocalFileLink })
      const h = setup(`[目标](<${href}>)`)
      fireEvent.contextMenu(await screen.findByText('目标'), { clientX: 50, clientY: 50 })
      fireEvent.click(await screen.findByRole('menuitem', { name: '打开文件位置' }))
      await waitFor(() => expect(revealLocalFileLink).toHaveBeenCalledExactlyOnceWith({ href, sourceId: 'B.md' }))
      expect(h.requests).toEqual([{ href: 'B.md' }])
      expect(h.opened).toEqual([])
      expect(screen.getByRole('button', { name: 'B.md' })).toHaveAttribute('aria-current', 'page')
    },
  )

  it('preserves an absolute reference-link path before Markdown URL encoding', async () => {
    const revealLocalFileLink = vi.fn(async () => ({ ok: true, value: null }))
    vi.stubGlobal('arkdown', { revealLocalFileLink })
    setup('[目标][file]\n\n[file]: <C:/notes/中文 hello world.md>')
    fireEvent.contextMenu(await screen.findByText('目标'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '打开文件位置' }))
    await waitFor(() => expect(revealLocalFileLink).toHaveBeenCalledExactlyOnceWith({ href: 'C:/notes/中文 hello world.md', sourceId: 'B.md' }))
  })

  it('shows the requested missing-file message in a dialog and preserves the preview', async () => {
    vi.stubGlobal('arkdown', { revealLocalFileLink: async () => ({ ok: false, error: {
      code: 'LOCAL_FILE_NOT_FOUND', message: '无法找到文件。目标文件已不在原位置，或当前文档已被移动到新位置。',
    } }) })
    setup('[目标](../missing.md)')
    fireEvent.contextMenu(await screen.findByText('目标'), { clientX: 50, clientY: 50 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '打开文件位置' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('无法找到文件。目标文件已不在原位置，或当前文档已被移动到新位置。')
    expect(screen.getByText('目标')).toBeInTheDocument()
  })

  it('does not offer file location for web links in the preview', async () => {
    setup('[网页](https://example.com)')
    fireEvent.contextMenu(await screen.findByText('网页'), { clientX: 50, clientY: 50 })
    await screen.findByRole('menuitem', { name: '在新窗口打开该文档' })
    expect(screen.queryByRole('menuitem', { name: '打开文件位置' })).toBeNull()
  })

  it('renders Markdown with immutable tasks and blocks raw HTML and dangerous links', async () => {
    const h = setup('- [ ] Task\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)\n\n![image](./assets/chart.png)')
    const task = await screen.findByRole('checkbox')
    expect(task).toBeDisabled()
    await userEvent.click(task)
    expect(task).not.toBeChecked()
    expect(h.container.querySelector('script')).toBeNull()
    expect(screen.getByText('bad')).not.toHaveAttribute('href')
    expect(screen.getByAltText('image')).toHaveAttribute('src', 'arkdown-asset://external/C%3A%5Cnotes%5Cassets%5Cchart.png')
  })

  it('opens Ctrl+click relative links in an editing window without replacing the preview', async () => {
    const h = setup('[relative](child.md) [web](https://example.com) [absolute](file:///C:/notes/other.md)')
    const relative = await screen.findByText('relative')
    fireEvent.click(relative)
    expect(h.requests).toEqual([{ href: 'B.md' }])
    fireEvent.click(relative, { ctrlKey: true })
    await waitFor(() => expect(h.opened).toEqual(['child.md']))
    expect(screen.getByRole('button', { name: 'B.md' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: 'child.md' })).toBeNull()
    expect(h.requests[1]).toEqual({ href: 'child.md', sourceId: 'B.md', activeIds: ['B.md'] })
    fireEvent.click(screen.getByText('web'), { ctrlKey: true })
    await waitFor(() => expect(h.external).toHaveBeenCalledWith('https://example.com/'))
    fireEvent.click(screen.getByText('absolute'), { ctrlKey: true })
    await waitFor(() => expect(h.external).toHaveBeenCalledWith('C:\\notes\\other.md'))
  })

  it('targets the clicked breadcrumb in the standard menu and focuses the original source', async () => {
    const h = setup('[next](C.md)')
    await screen.findByText('next')
    fireEvent.contextMenu(screen.getByRole('button', { name: 'B.md' }), { clientX: 50, clientY: 50 })
    fireEvent.click(await screen.findByRole('menuitem', { name: '使用新窗口打开' }))
    await waitFor(() => expect(h.opened).toEqual(['B.md']))
    fireEvent.click(screen.getByRole('button', { name: 'A.md' }))
    expect(h.source).toHaveBeenCalledOnce()
    expect(screen.getByText('next')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回上一文档' })).toBeEnabled()
    expect(h.external).not.toHaveBeenCalled()
  })

  it('retains rendered position across sidebar tab switches and reports missing targets', async () => {
    const h = setup('[missing](missing.md)')
    await screen.findByText('missing')
    const scroll = screen.getByTestId('document-view-scroll')
    scroll.scrollTop = 123
    fireEvent.scroll(scroll)
    h.rerender(<h.Host visible={false} />)
    h.rerender(<h.Host />)
    expect(screen.getByTestId('document-view-scroll').scrollTop).toBe(123)
    fireEvent.click(screen.getByText('missing'), { ctrlKey: true })
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到目标文件')
    expect(screen.getByText('missing')).toBeInTheDocument()
  })

  it('shows external changes without replacing content until refresh', async () => {
    setup('Original')
    await screen.findByText('Original')
    fireEvent(window, new Event('focus'))
    expect(await screen.findByText('文件已更改，刷新以查看最新内容')).toBeInTheDocument()
    expect(screen.getByText('Original')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新文档' }))
    expect(await screen.findByText('Updated')).toBeInTheDocument()
  })

  it('opens relative directories externally while retaining the current preview', async () => {
    const h = setup('[folder](folder)')
    fireEvent.click(await screen.findByText('folder'), { ctrlKey: true })
    await waitFor(() => expect(h.opened).toEqual(['folder']))
    expect(screen.getByRole('button', { name: 'B.md' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps find and selection inside this view and consumes Escape', async () => {
    setup('Alpha unique phrase Omega')
    const content = await screen.findByText('Alpha unique phrase Omega')
    const globalKey = vi.fn()
    window.addEventListener('keydown', globalKey)
    fireEvent.keyDown(content, { key: 'f', ctrlKey: true })
    const input = screen.getByRole('searchbox', { name: '在文档查看中查找' })
    fireEvent.change(input, { target: { value: 'unique phrase' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(window.getSelection()?.toString()).toBe('unique phrase')
    fireEvent.scroll(screen.getByTestId('document-view-scroll'))
    expect(window.getSelection()?.toString()).toBe('unique phrase')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(globalKey).not.toHaveBeenCalled()
    window.removeEventListener('keydown', globalKey)
  })

  it.each(['find-in-document', 'toggle-document-find'])('routes the app %s command to this view only', async (command) => {
    setup('Preview search text')
    await screen.findByText('Preview search text')
    screen.getByRole('region', { name: '文档查看' }).focus()
    fireEvent(window, new CustomEvent('arkdown:document-view-command', { detail: command }))
    expect(screen.getByRole('searchbox', { name: '在文档查看中查找' })).toHaveFocus()
  })

  it('claims keyboard focus when reading Markdown so app menu commands cannot target the main editor', async () => {
    setup('Read this paragraph')
    const paragraph = await screen.findByText('Read this paragraph')
    fireEvent.pointerDown(paragraph, { button: 0 })
    expect(screen.getByRole('region', { name: '文档查看' })).toHaveFocus()
  })

  it('lets Escape reach the sidebar when no local find UI is open', async () => {
    setup('No search is open')
    const paragraph = await screen.findByText('No search is open')
    const escape = vi.fn()
    window.addEventListener('keydown', escape)
    fireEvent.keyDown(paragraph, { key: 'Escape' })
    expect(escape).toHaveBeenCalledOnce()
    expect(escape.mock.calls[0]![0].defaultPrevented).toBe(false)
    window.removeEventListener('keydown', escape)
  })

  it('does not open a link after Ctrl-drag selection over it', async () => {
    const h = setup('[relative](child.md)')
    const link = await screen.findByText('relative')
    fireEvent.pointerDown(link, { clientX: 10, clientY: 10, ctrlKey: true })
    fireEvent.pointerMove(window, { clientX: 25, clientY: 10, ctrlKey: true })
    fireEvent.pointerUp(window, { clientX: 25, clientY: 10, ctrlKey: true })
    fireEvent.click(link, { ctrlKey: true })
    expect(h.requests).toEqual([{ href: 'B.md' }])
  })

  it('consumes a heading location once and keeps later reading scroll across tab remounts', async () => {
    const original = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const h = setup('# Target\n\n[Jump](#target)')
      fireEvent.click(await screen.findByText('Jump'), { ctrlKey: true })
      expect(scrollIntoView).toHaveBeenCalledOnce()
      const scroll = screen.getByTestId('document-view-scroll')
      scroll.scrollTop = 250
      fireEvent.scroll(scroll)
      h.rerender(<h.Host visible={false} />)
      h.rerender(<h.Host />)
      expect(scrollIntoView).toHaveBeenCalledOnce()
      expect(screen.getByTestId('document-view-scroll').scrollTop).toBe(250)
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('consumes a code line location once instead of resetting selection on a tab remount', async () => {
    const h = setup('first\nsecond\nthird', 'code', 2)
    await waitFor(() => expect(h.container.querySelector('.cm-editor')).not.toBeNull())
    const view = () => EditorView.findFromDOM(h.container.querySelector('.cm-editor')!)!
    expect(view().state.selection.main.head).toBe(6)
    h.rerender(<h.Host visible={false} />)
    h.rerender(<h.Host />)
    expect(view().state.selection.main.head).toBe(0)
  })

  it('opens same-name links by their actual paths without changing the breadcrumb', async () => {
    const h = setup('[First](one/browser.json) [Second](two/browser.json)')
    fireEvent.click(await screen.findByText('First'), { ctrlKey: true })
    await waitFor(() => expect(h.opened).toEqual(['one/browser.json']))
    fireEvent.click(screen.getByText('Second'), { ctrlKey: true })
    await waitFor(() => expect(h.opened).toEqual(['one/browser.json', 'two/browser.json']))
    expect(screen.getByRole('button', { name: 'B.md' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps the trial checklist usable when its report link points back to the dirty main document', async () => {
    const h = setup('# Trial checklist\n\n[阶段报告](A.md)')
    const link = await screen.findByRole('link', { name: '阶段报告' })
    const scroll = screen.getByTestId('document-view-scroll')
    scroll.scrollTop = 180
    fireEvent.scroll(scroll)
    fireEvent.click(link, { ctrlKey: true })
    await waitFor(() => expect(h.source).toHaveBeenCalledOnce())
    expect(screen.getByRole('heading', { name: 'Trial checklist' })).toBeInTheDocument()
    expect(scroll.scrollTop).toBe(180)
    expect(screen.getByRole('button', { name: '返回上一文档' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '返回上一文档' }))
    expect(h.source).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('heading', { name: 'Trial checklist' })).toBeInTheDocument()
  })

  it('copies only the selected preview text and opens the displayed document from the body menu', async () => {
    userEvent.setup()
    const h = setup('Alpha unique phrase Omega')
    const paragraph = await screen.findByText('Alpha unique phrase Omega')
    const range = document.createRange()
    range.setStart(paragraph.firstChild!, 6)
    range.setEnd(paragraph.firstChild!, 19)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(paragraph)
    fireEvent.click(await screen.findByRole('menuitem', { name: '复制' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('unique phrase'))
    fireEvent.contextMenu(paragraph)
    fireEvent.click(await screen.findByRole('menuitem', { name: '在新窗口打开该文档' }))
    await waitFor(() => expect(h.opened).toEqual(['B.md']))
    expect(paragraph).toBeInTheDocument()
  })

  it('disables preview copy for no selection or a selection in the main document', async () => {
    setup('Preview text')
    const paragraph = await screen.findByText('Preview text')
    window.getSelection()?.removeAllRanges()
    fireEvent.contextMenu(paragraph)
    expect(await screen.findByRole('menuitem', { name: '复制' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    const outside = document.createElement('p')
    outside.textContent = 'Main editor selection'
    document.body.append(outside)
    try {
      const range = document.createRange()
      range.selectNodeContents(outside)
      window.getSelection()?.addRange(range)
      fireEvent.contextMenu(paragraph)
      expect(await screen.findByRole('menuitem', { name: '复制' })).toBeDisabled()
    } finally { outside.remove(); window.getSelection()?.removeAllRanges() }
  })

  it('copies a CodeMirror selection from readonly code without changing its content', async () => {
    userEvent.setup()
    const h = setup('const value = 1;\nsecond line', 'code')
    await waitFor(() => expect(h.container.querySelector('.cm-editor')).not.toBeNull())
    const view = EditorView.findFromDOM(h.container.querySelector('.cm-editor')!)!
    view.focus()
    view.dispatch({ selection: { anchor: 6, head: 11 } })
    fireEvent.contextMenu(view.contentDOM)
    fireEvent.click(await screen.findByRole('menuitem', { name: '复制' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('value'))
    expect(view.state.doc.toString()).toBe('const value = 1;\nsecond line')
  })

  it('keeps the document visible and explains a missing heading target', async () => {
    setup('# Existing\n\n[Missing section](#missing)')
    fireEvent.click(await screen.findByText('Missing section'), { ctrlKey: true })
    expect(await screen.findByRole('alert')).toHaveTextContent('未找到链接指定的章节，已显示文档')
    expect(screen.getByRole('heading', { name: 'Existing' })).toBeInTheDocument()
  })

  it('assigns stable duplicate heading anchors during StrictMode double rendering', () => {
    render(<StrictMode><DocumentViewMarkdown document={{ id: 'strict', absolutePath: 'C:\\notes\\strict.md', displayName: 'strict.md', text: '# Section\n\n# Section', kind: 'markdown', revision: '1' }} /></StrictMode>)
    const headings = screen.getAllByRole('heading', { name: 'Section' })
    expect(headings.map((heading) => heading.getAttribute('data-document-view-anchor'))).toEqual(['section', 'section-1'])
  })

  it('uses the same collapsed-whitespace heading anchors as editable documents', () => {
    render(<DocumentViewMarkdown document={{ id: 'space', absolutePath: 'C:/notes/space.md', displayName: 'space.md', text: '# Hello   World', kind: 'markdown', revision: '1' }} />)
    expect(screen.getByRole('heading', { name: 'Hello World' })).toHaveAttribute('data-document-view-anchor', 'hello-world')
  })

  it('displays literal code with line numbers and rejects attempted edits', async () => {
    const text = '<script>danger()</script>\nconst value = 1;'
    const h = setup(text, 'code')
    await waitFor(() => expect(h.container.querySelector('.cm-content')).toHaveTextContent('<script>danger()</script>'))
    expect(h.container.querySelector('script')).toBeNull()
    expect(h.container.querySelector('.cm-content')).toHaveAttribute('contenteditable', 'false')
    expect(h.container.querySelector('.cm-lineNumbers')).toBeInTheDocument()
  })
})
