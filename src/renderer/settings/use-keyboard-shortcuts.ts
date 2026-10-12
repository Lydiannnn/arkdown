import { useEffect, useState } from 'react'
import { parseObservedShortcutSnapshot, type ShortcutSnapshot } from '../../shared/keyboard-shortcuts'

export function useKeyboardShortcuts() {
  const [snapshot, setSnapshot] = useState<ShortcutSnapshot>({ bindings: {}, revision: -1 })
  const acceptSnapshot = (next: ShortcutSnapshot) => {
    const observed = parseObservedShortcutSnapshot(next)
    if (observed) setSnapshot(current => observed.revision >= current.revision ? observed : current)
  }
  useEffect(() => {
    let active = true
    const receive = (next: ShortcutSnapshot) => {
      const observed = parseObservedShortcutSnapshot(next)
      if (active && observed) setSnapshot(current => observed.revision >= current.revision ? observed : current)
    }
    const detach = window.arkdown?.onKeyboardShortcutsChanged?.(receive)
    const refresh = () => { void window.arkdown?.getKeyboardShortcuts?.().then(result => { if (result.ok) receive(result.value) }).catch(() => undefined) }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { active = false; detach?.(); window.removeEventListener('focus', refresh) }
  }, [])
  return { snapshot, acceptSnapshot }
}
