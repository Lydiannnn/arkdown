import path from 'node:path'
import {
  copyBackgroundSettings,
  type BackgroundPresentation,
  type BackgroundSettings,
  type BackgroundTarget,
  type BackgroundApplyResult,
  type ObservedMainBackgroundSnapshot,
} from '../../shared/background-settings'
import type { StickyNoteDocument, StickyNoteRecord } from '../../shared/sticky-notes'
import type { MainBackgroundService } from './background-service'
import type { BackgroundImageUpdate } from './background-workflow'

const STATIC_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.svg'])

export interface BackgroundBackend {
  open?(target: BackgroundTarget): Promise<BackgroundPresentation & { observed?: ObservedMainBackgroundSnapshot }>
  get(target: BackgroundTarget): Promise<BackgroundPresentation>
  previewSource(target: BackgroundTarget, sourceAbsolutePath: string): Promise<string>
  apply(
    target: BackgroundTarget,
    settings: BackgroundSettings,
    imageUpdate: BackgroundImageUpdate,
    assertCurrent?: () => void,
    observed?: ObservedMainBackgroundSnapshot,
  ): Promise<BackgroundApplyResult & { observed?: ObservedMainBackgroundSnapshot }>
}

function requireMainTarget(target: BackgroundTarget): void {
  if (target.kind !== 'main') throw new Error('Invalid main background target')
}

function requireStickyTarget(target: BackgroundTarget): string {
  if (target.kind !== 'sticky-note') throw new Error('Invalid sticky-note background target')
  return target.noteId
}

export function createMainBackgroundBackend(
  service: Pick<MainBackgroundService, 'get' | 'open' | 'preview' | 'apply'>,
): BackgroundBackend {
  return {
    async open(target) {
      requireMainTarget(target)
      return service.open()
    },
    async get(target) {
      requireMainTarget(target)
      return await service.get()
    },
    async previewSource(target, sourceAbsolutePath) {
      requireMainTarget(target)
      return await service.preview(sourceAbsolutePath)
    },
    async apply(target, settings, imageUpdate, assertCurrent, observed) {
      requireMainTarget(target)
      return await service.apply(settings, imageUpdate, assertCurrent, observed)
    },
  }
}

interface StickyBackgroundService {
  read(noteId: string): Promise<StickyNoteDocument>
  resolveBackgroundImagePath(noteId: string): Promise<string | null>
  applyBackground(
    noteId: string,
    settings: BackgroundSettings,
    imageUpdate: BackgroundImageUpdate,
    assertCurrent?: () => void,
  ): Promise<StickyNoteRecord>
}

export function createStickyBackgroundBackend(
  notes: StickyBackgroundService,
  urlFor: (absolutePath: string) => Promise<string>,
): BackgroundBackend {
  const presentation = async (
    noteId: string,
    settings?: BackgroundSettings,
  ): Promise<BackgroundPresentation> => {
    const document = settings === undefined ? await notes.read(noteId) : undefined
    const resolvedSettings = settings ?? document!.record.background
    const absolutePath = await notes.resolveBackgroundImagePath(noteId)
    return {
      settings: copyBackgroundSettings(resolvedSettings),
      imageUrl: absolutePath === null ? null : await urlFor(absolutePath),
    }
  }

  return {
    get(target) {
      return presentation(requireStickyTarget(target))
    },
    async previewSource(target, sourceAbsolutePath) {
      requireStickyTarget(target)
      if (!STATIC_IMAGE_EXTENSIONS.has(path.extname(sourceAbsolutePath).toLowerCase())) {
        throw new Error('Background source must be a supported static image')
      }
      return urlFor(sourceAbsolutePath)
    },
    async apply(target, settings, imageUpdate, assertCurrent) {
      const noteId = requireStickyTarget(target)
      const record = await notes.applyBackground(noteId, settings, imageUpdate, assertCurrent)
      return presentation(noteId, record.background)
    },
  }
}
