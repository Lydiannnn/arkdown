import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DocumentHeader } from '../../src/renderer/chrome/DocumentHeader'

const renameOk = () => vi.fn(async () => true)
const STALE_RENAME_SETTLEMENTS = ['resolve true', 'resolve false', 'reject'] as const

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

interface CascadeState {
  hover?: boolean
}

interface CascadeCandidate {
  important: boolean
  order: number
  specificity: readonly [number, number, number]
  value: string
}

function selectorSpecificity(selector: string): readonly [number, number, number] {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0
  const classes = selector.match(/\.[\w-]+/g)?.length ?? 0
  const attributes = selector.match(/\[[^\]]+\]/g)?.length ?? 0
  const pseudoClasses = selector.match(/(^|[^:]):(?!:)[\w-]+/g)?.length ?? 0
  const typeSelectorSource = selector
    .replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/:{1,2}[\w-]+(?:\([^)]*\))?/g, ' ')
    .replace(/[>+~,*]/g, ' ')
  const types = typeSelectorSource.match(/\b[a-z][\w-]*\b/gi)?.length ?? 0
  return [ids, classes + attributes + pseudoClasses, types]
}

function compareSpecificity(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}

function selectorMatches(
  element: Element,
  selector: string,
  state: CascadeState,
): boolean {
  if (selector.includes(':hover') && !state.hover) return false
  if (selector.includes(':focus-visible')) return false
  return element.matches(selector.replaceAll(':hover', ''))
}

function resolveCascadedValue(
  sheet: CSSStyleSheet,
  element: Element,
  property: string,
  state: CascadeState = {},
): string | null {
  let winner: CascadeCandidate | null = null
  let order = 0
  for (const rule of Array.from(sheet.cssRules)) {
    if (!(rule instanceof CSSStyleRule)) continue
    const value = rule.style.getPropertyValue(property)
    if (!value) continue
    for (const selector of rule.selectorText.split(',').map((part) => part.trim())) {
      order += 1
      if (!selectorMatches(element, selector, state)) continue
      const candidate: CascadeCandidate = {
        important: rule.style.getPropertyPriority(property) === 'important',
        order,
        specificity: selectorSpecificity(selector),
        value,
      }
      if (
        !winner
        || Number(candidate.important) > Number(winner.important)
        || (
          candidate.important === winner.important
          && (
            compareSpecificity(candidate.specificity, winner.specificity) > 0
            || (
              compareSpecificity(candidate.specificity, winner.specificity) === 0
              && candidate.order > winner.order
            )
          )
        )
      ) winner = candidate
    }
  }
  return winner?.value ?? null
}


