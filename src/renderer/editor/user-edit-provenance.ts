import { Plugin } from '@milkdown/kit/prose/state'

const USER_INTENT_EVENTS = [
  'beforeinput',
  'input',
  'paste',
  'drop',
  'cut',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mousemove',
  'mouseup',
  'click',
  'keydown',
  'compositionstart',
  'compositionupdate',
  'compositionend',
] as const

const COMPOSITION_INTENT_TIMEOUT_MS = 5_000
const DOM_INTENT_TIMEOUT_MS = 50
const DOM_BACKED_INTENT_EVENTS = new Set([
  'beforeinput',
  'input',
  'paste',
  'drop',
  'cut',
])

function isDeferredDomKeyIntent(event: Event): boolean {
  return event.type === 'keydown'
    && event instanceof KeyboardEvent
    && (event.key === 'Delete' || event.key === 'Backspace')
}

export interface UserEditProvenance {
  plugin: Plugin<null>
  attach(root: HTMLElement): () => void
  hasPending(): boolean
  isComposing(): boolean
  needsSynchronousCheckpoint(): boolean
  consumePending(): void
  destroy(): void
}

export function createUserEditProvenance(): UserEditProvenance {
  let generation = 0
  let liveIntent = 0
  let pending = false
  let composing = false
  let destroyed = false
  let compositionExpiry: number | null = null

  const cancelCompositionExpiry = () => {
    if (compositionExpiry === null) return
    window.clearTimeout(compositionExpiry)
    compositionExpiry = null
  }

  const expire = (intent: number) => {
    if (liveIntent === intent) liveIntent = 0
  }

  const armIntent = (
    expiry: 'microtask' | 'macrotask' | 'dom' | 'composition',
  ) => {
    cancelCompositionExpiry()
    const intent = ++generation
    liveIntent = intent
    if (expiry === 'microtask') {
      queueMicrotask(() => expire(intent))
    } else {
      compositionExpiry = window.setTimeout(() => {
        compositionExpiry = null
        if (expiry === 'composition' && liveIntent === intent) composing = false
        expire(intent)
      }, expiry === 'macrotask'
        ? 0
        : expiry === 'dom'
          ? DOM_INTENT_TIMEOUT_MS
          : COMPOSITION_INTENT_TIMEOUT_MS)
    }
  }

  const capture = (event: Event) => {
    if (destroyed) return
    if (event.type === 'compositionstart') {
      composing = true
      armIntent('composition')
      return
    }
    if (event.type === 'compositionupdate') {
      composing = true
      armIntent('composition')
      return
    }
    if (event.type === 'compositionend') {
      composing = false
      armIntent('macrotask')
      return
    }
    armIntent(composing
      ? 'composition'
      : DOM_BACKED_INTENT_EVENTS.has(event.type) || isDeferredDomKeyIntent(event)
        ? 'dom'
        // Native dispatch can drain microtasks between capture and command listeners.
        : event.type === 'click' || event.type === 'keydown' || event.type === 'pointerdown'
          ? 'macrotask'
          : 'microtask')
  }

  const plugin = new Plugin<null>({
    state: {
      init: () => null,
      apply: (transaction, value) => {
        if (!destroyed && transaction.docChanged && liveIntent !== 0) {
          pending = true
          if (!composing) {
            liveIntent = 0
            cancelCompositionExpiry()
          }
        }
        return value
      },
    },
  })

  return {
    plugin,
    attach: (root) => {
      USER_INTENT_EVENTS.forEach((eventName) => {
        root.addEventListener(eventName, capture, true)
      })
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        USER_INTENT_EVENTS.forEach((eventName) => {
          root.removeEventListener(eventName, capture, true)
        })
      }
    },
    hasPending: () => pending,
    isComposing: () => composing,
    needsSynchronousCheckpoint: () => pending || liveIntent !== 0,
    consumePending: () => {
      pending = false
    },
    destroy: () => {
      destroyed = true
      generation += 1
      liveIntent = 0
      pending = false
      composing = false
      cancelCompositionExpiry()
    },
  }
}
