import type { Input, KeyboardInputEvent } from 'electron'
import { SHORTCUT_DEFINITIONS, acceleratorFromKeyEvent, shortcutFor, type ShortcutBindings } from '../../shared/keyboard-shortcuts'
import type { MenuCommand } from '../../shared/menu-commands'

interface Dependencies {
  getBindings(): ShortcutBindings
  isRecording(): boolean
  executeNative(menuId: string): void
  executeRenderer(command: MenuCommand): void
  sendInputEvent(event: KeyboardInputEvent): void
  setIgnoreMenuShortcuts(ignore: boolean): void
}

// These shortcuts previously reached the application menu. Keep that command path
// so format keys also work in source mode; other builtins keep focused-editor semantics.
const builtinMenuIds: Record<string, string> = {
  'editor.strong': 'format.strong', 'editor.emphasis': 'format.emphasis', 'editor.link': 'format.link',
  'editor.paragraph': 'paragraph.body',
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [`editor.heading-${level}`, `paragraph.heading-${level}`])),
}

/** Windows main-window input routing. Menus remain mouse-accessible; their keyboard
 * accelerators stay disabled because Chromium can acknowledge a replay asynchronously.
 * Electron 43 sends replay input through this listener synchronously (native fixture).
 */
export function createKeyboardShortcutInputHandler(dependencies: Dependencies) {
  let replaying = false
  dependencies.setIgnoreMenuShortcuts(true)
  return (event: { preventDefault(): void }, input: Input): void => {
    dependencies.setIgnoreMenuShortcuts(true)
    if (replaying || dependencies.isRecording() || input.isComposing) return
    const accelerator = acceleratorFromKeyEvent({ key: input.key, code: input.code, ctrlKey: input.control,
      altKey: input.alt, shiftKey: input.shift, metaKey: input.meta })
    if (!accelerator) return
    const bindings = dependencies.getBindings()
    const definition = SHORTCUT_DEFINITIONS.find(item => shortcutFor(item.id, bindings) === accelerator)
    if (!definition) {
      if (SHORTCUT_DEFINITIONS.some(item => item.defaultAccelerator === accelerator && shortcutFor(item.id, bindings) !== accelerator)) event.preventDefault()
      return
    }
    if (definition.owner === 'fixed' && !builtinMenuIds[definition.id] && definition.defaultAccelerator === accelerator) return
    event.preventDefault()
    if (input.type !== 'keyDown' || definition.owner === 'global') return
    if (definition.owner === 'native') {
      if (!input.isAutoRepeat) dependencies.executeNative(definition.id)
    } else if (definition.owner === 'renderer') {
      if (!input.isAutoRepeat) dependencies.executeRenderer(definition.id === 'workspace.search' ? 'search-workspace' : 'toggle-document-outline')
    } else if (builtinMenuIds[definition.id]) {
      dependencies.executeNative(builtinMenuIds[definition.id]!)
    } else {
      const parts = definition.defaultAccelerator!.split('+')
      const keyCode = parts.pop()!
      const modifierNames: Record<string, 'control' | 'alt' | 'shift'> = { Ctrl: 'control', Alt: 'alt', Shift: 'shift' }
      const modifiers = parts.map(part => modifierNames[part]!)
      replaying = true
      try {
        dependencies.sendInputEvent({ type: 'keyDown', keyCode, modifiers: input.isAutoRepeat ? [...modifiers, 'isautorepeat'] : modifiers })
      } finally {
        try { dependencies.sendInputEvent({ type: 'keyUp', keyCode, modifiers }) }
        finally { replaying = false }
      }
    }
  }
}
