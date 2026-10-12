import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppTitleBar } from '../../../src/renderer/chrome/AppTitleBar'
import { DocumentHeader } from '../../../src/renderer/chrome/DocumentHeader'
import { TooltipProvider } from '../../../src/renderer/tooltip/TooltipProvider'
import { ContextWorkspaceSidebar } from '../../../src/renderer/workspace/ContextWorkspaceSidebar'
import type { ContextWorkspaceSidebarProps } from '../../../src/renderer/workspace/ContextWorkspaceSidebar'
import '../../../src/renderer/app/styles.css'

const entries = Array.from({ length: 60 }, (_, i) => ({ name: `note-${i}.md`, relativePath: `note-${i}.md`, kind: 'document' as const }))
const listDirectory: ContextWorkspaceSidebarProps['listDirectory'] = async () => ({ ok: true, value: entries })
const readDocument: ContextWorkspaceSidebarProps['readDocument'] = async (relativePath) => ({ ok: true, value: { relativePath, markdown: '# Saved document', revision: 'fixture', encoding: 'utf8', newline: 'lf', mtimeMs: 0 } })
function Fixture() {
  const [visible, setVisible] = useState(true)
  const [current, setCurrent] = useState('note-0.md')
  return <div className={`app-shell${visible ? '' : ' sidebar-collapsed'}`}>
    <AppTitleBar windowState={{ fullscreen: false, maximized: false, revision: 0 }} onExecuteItem={() => {}}
      sidebarVisible={visible} onToggleSidebar={() => setVisible(!visible)} />
    <ContextWorkspaceSidebar workspace={{ name: 'Notes', absolutePath: 'C:/Notes' }} workspaceError={null}
      chooseWorkspace={async () => {}} isChoosing={false} currentDocument={current} markdown={'# Saved document'}
      listDirectory={listDirectory} readDocument={readDocument} refreshVersion={0} onOpenDocument={setCurrent}
      onCreateDocument={async () => true} onReloadDocument={() => {}} onRevealDocument={() => {}}
      onTrashDocument={() => {}} onWorkspaceMenuCommand={async () => {}} />
    <div className="sidebar-resizer" />
    <main className="editor-host">
      <DocumentHeader fileName={current} hasOriginal onCommand={() => {}} onRename={async () => true} />
      <textarea aria-label="Document content" defaultValue="Retained document draft" />
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<TooltipProvider><Fixture /></TooltipProvider>)
