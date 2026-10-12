import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DocxService } from './docx/docx-service'
import type { DocumentService } from './documents/document-service'
import type { WorkspaceService } from './workspace/workspace-service'
import { documentTypeForPath, isEditableDocumentPath } from '../shared/document-types'
import { WINDOW_CHANNELS, type DocumentSnapshot } from '../shared/contracts'
import type { DocumentViewLocation } from '../shared/document-view'
import {
  appError,
  isPublicErrorCode,
  PublicError,
  PUBLIC_ERROR_MESSAGES,
} from '../shared/public-errors'

interface DocumentIntentWebContents {
  on(event: 'did-finish-load', listener: () => void): unknown
  on(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown
  on(event: 'render-process-gone', listener: (event: unknown, details: unknown) => void): unknown
  // Electron inherits Node's EventEmitter listener surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  send(channel: string, payload: unknown): void
}

export interface DocumentIntentWindow {
  readonly webContents: DocumentIntentWebContents
  once(event: 'closed', listener: () => void): unknown
  on(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
  isDestroyed(): boolean
  destroy(): void
  show(): void
  focus(): void
}

export interface DocumentWindowIntentOptions {
  window: DocumentIntentWindow
  absolutePath: string
  workspace: Pick<WorkspaceService, 'setRoot' | 'resolveExistingPandocDocument'>
  documents: Pick<DocumentService, 'read'>
  seedDocumentOwnership(snapshot: DocumentSnapshot): Promise<void>
  docx?: Pick<DocxService, 'import'>
  onImportedSourcePath?: (absolutePath: string) => void
}

export interface DocumentOpenFailureParticipant {
  kind: 'ordinary' | 'recent'
  handle(error: unknown): Promise<void>
}

export interface DocumentWindowOpener {
  (absolutePath: string, location?: DocumentViewLocation): Promise<void>
  withFailureOwner(
    absolutePath: string,
    participant: DocumentOpenFailureParticipant,
  ): Promise<void>
}

export function documentOpenErrorMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return isPublicErrorCode(code) ? PUBLIC_ERROR_MESSAGES[code]
    : error instanceof PublicError ? error.message : PUBLIC_ERROR_MESSAGES.OPERATION_FAILED
}

export async function showStartupDocumentOpenError(
  owner: Pick<DocumentIntentWindow, 'isDestroyed'>,
  error: unknown,
  actions: {
    showError(message: string): Promise<void>
    reportDialogError(error: unknown): void
  },
): Promise<void> {
  if (owner.isDestroyed()) return
  try {
    await actions.showError(
      documentOpenErrorMessage(error),
    )
  } catch (dialogError) {
    try {
      actions.reportDialogError(dialogError)
    } catch {
      // Error reporting must not turn a contained dialog failure into an unhandled rejection.
    }
  }
}

export function loadDocumentWindowIntentAfterReady(
  options: DocumentWindowIntentOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      options.window.removeListener('closed', onClosed)
      options.window.webContents.removeListener('did-finish-load', onReady)
      options.window.webContents.removeListener('did-fail-load', onFailed)
      options.window.webContents.removeListener('render-process-gone', onProcessGone)
    }
    const resolveOnce = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onClosed = () => {
      rejectOnce(new Error('Document window closed before loading completed'))
    }
    const onFailed = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame === false) return
      rejectOnce(new Error(`Document window failed to load (${errorCode}): ${errorDescription}`))
    }
    const onProcessGone = () => {
      rejectOnce(new Error('Document window render process exited before loading completed'))
    }
    const assertActive = () => {
      if (settled || options.window.isDestroyed()) {
        throw new Error('Document window is no longer available')
      }
    }
    const onReady = () => {
      options.window.webContents.removeListener('did-finish-load', onReady)
      void (async () => {
        const metadata = await stat(options.absolutePath)
        if (metadata.isDirectory()) {
          const workspace = await options.workspace.setRoot(options.absolutePath)
          assertActive()
          options.window.webContents.send(WINDOW_CHANNELS.openIntent, {
            workspace,
            document: null,
          })
          return
        }

        const workspace = await options.workspace.setRoot(path.dirname(options.absolutePath))
        const definition = documentTypeForPath(options.absolutePath)
        if (definition?.importWithPandoc) {
          if (!options.docx) throw new Error('DOCX import is unavailable')
          const source = await options.workspace.resolveExistingPandocDocument(
            path.basename(options.absolutePath),
          )
          const imported = await options.docx.import(source)
          assertActive()
          options.onImportedSourcePath?.(imported.sourceAbsolutePath)
          options.window.webContents.send(WINDOW_CHANNELS.importDocx, { workspace, imported })
          return
        }

        const document = await options.documents.read(path.basename(options.absolutePath))
        assertActive()
        await options.seedDocumentOwnership(document)
        assertActive()
        options.window.webContents.send(WINDOW_CHANNELS.openIntent, { workspace, document })
      })().then(resolveOnce, rejectOnce)
    }

    if (options.window.isDestroyed()) {
      rejectOnce(new Error('Document window is already destroyed'))
      return
    }
    options.window.on('closed', onClosed)
    options.window.webContents.on('did-finish-load', onReady)
    options.window.webContents.on('did-fail-load', onFailed)
    options.window.webContents.on('render-process-gone', onProcessGone)
  })
}

