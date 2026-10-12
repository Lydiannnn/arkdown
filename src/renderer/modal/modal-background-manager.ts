interface ModalBackgroundState {
  ariaHidden: string | null
  inert: boolean
  owners: number
}

interface ModalLayer {
  dialog: HTMLElement
  opener: HTMLElement | null
  rootOpener: HTMLElement | null
}

const backgroundStates = new Map<HTMLElement, ModalBackgroundState>()
const modalLayers: ModalLayer[] = []

function hasInertAncestor(element: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current) {
    if (current.inert) return true
    current = current.parentElement
  }
  return false
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element?.isConnected && !hasInertAncestor(element))
}

export function registerModalLayer(
  backdrop: HTMLElement,
  dialog: HTMLElement,
  opener: HTMLElement | null,
  contextualBackground: HTMLElement | null,
): () => void {
  const previousTop = modalLayers.at(-1)
  const layer: ModalLayer = {
    dialog,
    opener,
    rootOpener: previousTop?.rootOpener ?? opener,
  }
  const candidates = new Set<HTMLElement>()
  for (const element of document.body.children) {
    if (element instanceof HTMLElement) candidates.add(element)
  }
  for (const element of backgroundStates.keys()) candidates.add(element)
  if (contextualBackground) candidates.add(contextualBackground)

  const acquired: HTMLElement[] = []
  for (const element of candidates) {
    if (
      element === backdrop
      || element.contains(backdrop)
    ) continue

    const existing = backgroundStates.get(element)
    if (existing) {
      existing.owners += 1
    } else {
      backgroundStates.set(element, {
        ariaHidden: element.getAttribute('aria-hidden'),
        inert: Boolean(element.inert),
        owners: 1,
      })
      element.setAttribute('aria-hidden', 'true')
      element.inert = true
    }
    acquired.push(element)
  }
  modalLayers.push(layer)

  let released = false
  return () => {
    if (released) return
    released = true
    for (const element of acquired) {
      const state = backgroundStates.get(element)
      if (!state) continue
      state.owners -= 1
      if (state.owners > 0) continue
      backgroundStates.delete(element)
      if (state.ariaHidden === null) element.removeAttribute('aria-hidden')
      else element.setAttribute('aria-hidden', state.ariaHidden)
      element.inert = state.inert
    }

    const layerIndex = modalLayers.indexOf(layer)
    if (layerIndex >= 0) modalLayers.splice(layerIndex, 1)
    const top = modalLayers.at(-1)
    if (top) {
      if (layerIndex === modalLayers.length && canRestoreFocus(layer.opener)) {
        layer.opener.focus({ preventScroll: true })
      } else if (!top.dialog.contains(document.activeElement)) {
        top.dialog.focus({ preventScroll: true })
      }
      return
    }
    if (canRestoreFocus(layer.rootOpener)) {
      layer.rootOpener.focus({ preventScroll: true })
    }
  }
}
