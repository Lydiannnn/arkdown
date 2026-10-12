import {
  WINDOW_STATE_CHANGED_CHANNEL,
  type WindowControlAction,
  type WindowStateSnapshot,
} from '../shared/contracts'

const WINDOW_STATE_EVENTS = [
  'maximize',
  'unmaximize',
  'enter-full-screen',
  'leave-full-screen',
] as const

type WindowStateEvent = (typeof WINDOW_STATE_EVENTS)[number]

const WM_NCLBUTTONDBLCLK = 0x00a3
const WM_NCLBUTTONDOWN = 0x00a1
const HTCLIENT = 0x01
const HTCAPTION = 0x02
const TITLEBAR_DOUBLE_CLICK_INTERVAL_MS = 500
const TITLEBAR_DOUBLE_CLICK_DISTANCE = 8

function isFullscreenTitlebarDoubleClick(hitTest: number): boolean {
  return hitTest === HTCLIENT || hitTest === HTCAPTION
}

interface NativeTitlebarPress {
  at: number
  hitTest: number
  x: number | null
  y: number | null
}

function readNativePoint(lParam: Buffer): Pick<NativeTitlebarPress, 'x' | 'y'> {
  if (lParam.length < 4) return { x: null, y: null }
  return { x: lParam.readInt16LE(0), y: lParam.readInt16LE(2) }
}

function isRepeatedTitlebarPress(previous: NativeTitlebarPress, current: NativeTitlebarPress): boolean {
  if (
    current.at < previous.at
    || current.at - previous.at > TITLEBAR_DOUBLE_CLICK_INTERVAL_MS
    || current.hitTest !== previous.hitTest
  ) return false
  if (
    previous.x === null
    || previous.y === null
    || current.x === null
    || current.y === null
  ) return true
  return Math.abs(current.x - previous.x) <= TITLEBAR_DOUBLE_CLICK_DISTANCE
    && Math.abs(current.y - previous.y) <= TITLEBAR_DOUBLE_CLICK_DISTANCE
}

export interface WindowStateWebContents {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

export interface WindowStateEventTarget {
  readonly webContents: WindowStateWebContents
  isDestroyed(): boolean
  isFullScreen(): boolean
  isMaximized(): boolean
  close(): void
  maximize(): void
  minimize(): void
  setFullScreen(fullscreen: boolean): void
  unmaximize(): void
  hookWindowMessage?(
    message: number,
    callback: (wParam: Buffer, lParam: Buffer) => Buffer | null | void,
  ): void
  unhookWindowMessage?(message: number): void
  on(event: WindowStateEvent, listener: () => void): unknown
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: WindowStateEvent | 'closed', listener: () => void): unknown
}

export class WindowStateCoordinator {
  private snapshot: WindowStateSnapshot
  private disposed = false
  private fullscreenIntent: boolean | null = null
  private lastNativeTitlebarPress: NativeTitlebarPress | null = null
  private readonly nativeTitlebarDoubleClick = (wParam: Buffer): Buffer | void => {
    if (wParam.length < 4 || !isFullscreenTitlebarDoubleClick(wParam.readUInt32LE(0))) return
    this.lastNativeTitlebarPress = null
    this.requestFullscreen(!this.snapshot.fullscreen)
    return Buffer.alloc(8)
  }
  private readonly nativeTitlebarPress = (wParam: Buffer, lParam: Buffer): void => {
    if (wParam.length < 4) return
    const hitTest = wParam.readUInt32LE(0)
    if (!isFullscreenTitlebarDoubleClick(hitTest)) {
      this.lastNativeTitlebarPress = null
      return
    }
    const current = { at: Date.now(), hitTest, ...readNativePoint(lParam) }
    const previous = this.lastNativeTitlebarPress
    this.lastNativeTitlebarPress = current
    if (!previous || !isRepeatedTitlebarPress(previous, current)) return
    this.lastNativeTitlebarPress = null
    this.requestFullscreen(!this.snapshot.fullscreen)
  }
  private readonly nativeStateListeners: Record<WindowStateEvent, () => void> = {
    maximize: () => this.handleNativeMaximize(),
    unmaximize: () => {
      if (this.fullscreenIntent === null) this.confirmNativeState({ maximized: false })
    },
    'enter-full-screen': () => this.confirmFullscreenState(true),
    'leave-full-screen': () => this.confirmFullscreenState(false),
  }

