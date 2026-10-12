import { createRoot } from 'react-dom/client'
import type { ArkdownApi } from '../../../src/shared/contracts'
import type { MenuCommand } from '../../../src/shared/menu-commands'
import { DEFAULT_EDITOR_APPEARANCE } from '../../../src/shared/editor-appearance-preferences'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../../src/shared/large-model-settings'
import { DEFAULT_LAYOUT_PREFERENCES } from '../../../src/shared/layout-preferences'
import type { PublicPreferenceSnapshot } from '../../../src/shared/preference-observation'
import { modelObservation } from '../../helpers/model-observation'
import { buildApplicationMenuModel, DEFAULT_APPLICATION_MENU_RUNTIME_STATE, type ApplicationMenuItem } from '../../../src/shared/application-menu-model'
import { stickyNoteApiStubs } from '../../renderer/sticky-note-api-stubs'
import { applicationMenuApiStubs } from '../../renderer/application-menu-api-stubs'
import { App } from '../../../src/renderer/app/App'
import '../../../src/renderer/app/styles.css'

history.replaceState(null, '', location.pathname + '?startup=guide')
let command: ((value: MenuCommand) => void) | undefined
const menu = buildApplicationMenuModel(DEFAULT_APPLICATION_MENU_RUNTIME_STATE)
const findItem = (items: readonly ApplicationMenuItem[], id: string): ApplicationMenuItem | undefined => {
  for (const item of items) {
    if (item.id === id) return item
    if (item.kind === 'submenu') { const found = findItem(item.items, id); if (found) return found }
  }
}
const success = <T,>(value: T) => ({ ok: true as const, value })
const unavailable = async () => ({ ok: false as const, error: { code: 'OPERATION_FAILED', message: '此预览未连接本地服务' } })
let introductionClaimed = false
let appearance = { ...DEFAULT_EDITOR_APPEARANCE }
let preferenceRevision = 0
let layout = { ...DEFAULT_LAYOUT_PREFERENCES }
const api: Partial<ArkdownApi> = {
  ...stickyNoteApiStubs, ...applicationMenuApiStubs,
  getEditorAppearancePreferences: async () => success({ appearance, revision: preferenceRevision }),
  setEditorAppearancePreferences: async (value) => {
    appearance = value
    return success({ appearance, revision: ++preferenceRevision })
  },
  getPreferenceSnapshot: async group => {
    const search = group === 'search' ? await api.getSearchPreferences?.() : undefined
    const values = group === 'appearance' ? appearance : group === 'layout' ? layout
      : group === 'search' ? search?.ok ? search.value : { provider: 'bing', customTemplate: '' } : null
    if (!values) return unavailable()
    return success(structuredClone({ group, values, observation: {
      version: 1, revision: preferenceRevision, minimumBaseRevision: 0, fields: {},
    } }) as PublicPreferenceSnapshot)
  },
  patchPreferences: async ({ observed, changes }) => {
    if (observed.group === 'appearance') appearance = { ...appearance, ...changes } as typeof appearance
    else if (observed.group === 'layout') layout = { ...layout, ...changes } as typeof layout
    else return unavailable()
    preferenceRevision += 1
    const result = await api.getPreferenceSnapshot!(observed.group)
    if (!result.ok) return result
    if (result.value.group === 'appearance') return success({ status: 'committed' as const, snapshot: result.value })
    if (result.value.group === 'layout') return success({ status: 'committed' as const, snapshot: result.value })
    return unavailable()
  },
  getLargeModelSettings: async () => success(DEFAULT_LARGE_MODEL_SETTINGS),
  getModelSettingsSnapshot: async () => success(modelObservation(DEFAULT_LARGE_MODEL_SETTINGS)),
  getKeyboardShortcuts: async () => success({ bindings: {}, revision: 0,
    observation: { version: 1, minimumBaseRevision: 0, fields: {} } }),
  claimWorkspaceIntroduction: async legacySeen => {
    const showIntroduction = !introductionClaimed && !legacySeen
    introductionClaimed = true
    return success({ showIntroduction })
  },
  chooseWorkspace: async () => success({ name: '我的文档', absolutePath: 'C:/Preview/Notes' }),
  restoreWorkspace: async () => success(null),
  inspectDroppedPath: async (absolutePath) => absolutePath.replaceAll('\\', '/') === 'C:/Preview/Notes/我的笔记.md'
    ? success({ kind: 'file' as const, absolutePath }) : unavailable(),
  listDirectory: async (relativePath) => success(relativePath ? [] : [{ kind: 'document', name: '我的笔记.md', relativePath: '我的笔记.md' }, { kind: 'directory', name: '资料', relativePath: '资料' }]),
  readDocument: async () => success({ relativePath: '我的笔记.md', markdown: '# 我的笔记\n\n编辑这篇文档。', revision: 'a'.repeat(64), encoding: 'utf8', newline: 'lf', mtimeMs: 1 }),
  saveDraft: async (input) => success({ draftId: input.draftId, originalAbsolutePath: null,
    workspaceAbsolutePath: null, originalRevision: null, originalMtimeMs: null, encoding: input.encoding,
    newline: input.newline, updatedAt: new Date().toISOString(), ignoredAt: null }),
  discardDraft: async () => success(null),
  beginSaveDocumentAs: async () => success(null),
  onMenuCommand: (handler) => { command = handler; return () => { command = undefined } },
  executeApplicationMenuItem: async (id) => {
    const item = findItem(menu.flatMap(section => [...section.items]), id)
    if (item && 'command' in item) command?.(item.command)
    return success(null)
  },
}
window.arkdown = new Proxy(api, { get(target, key: keyof ArkdownApi) {
  if (key in target) return target[key]
  return String(key).startsWith('on') ? () => () => undefined : unavailable
} }) as ArkdownApi
createRoot(document.getElementById('root')!).render(<App />)
