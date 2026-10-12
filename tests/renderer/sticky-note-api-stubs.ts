import type { ArkdownApi } from '../../src/shared/contracts'
import { DEFAULT_STICKY_NOTE_PREFERENCES, copyStickyNotePreferences } from '../../src/shared/sticky-note-preferences'
import { DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES } from '../../src/shared/desktop-lifecycle-preferences'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

type StickyNoteApiKey =
  | 'listStickyNotes'
  | 'searchStickyNotes'
  | 'readStickyNote'
  | 'createStickyNote'
  | 'renameStickyNote'
  | 'archiveStickyNote'
  | 'restoreStickyNote'
  | 'restoreArchivedStickyNotes'
  | 'deleteStickyNote'
  | 'deleteArchivedStickyNotes'
  | 'importStickyNote'
  | 'stageStickyNoteSave'
  | 'flushStickyNoteSave'
  | 'openStickyNote'
  | 'closeStickyNote'
  | 'releaseStickyNote'
  | 'reclaimStickyNote'
  | 'setStickyNotePinned'
  | 'setStickyNoteStyle'
  | 'resizeStickyNoteToContent'
  | 'onStickyNoteEvent'
  | 'getStickyNotePreferences'
  | 'setStickyNotePreferences'
  | 'getDesktopLifecyclePreferences'
  | 'setDesktopLifecyclePreferences'
  | 'openBackgroundSettings'
  | 'getBackgroundPresentation'
  | 'chooseBackgroundImage'
  | 'removeBackgroundImage'
  | 'previewBackground'
  | 'applyBackground'
  | 'cancelBackgroundSettings'
  | 'onBackgroundPresentation'

const unavailable = async () => ({
  ok: false as const,
  error: {
    code: 'OPERATION_FAILED' as const,
    message: '测试未配置便签服务',
  },
})

export const stickyNoteApiStubs = {
  listStickyNotes: unavailable,
  searchStickyNotes: unavailable,
  readStickyNote: unavailable,
  createStickyNote: unavailable,
  renameStickyNote: unavailable,
  archiveStickyNote: unavailable,
  restoreStickyNote: unavailable,
  restoreArchivedStickyNotes: unavailable,
  deleteStickyNote: unavailable,
  deleteArchivedStickyNotes: unavailable,
  importStickyNote: unavailable,
  stageStickyNoteSave: unavailable,
  flushStickyNoteSave: unavailable,
  openStickyNote: unavailable,
  closeStickyNote: unavailable,
  releaseStickyNote: unavailable,
  reclaimStickyNote: unavailable,
  setStickyNotePinned: unavailable,
  setStickyNoteStyle: unavailable,
  resizeStickyNoteToContent: unavailable,
  onStickyNoteEvent: () => () => undefined,
  getStickyNotePreferences: async () => ({
    ok: true as const,
    value: copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES),
  }),
  setStickyNotePreferences: async (preferences) => ({
    ok: true as const,
    value: copyStickyNotePreferences(preferences),
  }),
  getDesktopLifecyclePreferences: async () => ({
    ok: true as const,
    value: { ...DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES },
  }),
  setDesktopLifecyclePreferences: async (preferences) => ({
    ok: true as const,
    value: { ...preferences },
  }),
  openBackgroundSettings: async () => ({ ok: true as const, value: null }),
  getBackgroundPresentation: async () => ({
    ok: true as const,
    value: { imageUrl: null, settings: { ...DEFAULT_BACKGROUND_SETTINGS } },
  }),
  chooseBackgroundImage: async () => ({ ok: true as const, value: null }),
  removeBackgroundImage: async () => ({
    ok: true as const,
    value: { imageUrl: null, settings: { ...DEFAULT_BACKGROUND_SETTINGS } },
  }),
  previewBackground: async () => ({ ok: true as const, value: null }),
  applyBackground: async () => ({
    ok: true as const,
    value: { imageUrl: null, settings: { ...DEFAULT_BACKGROUND_SETTINGS } },
  }),
  cancelBackgroundSettings: async () => ({ ok: true as const, value: null }),
  onBackgroundPresentation: () => () => undefined,
} satisfies Pick<ArkdownApi, StickyNoteApiKey>
