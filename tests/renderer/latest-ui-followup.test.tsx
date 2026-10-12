import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  EMPTY_SESSION,
  documentSessionReducer,
} from '../../src/renderer/editor/document-session'
import { FileTypeIcon } from '../../src/renderer/icons/FileTypeIcon'
import { ContextWorkspaceSidebar } from '../../src/renderer/workspace/ContextWorkspaceSidebar'

const readCss = (relativePath: string) => readFileSync(
  path.join(process.cwd(), relativePath),
  'utf8',
)

function renderSidebar() {
  return render(
    <ContextWorkspaceSidebar
      chooseWorkspace={vi.fn(async () => undefined)}
      currentDocument={null}
      isChoosing={false}
      listDirectory={vi.fn(async () => ({
        ok: true as const,
        value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }],
      }))}
      markdown="# Heading"
      onCreateDocument={vi.fn(async () => true)}
      onOpenDocument={vi.fn()}
      onReloadDocument={vi.fn()}
      onRevealDocument={vi.fn()}
      onTrashDocument={vi.fn()}
      onWorkspaceMenuCommand={vi.fn(async () => undefined)}
      readDocument={vi.fn()}
      refreshVersion={0}
      workspace={{ name: 'Notes', absolutePath: 'C:\\Notes' }}
      workspaceError={null}
    />,
  )
}

it('preserves the Files scroll position across workspace search', async () => {
  const { container } = renderSidebar()
  await screen.findByRole('button', { name: 'note.md' })

  const files = container.querySelector<HTMLElement>('.workspace-tree-context')
  expect(files).not.toBeNull()
  files!.scrollTop = 144
  fireEvent.scroll(files!)

  expect(container.querySelector('.sidebar-tabs')).toBeNull()
  expect(container.querySelector<HTMLElement>('.workspace-tree-context')).toBe(files)
  expect(files!.scrollTop).toBe(144)

  const search = container.querySelector<HTMLButtonElement>('.workspace-actions button')
  fireEvent.click(search!)
  fireEvent.click(search!)
  expect(container.querySelector<HTMLElement>('.workspace-tree-context')?.scrollTop).toBe(144)
})

it('uses independent sidebar content scrollers and the requested scrollbar contract', () => {
  const app = readCss('src/renderer/app/styles.css')
  const sidebar = readCss('src/renderer/workspace/workspace-sidebar.css')
  const tree = readCss('src/renderer/workspace/workspace-context-menu.css')

  expect(app).toMatch(/\.sidebar\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s)
  expect(tree).toMatch(/\.workspace-tree-context\s*\{[^}]*flex:\s*1[^}]*height:\s*auto/s)
  expect(sidebar).toMatch(/\.workspace-documents,[\s\S]*\.workspace-outline,[\s\S]*\.workspace-search\s*\{[^}]*overflow:\s*auto/s)
  expect(app).toContain('width: 12px')
  expect(app).toContain('height: 12px')
  expect(app).toContain('rgb(0 0 0 / 10%)')
  expect(app).toContain('rgb(0 0 0 / 20%)')
})

it('uses distinct closed and open folder art at seventy percent opacity', () => {
  const { rerender } = render(<FileTypeIcon kind="folder" />)
  const closed = screen.getByTestId('file-type-icon')
  expect(closed.getAttribute('src')).toContain('folder-closed-22px.png')

  rerender(<FileTypeIcon folderOpen kind="folder" />)
  expect(screen.getByTestId('file-type-icon').getAttribute('src'))
    .toContain('folder-open-22px.png')
  expect(readCss('src/renderer/icons/file-type-icon.css'))
    .toMatch(/\.file-type-icon--folder\s*\{[^}]*opacity:\s*\.7/s)
})

it('keeps the workspace source path for an imported DOCX selection', () => {
  const imported = documentSessionReducer(EMPTY_SESSION, {
    type: 'imported',
    sourceRelativePath: 'reports/report.docx',
    imported: {
      sourceAbsolutePath: 'C:\\Notes\\reports\\report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  })

  expect(imported.sourceRelativePath).toBe('reports/report.docx')
  expect(readFileSync(
    path.join(process.cwd(), 'src/renderer/app/App.tsx'),
    'utf8',
  )).toContain(
    'openingDocumentPath ?? session.state.sourceRelativePath ?? session.state.relativePath',
  )
})

it('applies the requested header, find field, and opaque neutral tooltip polish', () => {
  const header = readCss('src/renderer/chrome/document-header.css')
  const find = readCss('src/renderer/editor/document-find-bar.css')
  const tooltip = readCss('src/renderer/tooltip/tooltip.css')

  expect(header).toMatch(/\.document-identity\s*\{[^}]*gap:\s*4px/s)
  expect(header).toMatch(
    /\.document-identity h1\s*\{[^}]*color:\s*rgb\(0 0 0 \/ 90%\)[^}]*font-weight:\s*var\(--ui-font-weight-normal\)/s,
  )
  expect(find).toMatch(/\.document-find-bar input\s*\{[^}]*font-size:\s*13px/s)
  expect(tooltip).toMatch(/:where\(\.global-tooltip,\s*\.ai-quote-tooltip,\s*\.document-file-name-tooltip\)\s*\{[^}]*border:\s*1px solid #e6e6e6/s)
  expect(tooltip).toMatch(/:where\(\.global-tooltip,\s*\.ai-quote-tooltip,\s*\.document-file-name-tooltip\)\s*\{[^}]*background:\s*#fff/s)
  expect(tooltip).not.toContain('var(--theme-color-rgb')
})

it('restores an imported DOCX source path through the session hook boundary', async () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/renderer/editor/use-document-session.ts'),
    'utf8',
  )
  expect(source).toContain(
    "apply({ type: 'imported', imported: result.value, sourceRelativePath: relativePath })",
  )
})
