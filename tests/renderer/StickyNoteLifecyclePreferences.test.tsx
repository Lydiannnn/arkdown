import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StickyNoteLifecyclePreferences } from '../../src/renderer/settings/StickyNotePreferencesSection'
import {
  DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
  type DesktopLifecyclePreferences,
} from '../../src/shared/desktop-lifecycle-preferences'

function renderPreferences(
  value: DesktopLifecyclePreferences = DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
) {
  const onChange = vi.fn()
  function Harness() {
    const [current, setCurrent] = useState(value)
    return <StickyNoteLifecyclePreferences onChange={(next) => {
      onChange(next)
      setCurrent(next)
    }} value={current} />
  }
  render(<Harness />)
  return onChange
}

describe('StickyNoteLifecyclePreferences', () => {
  it('shows the portable path warning only while launch at login is enabled', () => {
    const warning = '免安装版启用开机启动时，如果移动了程序文件夹，开机启动将失效'
    renderPreferences()
    expect(screen.queryByText(warning)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
    expect(screen.getByText(warning)).toBeVisible()
  })

  it('updates launch and close behavior without changing the prompt history', () => {
    const onChange = renderPreferences({
      ...DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
      stickyNoteAutostartPrompted: true,
    })

    fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
    expect(onChange).toHaveBeenLastCalledWith({
      launchAtLogin: true,
      closeBehavior: 'tray',
      stickyNoteAutostartPrompted: true,
    })

    fireEvent.click(screen.getByRole('radio', { name: '关闭整个软件（无法维持桌面便签功能）' }))
    expect(onChange).toHaveBeenLastCalledWith({
      launchAtLogin: true,
      closeBehavior: 'quit',
      stickyNoteAutostartPrompted: true,
    })
  })
})