export function createDocumentWindowOpener(options: {
  getOpenWindows?(): readonly { window: DocumentIntentWindow; absolutePath: string | null }[]
  createWindow(absolutePath: string): {
    window: DocumentIntentWindow
    loaded: Promise<void>
  }
}): DocumentWindowOpener {
  interface OpenDocumentEntry {
    window: DocumentIntentWindow
    loaded: Promise<void>
    failureParticipants: DocumentOpenFailureParticipant[]
    failureHandling?: Promise<void>
    ready: boolean
  }
  const openDocuments = new Map<string, OpenDocumentEntry>()

  const removeParticipant = (
    entry: OpenDocumentEntry,
    participant: DocumentOpenFailureParticipant,
  ) => {
    const index = entry.failureParticipants.indexOf(participant)
    if (index >= 0) entry.failureParticipants.splice(index, 1)
  }

  const handleSharedFailure = (
    entry: OpenDocumentEntry,
    error: unknown,
  ): Promise<void> => {
    if (!entry.failureHandling) {
      const owner = entry.failureParticipants.find(({ kind }) => kind === 'recent')
        ?? entry.failureParticipants.find(({ kind }) => kind === 'ordinary')
      entry.failureHandling = owner
        ? Promise.resolve().then(() => owner.handle(error))
        : Promise.reject(error)
    }
    return entry.failureHandling
  }

  const waitForEntry = async (
    entry: OpenDocumentEntry,
    participant?: DocumentOpenFailureParticipant,
  ): Promise<void> => {
    try {
      await entry.loaded
    } catch (error) {
      if (!participant) throw error
      await handleSharedFailure(entry, error)
    } finally {
      if (participant) removeParticipant(entry, participant)
    }
  }

  const open = async (
    absolutePath: string,
    participant?: DocumentOpenFailureParticipant,
    registration?: { registered: boolean },
    location?: DocumentViewLocation,
  ): Promise<void> => {
    const canonical = await realpath(absolutePath)
    const metadata = await stat(canonical)
    if (!metadata.isDirectory()) {
      const definition = documentTypeForPath(canonical)
      if (!isEditableDocumentPath(canonical) && !definition?.importWithPandoc) {
        throw appError('UNSUPPORTED_FILE_TYPE')
      }
    }
    const key = path.normalize(canonical).toLocaleLowerCase('en-US')
    const reveal = (window: DocumentIntentWindow) => {
      if (location && (location.anchor || location.line)) {
        const current = options.getOpenWindows?.()
        if (current && !current.some(entry => entry.window === window && entry.absolutePath !== null
          && path.normalize(entry.absolutePath).toLocaleLowerCase('en-US') === key)) return
        window.webContents.send(WINDOW_CHANNELS.documentLocation, { absolutePath: canonical, ...location })
      }
    }
    const liveWindows = options.getOpenWindows?.()
    const live = liveWindows?.find(entry => !entry.window.isDestroyed()
      && entry.absolutePath !== null
      && path.normalize(entry.absolutePath).toLocaleLowerCase('en-US') === key)
    if (live) {
      reveal(live.window)
      live.window.show()
      live.window.focus()
      return
    }
    let existing = openDocuments.get(key)
    // Pending opens still share their one load/failure owner. After loading,
    // the window's current identity is authoritative, not its creation path.
    if (existing?.ready && liveWindows && !metadata.isDirectory()) {
      openDocuments.delete(key)
      existing = undefined
    }
    if (existing && !existing.window.isDestroyed()) {
      if (participant) {
        existing.failureParticipants.push(participant)
        if (registration) registration.registered = true
      }
      await waitForEntry(existing, participant)
      if (!existing.window.isDestroyed()) {
        reveal(existing.window)
        existing.window.show()
        existing.window.focus()
      }
      return
    }

    const { window, loaded } = options.createWindow(canonical)
    const entry: OpenDocumentEntry = {
      window,
      loaded: Promise.resolve(),
      failureParticipants: participant ? [participant] : [],
      ready: false,
    }
    if (participant && registration) registration.registered = true
    entry.loaded = loaded.then(() => { entry.ready = true }).catch((error: unknown) => {
      if (openDocuments.get(key) === entry) openDocuments.delete(key)
      if (!window.isDestroyed()) window.destroy()
      throw error
    })
    openDocuments.set(key, entry)
    window.once('closed', () => {
      if (openDocuments.get(key) === entry) openDocuments.delete(key)
    })
    await waitForEntry(entry, participant)
    if (!window.isDestroyed()) {
      reveal(window)
      window.show()
      window.focus()
    }
  }

  const opener = ((absolutePath: string, location?: DocumentViewLocation) => open(absolutePath, undefined, undefined, location)) as DocumentWindowOpener
  opener.withFailureOwner = async (absolutePath, participant) => {
    const registration = { registered: false }
    try {
      await open(absolutePath, participant, registration)
    } catch (error) {
      if (registration.registered) throw error
      await participant.handle(error)
    }
  }
  return opener
}

export async function openOrdinaryDocumentWithError(
  absolutePath: string,
  actions: {
    openDocumentInNewWindow: DocumentWindowOpener
    showError(message: string): Promise<void>
  },
): Promise<void> {
  await actions.openDocumentInNewWindow.withFailureOwner(absolutePath, {
    kind: 'ordinary',
    handle: async (error) => {
      await actions.showError(
        documentOpenErrorMessage(error),
      )
    },
  })
}
