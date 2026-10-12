import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { MenuCommand } from '../../shared/menu-commands'
import type { EditorMode } from '../editor/EditorPane'
import type { DocumentSavePresentation } from '../editor/document-save-presentation'
import {
  fileNameForHeaderEditing,
  hasInvalidWindowsFileNameCharacters,
  normalizeHeaderFileName,
} from '../../shared/document-header-file-name'
import { fileIconKindForPath } from '../../shared/file-icon-kind'
import { FileTypeIcon } from '../icons/FileTypeIcon'
import boldIcon from '../assets/context-menu/bold.png'
import italicIcon from '../assets/context-menu/italic.png'
import codeIcon from '../assets/context-menu/code.png'
import linkIcon from '../assets/context-menu/link.png'
import quoteIcon from '../assets/context-menu/quote.png'
import orderedListIcon from '../assets/context-menu/ordered-list.png'
import bulletListIcon from '../assets/context-menu/bullet-list.png'
import taskListIcon from '../assets/context-menu/task-list.png'
import { AppIcon } from '../icons/AppIcon'
import { StickyNoteBoxToggle } from './StickyNoteBoxToggle'
import './document-header.css'

interface ToolbarItem {
  command: MenuCommand
  label: string
  icon: string
  iconPixelSize: { width: number; height: number }
}

const TOOLBAR_ITEMS: readonly ToolbarItem[] = [
  { command: 'strong', label: '加粗', icon: boldIcon, iconPixelSize: { width: 14, height: 16 } },
  { command: 'emphasis', label: '斜体', icon: italicIcon, iconPixelSize: { width: 12, height: 17 } },
  { command: 'inline-code', label: '行内代码', icon: codeIcon, iconPixelSize: { width: 22, height: 20 } },
  { command: 'link', label: '链接', icon: linkIcon, iconPixelSize: { width: 22, height: 20 } },
  { command: 'blockquote', label: '引用', icon: quoteIcon, iconPixelSize: { width: 20, height: 15 } },
  { command: 'ordered-list', label: '有序列表', icon: orderedListIcon, iconPixelSize: { width: 22, height: 21 } },
  { command: 'unordered-list', label: '无序列表', icon: bulletListIcon, iconPixelSize: { width: 22, height: 18 } },
  { command: 'task-list', label: '任务列表', icon: taskListIcon, iconPixelSize: { width: 22, height: 22 } },
] as const

const INVALID_WINDOWS_FILE_NAME_TOOLTIP =
  'Windows系统文件名不能包含下列字符： \\\\ / : * ? " < > |'

export interface DocumentHeaderProps {
  /** @deprecated Use savePresentation. */
  dirty?: boolean
  editorMode?: EditorMode
  codeDocument?: boolean
  fileName: string
  hasBodyContent?: boolean
  hasOriginal: boolean
  onCommand(command: MenuCommand): void
  onRename(fileName: string): Promise<boolean>
  onSave?(): void
  onToggleRightSidebar?(): void
  onToggleStickyNotes?(): void
  rightSidebarOpen?: boolean
  stickyNotesOpen?: boolean
  savePresentation?: DocumentSavePresentation
}

interface RenameSubmission {
  draftGeneration: number
  draftName: string
  editSession: number
}

