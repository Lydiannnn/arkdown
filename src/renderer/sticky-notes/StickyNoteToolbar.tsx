import { useState } from 'react'
import boldIcon from '../assets/context-menu/bold.png'
import italicIcon from '../assets/context-menu/italic.png'
import linkIcon from '../assets/context-menu/link.png'
import orderedListIcon from '../assets/context-menu/ordered-list.png'
import bulletListIcon from '../assets/context-menu/bullet-list.png'
import taskListIcon from '../assets/context-menu/task-list.png'
import { AppIcon } from '../icons/AppIcon'
import {
  dispatchStickyNoteEditorCommand,
  type StickyNoteToolbarCommand,
} from './sticky-note-editor-commands'

const ITEMS: readonly {
  command: StickyNoteToolbarCommand
  label: string
  icon: string
  size: { width: number; height: number }
}[] = [
  { command: 'strong', label: '加粗', icon: boldIcon, size: { width: 14, height: 16 } },
  { command: 'emphasis', label: '斜体', icon: italicIcon, size: { width: 12, height: 17 } },
  { command: 'link', label: '链接', icon: linkIcon, size: { width: 22, height: 20 } },
  { command: 'ordered-list', label: '有序列表', icon: orderedListIcon, size: { width: 22, height: 21 } },
  { command: 'unordered-list', label: '无序列表', icon: bulletListIcon, size: { width: 22, height: 18 } },
  { command: 'task-list', label: '任务列表', icon: taskListIcon, size: { width: 22, height: 22 } },
] as const

export function StickyNoteToolbar() {
  const [collapsed, setCollapsed] = useState(false)
  const ratio = window.devicePixelRatio || 1
  return (
    <div
      aria-label="便签格式工具栏"
      className="sticky-note-toolbar"
      data-collapsed={collapsed ? 'true' : 'false'}
      role="toolbar"
    >
      {!collapsed && ITEMS.map((item) => (
        <button
          aria-label={item.label}
          data-tooltip={item.label}
          key={item.command}
          onClick={() => dispatchStickyNoteEditorCommand(item.command)}
          type="button"
        >
          <img
            alt=""
            aria-hidden="true"
            draggable={false}
            src={item.icon}
            style={{
              width: item.size.width / ratio,
              height: item.size.height / ratio,
            }}
          />
        </button>
      ))}
      <button
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开工具栏' : '收起工具栏'}
        className="sticky-note-toolbar-toggle"
        data-tooltip={collapsed ? '展开工具栏' : '收起工具栏'}
        onClick={() => setCollapsed((current) => !current)}
        type="button"
      >
        <AppIcon
          name={collapsed ? 'toolbar-expand' : 'toolbar-collapse'}
          size={18}
          style={{ opacity: collapsed ? 0.9 : 1 }}
          weight="regular"
        />
      </button>
    </div>
  )
}
