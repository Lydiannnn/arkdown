import { useEffect, useMemo, useState } from 'react'
import { AppIcon } from '../icons/AppIcon'
import { extractOutline, outlineHasChildren, visibleOutlineItems } from '../workspace/workspace-navigation'
import './document-outline.css'
import { useKeyboardShortcuts } from '../settings/use-keyboard-shortcuts'
import { matchesShortcut, shortcutFor } from '../../shared/keyboard-shortcuts'

export function DocumentOutline({ markdown, documentKey }: { markdown: string; documentKey: string }) {
  const { snapshot } = useKeyboardShortcuts()
  const outline = useMemo(() => extractOutline(markdown), [markdown])
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  useEffect(() => { setOpen(false); setCollapsed(new Set()) }, [documentKey])
  useEffect(() => {
    if (!outline.length) setOpen(false)
    const shortcut = (event: KeyboardEvent) => {
      // Native routing owns Electron keys; replayed builtin keys must not be
      // interpreted as newly assigned application shortcuts here.
      if (window.arkdown?.onMenuCommand) return
      if (document.activeElement?.closest('.document-view-panel')) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (snapshot.revision < 0 && window.arkdown?.getKeyboardShortcuts) return
      if (matchesShortcut(event, 'document.outline', snapshot.bindings) && outline.length) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', shortcut)
    const detach = window.arkdown?.onMenuCommand?.(command => {
      if (command === 'toggle-document-outline' && outline.length && !document.activeElement?.closest('.document-view-panel') && !document.querySelector('[aria-modal="true"]')) setOpen(value => !value)
    })
    return () => { window.removeEventListener('keydown', shortcut); detach?.() }
  }, [outline.length, snapshot])
  if (!outline.length) return null
  return <div className="document-outline" data-open={open}>
    <button className="document-outline-trigger" aria-expanded={open} aria-controls="document-outline-content"
      data-tooltip={['大纲', shortcutFor('document.outline', snapshot.bindings)].filter(Boolean).join(' · ')}
      type="button" onClick={() => setOpen((value) => !value)}>
      <AppIcon name="outline" size={16} />大纲
    </button>
    {open && <nav id="document-outline-content" aria-label="文档大纲" className="document-outline-content"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); event.currentTarget.parentElement?.querySelector('button')?.focus() } }}>
      <ol className="outline-list">
        {visibleOutlineItems(outline, collapsed).map((item) => <li key={`${item.index}:${item.text}`}>
          <span className="outline-row" style={{ paddingLeft: 6 + (item.depth - 1) * 12 }}>
            {outlineHasChildren(outline, item.index)
              ? <button className="outline-toggle" aria-label={`${collapsed.has(item.index) ? '展开' : '折叠'} ${item.text}`}
                  aria-expanded={!collapsed.has(item.index)} type="button" onClick={() => setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(item.index)) next.delete(item.index); else next.add(item.index)
                    return next
                  })}><AppIcon name={collapsed.has(item.index) ? 'next' : 'find-next'} size={12} /></button>
              : <span className="outline-toggle-spacer" />}
            <button className="outline-heading" type="button" onClick={() => window.dispatchEvent(
              new CustomEvent('arkdown:navigate-heading', { detail: { index: item.index } }),
            )}>{item.text}</button>
          </span>
        </li>)}
      </ol>
    </nav>}
  </div>
}