export function DocumentHeader({
  dirty = false,
  editorMode = 'visual',
  codeDocument = false,
  fileName,
  hasBodyContent = true,
  hasOriginal,
  onCommand,
  onRename,
  onSave,
  onToggleRightSidebar,
  onToggleStickyNotes,
  rightSidebarOpen = false,
  stickyNotesOpen = false,
  savePresentation = 'pristine',
}: DocumentHeaderProps) {
  const [editing, setEditing] = useState(false)
  const effectiveSavePresentation = savePresentation === 'pristine' && dirty
    ? 'dirty'
    : savePresentation
  const [draftName, setDraftName] = useState('')
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const validationTooltipId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const activeSubmissionRef = useRef<RenameSubmission | null>(null)
  const draftGenerationRef = useRef(0)
  const draftNameRef = useRef('')
  const editSessionRef = useRef(0)
  const initialSelectionPendingRef = useRef(false)

  useEffect(() => {
    if (!editing || !initialSelectionPendingRef.current) {
      return
    }
    initialSelectionPendingRef.current = false

    const input = inputRef.current
    if (!input) {
      return
    }

    input.focus()
    const extensionIndex = draftName.lastIndexOf('.')
    input.setSelectionRange(0, extensionIndex > 0 ? extensionIndex : draftName.length)
  }, [draftName, editing])

  const beginEditing = useCallback(() => {
    const nextDraftName = fileNameForHeaderEditing(fileName, hasOriginal)
    editSessionRef.current += 1
    draftGenerationRef.current += 1
    draftNameRef.current = nextDraftName
    activeSubmissionRef.current = null
    initialSelectionPendingRef.current = true
    setValidationMessage(null)
    setDraftName(nextDraftName)
    setEditing(true)
  }, [fileName, hasOriginal])

  const cancelEditing = useCallback(() => {
    editSessionRef.current += 1
    draftGenerationRef.current += 1
    activeSubmissionRef.current = null
    initialSelectionPendingRef.current = false
    setValidationMessage(null)
    setEditing(false)
  }, [])

  const restoreInputFocus = useCallback((submission: RenameSubmission) => {
    queueMicrotask(() => {
      if (
        editSessionRef.current !== submission.editSession
        || draftGenerationRef.current !== submission.draftGeneration
        || draftNameRef.current !== submission.draftName
      ) return
      inputRef.current?.focus()
    })
  }, [])

  const confirmEditing = useCallback(async () => {
    if (activeSubmissionRef.current) {
      return
    }

    initialSelectionPendingRef.current = false
    const submission: RenameSubmission = {
      draftGeneration: draftGenerationRef.current,
      draftName,
      editSession: editSessionRef.current,
    }
    const normalized = normalizeHeaderFileName(submission.draftName, fileName, hasOriginal)
    if (!normalized.ok) {
      setValidationMessage(
        hasInvalidWindowsFileNameCharacters(submission.draftName)
          ? INVALID_WINDOWS_FILE_NAME_TOOLTIP
          : normalized.message,
      )
      restoreInputFocus(submission)
      return
    }

    activeSubmissionRef.current = submission
    const isCurrentSubmission = () => (
      activeSubmissionRef.current === submission
      && editSessionRef.current === submission.editSession
      && draftGenerationRef.current === submission.draftGeneration
      && draftNameRef.current === submission.draftName
    )
    try {
      const renamed = await onRename(submission.draftName)
      if (!isCurrentSubmission()) return
      if (renamed) {
        setValidationMessage(null)
        setEditing(false)
      } else {
        restoreInputFocus(submission)
      }
    } catch {
      if (isCurrentSubmission()) restoreInputFocus(submission)
    } finally {
      if (activeSubmissionRef.current === submission) {
        activeSubmissionRef.current = null
      }
    }
  }, [draftName, fileName, hasOriginal, onRename, restoreInputFocus])

  return (
    <header className="document-header">
      <div className="document-identity">
        <FileTypeIcon className="document-icon" kind={fileIconKindForPath(fileName)} />
        {editing ? (
          <div className="document-file-name-editor">
            <input
              aria-describedby={validationMessage ? validationTooltipId : undefined}
              aria-invalid={validationMessage ? 'true' : undefined}
              aria-label="修改文件名"
              className="document-file-name-input"
              onBlur={() => void confirmEditing()}
              onChange={(event) => {
                draftGenerationRef.current += 1
                draftNameRef.current = event.target.value
                setValidationMessage(null)
                setDraftName(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void confirmEditing()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelEditing()
                }
              }}
              ref={inputRef}
              type="text"
              value={draftName}
            />
            {validationMessage && (
              <div
                className="document-file-name-tooltip"
                id={validationTooltipId}
                role="tooltip"
              >
                {validationMessage}
              </div>
            )}
          </div>
        ) : (
          <h1
            data-tooltip={fileName}
            onClick={beginEditing}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                beginEditing()
              }
            }}
            tabIndex={0}
          >
            {fileName}
          </h1>
        )}
        <div
          aria-hidden={effectiveSavePresentation === 'pristine' ? 'true' : undefined}
          className="document-save-controls"
          data-state={effectiveSavePresentation}
        >
          <span className="document-save-state">
            {effectiveSavePresentation === 'dirty' ? '未保存' : '已保存'}
          </span>
          <button
            aria-label="保存"
            className="document-save-button"
            data-tooltip="保存（Ctrl+S）"
            disabled={effectiveSavePresentation !== 'dirty'}
            onClick={onSave}
            tabIndex={effectiveSavePresentation === 'pristine' ? -1 : 0}
            type="button"
          >
            <AppIcon name="save" size={16} />
          </button>
        </div>
      </div>
      <div aria-label="编辑工具栏" className="document-toolbar" role="toolbar">
        <button
          aria-label="在文档中搜索"
          disabled={!hasBodyContent}
          onClick={() => onCommand('toggle-document-find')}
          data-tooltip="在文档中搜索（Ctrl+F）"
          type="button"
        >
          <AppIcon name="search" size={16} />
        </button>
        <span aria-hidden="true" className="toolbar-separator" />
        {TOOLBAR_ITEMS.map((item) => (
          <button
            aria-label={item.label}
            disabled={!hasBodyContent || codeDocument}
            key={item.command}
            onClick={() => onCommand(item.command)}
            data-tooltip={item.label}
            type="button"
          >
            <img
              alt=""
              aria-hidden="true"
              draggable={false}
              src={item.icon}
              style={{
                width: item.iconPixelSize.width / (window.devicePixelRatio || 1),
                height: item.iconPixelSize.height / (window.devicePixelRatio || 1),
              }}
            />
          </button>
        ))}
        <span aria-hidden="true" className="toolbar-separator" />
        <button
          aria-label="源码模式/渲染模式"
          aria-pressed={editorMode === 'source'}
          className="source-mode-toolbar-button"
          disabled={codeDocument}
          onClick={() => onCommand('toggle-source-mode')}
          data-tooltip="源码模式/渲染模式"
          type="button"
        >
          <span aria-hidden="true">&lt;/&gt;</span>
        </button>
        {onToggleStickyNotes && <>
          <span aria-hidden="true" className="toolbar-separator" />
          <StickyNoteBoxToggle open={stickyNotesOpen} onToggle={onToggleStickyNotes} />
        </>}
        {onToggleRightSidebar && <>
          <span aria-hidden="true" className="toolbar-separator" />
          <button
            aria-label={rightSidebarOpen ? '关闭右侧栏' : '打开右侧栏'}
            aria-pressed={rightSidebarOpen}
            className="right-sidebar-toolbar-button"
            data-tooltip={rightSidebarOpen ? '关闭右侧栏' : '打开右侧栏'}
            onClick={onToggleRightSidebar}
            type="button"
          >
            <AppIcon className="right-sidebar-toolbar-icon" name="sidebar" size={18} />
          </button>
        </>}
      </div>
    </header>
  )
}
