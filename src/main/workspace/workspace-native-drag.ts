import { createRequire } from 'node:module'
import { stickyNoteNativeSurfaceAddonPath } from '../sticky-notes/sticky-note-native-surface'

interface DragWindow {
  isDestroyed(): boolean
  getNativeWindowHandle(): Buffer
}
interface ShellDragAddon { startWorkspaceFileDrag(hwnd: bigint, absolutePath: string): unknown }

export function loadWorkspaceNativeDrag(options: Parameters<typeof stickyNoteNativeSurfaceAddonPath>[0]): unknown {
  const filename = stickyNoteNativeSurfaceAddonPath(options)
  return createRequire(filename)(filename)
}

/** Called after WorkspaceFileDrag validates ownership and the saved file identity. */
export async function prepareWorkspaceNativeDrag(window: DragWindow, absolutePath: string,
  load: () => unknown): Promise<() => void> {
  const addon = load()
  if (!addon || typeof addon !== 'object' || typeof (addon as ShellDragAddon).startWorkspaceFileDrag !== 'function') {
    throw new Error('Shell file drag is unavailable')
  }
  const native = addon as ShellDragAddon
  return () => {
    if (window.isDestroyed()) throw new Error('File drag owner is closed')
    const bytes = window.getNativeWindowHandle()
    if (bytes.length !== 8) throw new Error('File drag requires a Windows x64 window')
    // A cancellation or returned COPY/LINK effect is only the end of the native
    // drag loop; the target may still be working. No copy completion is claimed.
    native.startWorkspaceFileDrag(bytes.readBigUInt64LE(), absolutePath)
  }
}