describe('DocumentHeader', () => {
  it('places the generic right-sidebar toggle last and exposes pressed state', () => {
    const onToggleRightSidebar = vi.fn()
    const props = {
      dirty: false,
      fileName: '计划.md',
      hasOriginal: true,
      onCommand: vi.fn(),
      onRename: renameOk(),
      onToggleRightSidebar,
    }
    const { rerender } = render(<DocumentHeader {...props} rightSidebarOpen />)
    const toolbar = screen.getByRole('toolbar', { name: '编辑工具栏' })
    const closeButton = screen.getByRole('button', { name: '关闭右侧栏' })

    expect(toolbar.lastElementChild).toBe(closeButton)
    expect(closeButton).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(closeButton)
    expect(onToggleRightSidebar).toHaveBeenCalledOnce()

    rerender(<DocumentHeader {...props} rightSidebarOpen={false} />)
    expect(screen.getByRole('button', { name: '打开右侧栏' }))
      .toHaveAttribute('aria-pressed', 'false')
  })

  it('starts the document identity with the file icon without a duplicate sidebar control', () => {
    const props = { fileName: '计划.md', hasOriginal: true, onCommand: vi.fn(),
      onRename: renameOk() }
    const { container } = render(<DocumentHeader {...props} />)
    expect(screen.queryByRole('button', { name: /隐藏侧边栏|显示侧边栏/ })).not.toBeInTheDocument()
    expect(container.querySelector('.document-identity')?.firstElementChild).toHaveClass('document-icon')
  })

  it('highlights the source-mode toggle only while code mode is active', () => {
    const props = {
      dirty: false,
      fileName: '未命名',
      hasOriginal: false,
      onCommand: vi.fn(),
      onRename: renameOk(),
    }
    const { rerender } = render(<DocumentHeader {...props} editorMode="visual" />)
    const modeButton = screen.getByRole('button', { name: '源码模式/渲染模式' })

    expect(modeButton).toHaveAttribute('aria-pressed', 'false')
    rerender(<DocumentHeader {...props} editorMode="source" />)
    expect(modeButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('switches modes on click without intercepting pointerdown', () => {
    const onCommand = vi.fn()
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={onCommand}
        onRename={renameOk()}
      />,
    )
    const modeButton = screen.getByRole('button', { name: '源码模式/渲染模式' })
    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      cancelable: true,
    })

    expect(modeButton.dispatchEvent(pointerDown)).toBe(true)
    expect(pointerDown.defaultPrevented).toBe(false)
    expect(onCommand).not.toHaveBeenCalled()
    fireEvent.click(modeButton, { detail: 1 })
    expect(onCommand).toHaveBeenCalledOnce()
    expect(onCommand).toHaveBeenCalledWith('toggle-source-mode')
  })

  it('keeps keyboard activation for the mode button', () => {
    const onCommand = vi.fn()
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={onCommand}
        onRename={renameOk()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '源码模式/渲染模式' }), {
      detail: 0,
    })
    expect(onCommand).toHaveBeenCalledWith('toggle-source-mode')
  })

  it('shows the current file name and dirty state', () => {
    const { rerender } = render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={renameOk()}
      />,
    )
    expect(screen.getByRole('heading', { name: '计划.md' })).toBeVisible()
    expect(screen.queryByText('未保存')).not.toBeInTheDocument()

    rerender(
      <DocumentHeader
        dirty
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={renameOk()}
      />,
    )
    expect(screen.getByText('未保存')).toBeVisible()
  })

  it('keeps heading semantics and enters editing from a focused Enter key', () => {
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={renameOk()}
      />,
    )

    const heading = screen.getByRole('heading', { level: 1, name: '计划.md' })
    heading.focus()
    expect(heading).toHaveFocus()
    fireEvent.keyDown(heading, { key: 'Enter' })

    expect(screen.getByRole('textbox', { name: '修改文件名' })).toHaveFocus()
  })

  it('keeps one save slot while moving from pristine to dirty to saved', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync(
      path.join(process.cwd(), 'src/renderer/chrome/document-header.css'),
      'utf8',
    )
    document.head.append(style)
    const onSave = vi.fn()
    const SaveHeader = DocumentHeader as unknown as React.ComponentType<Record<string, unknown>>
    const props = {
      editorMode: 'visual',
      fileName: '计划.md',
      hasOriginal: true,
      onCommand: vi.fn(),
      onRename: renameOk(),
      onSave,
    }
    const { container, rerender } = render(
      <SaveHeader {...props} savePresentation="pristine" />,
    )
    const slot = container.querySelector('.document-save-controls')

    expect(slot).not.toBeNull()
    if (!slot || !style.sheet) throw new Error('document save styles did not load')
    expect(resolveCascadedValue(style.sheet, slot, 'margin-left')).toBe('8px')
    expect(resolveCascadedValue(style.sheet, slot, 'gap')).toBe('20px')
    expect(resolveCascadedValue(style.sheet, slot.parentElement!, 'gap')).toBe('4px')
    expect(slot).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()

    rerender(<SaveHeader {...props} savePresentation="dirty" />)
    expect(container.querySelector('.document-save-controls')).toBe(slot)
    expect(screen.getByText('未保存')).toBeVisible()
    const dirtySave = screen.getByRole('button', { name: '保存' })
    expect(dirtySave).toBeEnabled()
    fireEvent.click(dirtySave)
    expect(onSave).toHaveBeenCalledOnce()

    rerender(<SaveHeader {...props} savePresentation="saved" />)
    expect(container.querySelector('.document-save-controls')).toBe(slot)
    expect(screen.getByText('已保存')).toBeVisible()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    style.remove()
  })

  it('provides common formatting and view commands as icon buttons', () => {
    const onCommand = vi.fn()
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="未命名"
        hasOriginal={false}
        onCommand={onCommand}
        onRename={renameOk()}
      />,
    )

    const toolbar = screen.getByRole('toolbar', { name: '编辑工具栏' })
    const findButton = screen.getByRole('button', { name: '在文档中搜索' })
    const boldButton = screen.getByRole('button', { name: '加粗' })
    const orderedListButton = screen.getByRole('button', { name: '有序列表' })
    const bulletListButton = screen.getByRole('button', { name: '无序列表' })
    const modeButton = screen.getByRole('button', { name: '源码模式/渲染模式' })

    expect(toolbar.querySelectorAll('.toolbar-separator')).toHaveLength(2)
    expect(findButton.nextElementSibling).toHaveClass('toolbar-separator')
    expect(findButton.querySelector('.app-icon')).toBeInTheDocument()
    expect(boldButton.querySelector('img')).toHaveStyle({ width: '14px', height: '16px' })
    expect(orderedListButton.querySelector('img')).toHaveStyle({ width: '22px', height: '21px' })
    expect(bulletListButton.querySelector('img')).toHaveStyle({ width: '22px', height: '18px' })
    expect(modeButton).toHaveAttribute('data-tooltip', '源码模式/渲染模式')

    fireEvent.click(findButton)
    fireEvent.click(boldButton)
    fireEvent.click(screen.getByRole('button', { name: '无序列表' }))
    fireEvent.click(modeButton)

    expect(onCommand.mock.calls).toEqual([
      ['toggle-document-find'],
      ['strong'],
      ['unordered-list'],
      ['toggle-source-mode'],
    ])
  })

  it('allows empty document mode switching while content-dependent commands stay disabled', () => {
    const onCommand = vi.fn()
    const props = {
      dirty: false, fileName: '未命名', hasBodyContent: false, hasOriginal: false,
      onCommand, onRename: renameOk(), onToggleStickyNotes: vi.fn(),
    }
    const { rerender } = render(<DocumentHeader {...props} editorMode="visual" />)
    expect(screen.getByRole('button', { name: '在文档中搜索' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '加粗' })).toBeDisabled()
    const modeButton = screen.getByRole('button', { name: '源码模式/渲染模式' })
    expect(modeButton).toBeEnabled()
    fireEvent.click(modeButton)
    expect(onCommand).toHaveBeenCalledExactlyOnceWith('toggle-source-mode')
    rerender(<DocumentHeader {...props} editorMode="source" />)
    expect(modeButton).toBeEnabled()
    expect(modeButton).toHaveAttribute('aria-pressed', 'true')
    rerender(<DocumentHeader {...props} editorMode="source" codeDocument />)
    expect(modeButton).toBeDisabled()
    expect(screen.getByRole('button', { name: '便签盒子' })).toBeEnabled()
  })

  it('exposes code mode with theme-only foreground and an unchanged toggle command', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync(
      path.join(process.cwd(), 'src/renderer/chrome/document-header.css'),
      'utf8',
    )
    document.head.append(style)
    const onCommand = vi.fn()
    const view = render(
      <DocumentHeader
        dirty={false}
        editorMode="source"
        fileName="计划.md"
        hasOriginal
        onCommand={onCommand}
        onRename={renameOk()}
      />,
    )
    view.container.style.setProperty('--theme-color-rgb', '37 99 235')
    const modeButton = screen.getByRole('button', { name: '源码模式/渲染模式' })

    expect(modeButton).toHaveAttribute('aria-pressed', 'true')
    if (!style.sheet) throw new Error('document header stylesheet did not load')
    expect(resolveCascadedValue(style.sheet, modeButton, 'color'))
      .toBe('rgb(var(--theme-color-rgb, 198 40 40))')
    expect(resolveCascadedValue(style.sheet, modeButton, 'background'))
      .toBe('transparent')
    expect(getComputedStyle(modeButton).backgroundColor).toBe('rgba(0, 0, 0, 0)')

    view.rerender(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={onCommand}
        onRename={renameOk()}
      />,
    )

    expect(modeButton).toHaveAttribute('aria-pressed', 'false')
    expect(getComputedStyle(modeButton).color).toBe('rgb(101, 105, 113)')
    expect(getComputedStyle(modeButton).backgroundColor).toBe('rgba(0, 0, 0, 0)')

    fireEvent.click(modeButton)
    expect(onCommand).toHaveBeenLastCalledWith('toggle-source-mode')
    style.remove()
  })

  it('keeps the code-mode foreground themed while retaining the standard hover background', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync(
      path.join(process.cwd(), 'src/renderer/chrome/document-header.css'),
      'utf8',
    )
    document.head.append(style)
    render(
      <DocumentHeader
        dirty={false}
        editorMode="source"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={renameOk()}
      />,
    )
    const modeButton = screen.getByRole('button', { name: '源码模式/渲染模式' })
    if (!style.sheet) throw new Error('document header stylesheet did not load')

    expect(resolveCascadedValue(style.sheet, modeButton, 'color', { hover: true }))
      .toBe('rgb(var(--theme-color-rgb, 198 40 40))')
    expect(resolveCascadedValue(style.sheet, modeButton, 'background', { hover: true }))
      .toBe('rgb(240, 241, 243)')
    style.remove()
  })

  it('edits the file name inline and confirms it with Enter', async () => {
    const onRename = renameOk()
    render(
      <DocumentHeader
        dirty
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' })
    expect(input).toHaveValue('计划.md')
    expect(input).toHaveFocus()
    expect(input).toHaveProperty('selectionStart', 0)
    expect(input).toHaveProperty('selectionEnd', 2)

    fireEvent.change(input, { target: { value: '新计划.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('新计划.md'))
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('does not reselect and overwrite earlier characters during continuous typing', async () => {
    const user = userEvent.setup()
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={renameOk()}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' })
    await user.keyboard('新名称')

    expect(input).toHaveValue('新名称.md')
    expect(input).toHaveProperty('selectionStart', 3)
    expect(input).toHaveProperty('selectionEnd', 3)
  })

  it('cancels inline editing with Escape', () => {
    const onRename = renameOk()
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' })
    fireEvent.change(input, { target: { value: '不要保存.md' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: '计划.md' })).toBeVisible()
  })

  it('confirms inline editing once when the input loses focus', async () => {
    const onRename = renameOk()
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' })
    fireEvent.change(input, { target: { value: '失焦保存.md' } })
    fireEvent.blur(input)

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('失焦保存.md'))
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('suggests Markdown when editing an unsaved DOCX import name', () => {
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="report.docx"
        hasOriginal={false}
        onCommand={vi.fn()}
        onRename={renameOk()}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: 'report.docx' }))
    expect(screen.getByRole('textbox', { name: '修改文件名' }))
      .toHaveValue('report.md')
  })

  it('keeps an invalid Enter draft in edit mode and clears feedback on input', async () => {
    const onRename = renameOk()
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' })
    fireEvent.change(input, { target: { value: '计划:最终.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRename).not.toHaveBeenCalled()
    expect(input).toHaveValue('计划:最终.md')
    expect(input).toHaveFocus()
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent(
      'Windows系统文件名不能包含下列字符： \\\\ / : * ? " < > |',
    )
    expect(tooltip).toHaveAttribute('id')
    expect(input).toHaveAttribute('aria-describedby', tooltip.id)
    expect(input).toHaveAccessibleDescription(
      'Windows系统文件名不能包含下列字符： \\\\ / : * ? " < > |',
    )

    fireEvent.change(input, { target: { value: '计划最终.md' } })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '计划:最终.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('tooltip')).toHaveAttribute('id', tooltip.id)
  })

  it.each([
    { draft: '   ', expectedMessage: '文件名不能为空', hasOriginal: true },
    {
      draft: 'a'.repeat(253) + '.md',
      expectedMessage: '文件名不能超过 255 个字符',
      hasOriginal: true,
    },
    {
      draft: 'CON.md',
      expectedMessage: '文件名包含 Windows 不允许使用的字符或名称',
      hasOriginal: true,
    },
    {
      draft: '计划.',
      expectedMessage: '文件名不能以空格或句点结尾',
      hasOriginal: true,
    },
    {
      draft: 'report.docx',
      expectedMessage: '请选择 Arkdown 支持的文档扩展名',
      hasOriginal: false,
    },
  ])(
    'keeps the complete-validator failure $draft local and preserves its draft',
    ({ draft, expectedMessage, hasOriginal }) => {
      const onRename = vi.fn(() => new Promise<boolean>(() => undefined))
      render(
        <DocumentHeader
          dirty={false}
          editorMode="visual"
          fileName="计划.md"
          hasOriginal={hasOriginal}
          onCommand={vi.fn()}
          onRename={onRename}
        />,
      )

      fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
      const input = screen.getByRole('textbox', { name: '修改文件名' })
      fireEvent.change(input, { target: { value: draft } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).not.toHaveBeenCalled()
      expect(input).toHaveValue(draft)
      expect(input).toHaveFocus()
      expect(screen.getByRole('tooltip')).toHaveTextContent(expectedMessage)
      expect(screen.getByRole('textbox', { name: '修改文件名' })).toBe(input)
    },
  )

  it.each(['Enter', 'blur'] as const)(
    'keeps an exact trailing-space draft local after %s confirmation',
    async (confirmation) => {
      const onRename = renameOk()
      render(
        <DocumentHeader
          dirty={false}
          editorMode="visual"
          fileName="计划.md"
          hasOriginal
          onCommand={vi.fn()}
          onRename={onRename}
        />,
      )

      fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
      const input = screen.getByRole('textbox', { name: '修改文件名' })
      fireEvent.change(input, { target: { value: '计划.md ' } })
      if (confirmation === 'Enter') {
        fireEvent.keyDown(input, { key: 'Enter' })
      } else {
        input.blur()
      }

      await waitFor(() => expect(input).toHaveFocus())
      expect(onRename).not.toHaveBeenCalled()
      expect(input).toHaveValue('计划.md ')
      expect(screen.getByRole('textbox', { name: '修改文件名' })).toBe(input)
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        '文件名不能以空格或句点结尾',
      )
    },
  )

  it('preserves an invalid blur draft and restores focus without reselection', async () => {
    const onRename = renameOk()
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '计?划.md' } })
    input.setSelectionRange(2, 2)
    input.blur()

    await waitFor(() => expect(input).toHaveFocus())
    expect(onRename).not.toHaveBeenCalled()
    expect(input).toHaveValue('计?划.md')
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(2)
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Windows系统文件名不能包含下列字符： \\\\ / : * ? " < > |',
    )
  })

  it('keeps editing and restores focus when rename resolves false', async () => {
    const onRename = vi.fn(async () => false)
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' })
    fireEvent.change(input, { target: { value: '被拒绝.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('被拒绝.md'))
    await waitFor(() => expect(input).toHaveFocus())
    expect(input).toHaveValue('被拒绝.md')
    expect(screen.getByRole('textbox', { name: '修改文件名' })).toBe(input)
  })

  it('does not resubmit on blur while an Enter rename is pending', async () => {
    const rename = createDeferred<boolean>()
    const onRename = vi.fn(() => rename.promise)
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' })
    fireEvent.change(input, { target: { value: '异步保存.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledOnce()

    input.blur()
    expect(input).not.toHaveFocus()
    expect(onRename).toHaveBeenCalledOnce()

    rename.resolve(true)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '计划.md' })).toBeVisible()
    })
    expect(onRename).toHaveBeenCalledWith('异步保存.md')
  })

  it.each(STALE_RENAME_SETTLEMENTS)(
    'preserves a newer draft and external focus when an earlier rename %s',
    async (settlement) => {
      const earlierRename = createDeferred<boolean>()
      const newerRename = createDeferred<boolean>()
      const onRename = vi.fn((_fileName: string) => newerRename.promise)
      onRename.mockImplementationOnce(() => earlierRename.promise)
      render(
        <DocumentHeader
          dirty={false}
          editorMode="visual"
          fileName="计划.md"
          hasOriginal
          onCommand={vi.fn()}
          onRename={onRename}
        />,
      )

      fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
      const input = screen.getByRole('textbox', { name: '修改文件名' })
      fireEvent.change(input, { target: { value: '较早请求.md' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onRename).toHaveBeenCalledWith('较早请求.md')

      fireEvent.change(input, { target: { value: '当前草稿.md' } })
      const findButton = screen.getByRole('button', { name: '在文档中搜索' })
      findButton.focus()
      expect(findButton).toHaveFocus()
      expect(onRename).toHaveBeenCalledTimes(1)

      await act(async () => {
        if (settlement === 'resolve true') {
          earlierRename.resolve(true)
          await earlierRename.promise
        } else if (settlement === 'resolve false') {
          earlierRename.resolve(false)
          await earlierRename.promise
        } else {
          earlierRename.reject(new Error('earlier rename failed'))
          await earlierRename.promise.catch(() => undefined)
        }
      })

      expect(screen.getByRole('textbox', { name: '修改文件名' })).toBe(input)
      expect(input).toHaveValue('当前草稿.md')
      expect(findButton).toHaveFocus()
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

      input.focus()
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onRename).toHaveBeenCalledTimes(2)
      expect(onRename).toHaveBeenLastCalledWith('当前草稿.md')
    },
  )

  it.each(STALE_RENAME_SETTLEMENTS)(
    'keeps a fresh pending edit session locked when the prior session %s',
    async (settlement) => {
      const earlierRename = createDeferred<boolean>()
      const freshRename = createDeferred<boolean>()
      const onRename = vi.fn(async (_fileName: string) => false)
      onRename.mockImplementationOnce(() => earlierRename.promise)
      onRename.mockImplementationOnce(() => freshRename.promise)
      render(
        <DocumentHeader
          dirty={false}
          editorMode="visual"
          fileName="计划.md"
          hasOriginal
          onCommand={vi.fn()}
          onRename={onRename}
        />,
      )

      fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
      const earlierInput = screen.getByRole('textbox', { name: '修改文件名' })
      fireEvent.change(earlierInput, { target: { value: '较早会话.md' } })
      fireEvent.keyDown(earlierInput, { key: 'Enter' })
      expect(onRename).toHaveBeenCalledWith('较早会话.md')
      fireEvent.keyDown(earlierInput, { key: 'Escape' })

      fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
      const freshInput = screen.getByRole('textbox', { name: '修改文件名' })
      expect(freshInput).not.toBe(earlierInput)
      fireEvent.change(freshInput, { target: { value: '新会话.md' } })
      fireEvent.keyDown(freshInput, { key: 'Enter' })
      expect(onRename).toHaveBeenCalledTimes(2)
      expect(onRename).toHaveBeenLastCalledWith('新会话.md')

      const findButton = screen.getByRole('button', { name: '在文档中搜索' })
      findButton.focus()
      expect(findButton).toHaveFocus()

      await act(async () => {
        if (settlement === 'resolve true') {
          earlierRename.resolve(true)
          await earlierRename.promise
        } else if (settlement === 'resolve false') {
          earlierRename.resolve(false)
          await earlierRename.promise
        } else {
          earlierRename.reject(new Error('earlier session failed'))
          await earlierRename.promise.catch(() => undefined)
        }
      })

      expect(screen.getByRole('textbox', { name: '修改文件名' })).toBe(freshInput)
      expect(freshInput).toHaveValue('新会话.md')
      expect(findButton).toHaveFocus()
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

      freshInput.focus()
      fireEvent.keyDown(freshInput, { key: 'Enter' })
      expect(onRename).toHaveBeenCalledTimes(2)

      await act(async () => {
        freshRename.resolve(true)
        await freshRename.promise
      })
      expect(screen.getByRole('heading', { name: '计划.md' })).toBeVisible()
    },
  )

  it('keeps a fresh validation tooltip when an earlier session succeeds', async () => {
    const earlierRename = createDeferred<boolean>()
    const onRename = vi.fn(() => earlierRename.promise)
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const earlierInput = screen.getByRole('textbox', { name: '修改文件名' })
    fireEvent.change(earlierInput, { target: { value: '较早会话.md' } })
    fireEvent.keyDown(earlierInput, { key: 'Enter' })
    fireEvent.keyDown(earlierInput, { key: 'Escape' })

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const freshInput = screen.getByRole('textbox', { name: '修改文件名' })
    fireEvent.change(freshInput, { target: { value: '新会话?.md' } })
    fireEvent.keyDown(freshInput, { key: 'Enter' })
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent(
      'Windows系统文件名不能包含下列字符： \\\\ / : * ? " < > |',
    )

    await act(async () => {
      earlierRename.resolve(true)
      await earlierRename.promise
    })

    expect(screen.getByRole('textbox', { name: '修改文件名' })).toBe(freshInput)
    expect(freshInput).toHaveValue('新会话?.md')
    expect(freshInput).toHaveFocus()
    expect(screen.getByRole('tooltip')).toBe(tooltip)
  })

  it('restores focus and selection when a blur rename resolves false', async () => {
    const rename = createDeferred<boolean>()
    const onRename = vi.fn(() => rename.promise)
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '暂不保存.md' } })
    input.setSelectionRange(2, 4)
    input.blur()
    expect(input).not.toHaveFocus()
    expect(onRename).toHaveBeenCalledWith('暂不保存.md')

    rename.resolve(false)
    await waitFor(() => expect(input).toHaveFocus())
    expect(input).toHaveValue('暂不保存.md')
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(4)
    expect(screen.getByRole('textbox', { name: '修改文件名' })).toBe(input)
  })

  it('contains a rejected rename and restores blur focus without changing selection', async () => {
    const rename = createDeferred<boolean>()
    const onRename = vi.fn(() => rename.promise)
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={onRename}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '异常恢复.md' } })
    input.setSelectionRange(1, 3)
    input.blur()
    expect(input).not.toHaveFocus()
    expect(onRename).toHaveBeenCalledWith('异常恢复.md')

    rename.reject(new Error('rename failed'))
    await waitFor(() => expect(input).toHaveFocus())
    expect(input).toHaveValue('异常恢复.md')
    expect(input.selectionStart).toBe(1)
    expect(input.selectionEnd).toBe(3)
    expect(screen.getByRole('textbox', { name: '修改文件名' })).toBe(input)
  })

  it('clears local validation feedback on Escape and a fresh edit session', () => {
    render(
      <DocumentHeader
        dirty={false}
        editorMode="visual"
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={renameOk()}
      />,
    )

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    const input = screen.getByRole('textbox', { name: '修改文件名' })
    fireEvent.change(input, { target: { value: '计划|.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('tooltip')).toBeVisible()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('heading', { name: '计划.md' }))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