  constructor(
    private readonly window: WindowStateEventTarget,
    private readonly onStateChanged: (snapshot: WindowStateSnapshot) => void,
  ) {
    this.snapshot = Object.freeze({
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
      revision: 0,
    })
    for (const event of WINDOW_STATE_EVENTS) {
      window.on(event, this.nativeStateListeners[event])
    }
    window.hookWindowMessage?.(WM_NCLBUTTONDOWN, this.nativeTitlebarPress)
    window.hookWindowMessage?.(WM_NCLBUTTONDBLCLK, this.nativeTitlebarDoubleClick)
    window.once('closed', this.dispose)
    window.webContents.once('destroyed', this.dispose)
  }

  getSnapshot = (): WindowStateSnapshot => this.snapshot

  controlWindow = (action: WindowControlAction): WindowStateSnapshot => {
    if (this.disposed || this.window.isDestroyed()) return this.snapshot
    if (action === 'minimize') {
      this.window.minimize()
    } else if (action === 'toggle-maximize' || action === 'toggle-fullscreen') {
      this.requestFullscreen(!this.snapshot.fullscreen)
    } else if (action === 'exit-fullscreen') {
      if (this.snapshot.fullscreen) this.requestFullscreen(false)
    } else {
      this.window.close()
    }
    return this.snapshot
  }

  private requestFullscreen(target: boolean, normalizeMaximized = false): void {
    if (
      this.fullscreenIntent !== null
      || target === this.snapshot.fullscreen
      || this.disposed
      || this.window.isDestroyed()
    ) return
    this.fullscreenIntent = target
    if (normalizeMaximized || (target && this.snapshot.maximized)) {
      this.window.unmaximize()
    }
    this.window.setFullScreen(target)
  }

  private handleNativeMaximize(): void {
    if (this.disposed || this.window.isDestroyed()) return
    if (this.fullscreenIntent !== null) {
      this.window.unmaximize()
      return
    }
    this.requestFullscreen(!this.snapshot.fullscreen, true)
  }

  private confirmFullscreenState(fullscreen: boolean): void {
    this.fullscreenIntent = null
    this.confirmNativeState({ maximized: false, fullscreen })
  }

  dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    for (const event of WINDOW_STATE_EVENTS) {
      this.window.removeListener(event, this.nativeStateListeners[event])
    }
    if (!this.window.isDestroyed()) {
      this.window.unhookWindowMessage?.(WM_NCLBUTTONDOWN)
      this.window.unhookWindowMessage?.(WM_NCLBUTTONDBLCLK)
    }
    this.window.removeListener('closed', this.dispose)
    this.window.webContents.removeListener('destroyed', this.dispose)
  }

  private confirmNativeState(confirmed: Partial<Pick<WindowStateSnapshot, 'maximized' | 'fullscreen'>>): void {
    if (
      this.disposed
      || this.window.isDestroyed()
      || this.window.webContents.isDestroyed()
    ) return
    const maximized = confirmed.maximized ?? this.window.isMaximized()
    const fullscreen = confirmed.fullscreen ?? this.window.isFullScreen()
    if (
      maximized === this.snapshot.maximized
      && fullscreen === this.snapshot.fullscreen
    ) return
    const snapshot = Object.freeze({
      maximized,
      fullscreen,
      revision: this.snapshot.revision + 1,
    })
    this.snapshot = snapshot
    this.onStateChanged(snapshot)
    if (
      this.disposed
      || this.window.isDestroyed()
      || this.window.webContents.isDestroyed()
    ) return
    this.window.webContents.send(WINDOW_STATE_CHANGED_CHANNEL, snapshot)
  }
}
