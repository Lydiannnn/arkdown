import { version as packageVersion } from '../../package.json'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AboutDialog } from '../../src/renderer/about/AboutDialog'

it.each(['button', 'escape'])('closes through the shared dialog lifecycle (%s)', async (method) => {
  const close = vi.fn(), user = userEvent.setup()
  render(<AboutDialog onClose={close} />)
  const dialog = screen.getByRole('dialog', { name: '关于 Arkdown' })
  expect(dialog).toHaveClass('arkdown-dialog')
  expect(dialog).toHaveTextContent('Copyright © 2026 Miterh')
  expect(dialog).toHaveTextContent('powered by Miterh')
  expect(dialog).toHaveTextContent(`版本 ${packageVersion}`)
  expect(dialog).toHaveTextContent('发布日期 2026 年 10 月 11 日')
  expect(dialog.querySelector('time')).toHaveAttribute('datetime', '2026-10-11')
  expect(dialog.querySelector('picture img')).toHaveAttribute('src', expect.stringContaining('arkdown-lockup-color.svg'))
  expect(dialog.querySelector('picture source')).toHaveAttribute('srcset', expect.stringContaining('arkdown-lockup-reverse.svg'))
  expect(dialog).not.toHaveTextContent('YPF')
  expect(screen.getByRole('heading', { name: '开源组件致谢' })).toBeVisible()
  expect(dialog).toHaveTextContent('Electron、Chromium、Node.js')
  expect(dialog.querySelectorAll('a')).toHaveLength(0)
  if (method === 'escape') await user.keyboard('{Escape}')
  else await user.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
})
