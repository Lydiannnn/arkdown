import { describe, expect, it, vi } from 'vitest'
import { showScreenshotCaptureFailure } from '../../src/main/screenshot-translation/screenshot-capture-failure'

describe('screenshot capture failure dialog', () => {
  it('shows one fixed owner-bound message without native details', async () => {
    const owner = { isDestroyed: () => false }
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 })

    await expect(showScreenshotCaptureFailure({ showMessageBox }, owner, 'CAPTURE_EMPTY'))
      .resolves.toBeUndefined()

    expect(showMessageBox).toHaveBeenCalledOnce()
    expect(showMessageBox).toHaveBeenCalledWith(owner, {
      type: 'error',
      title: '截图翻译',
      message: '无法截取该区域',
      buttons: ['确定'],
      defaultId: 0,
      noLink: true,
    })
  })

  it('does nothing for a destroyed owner and contains dialog rejection', async () => {
    const showMessageBox = vi.fn().mockRejectedValue(new Error('C:\\private\\native-dialog.txt'))
    await expect(showScreenshotCaptureFailure(
      { showMessageBox },
      { isDestroyed: () => true },
      'CAPTURE_UNAVAILABLE',
    )).resolves.toBeUndefined()
    expect(showMessageBox).not.toHaveBeenCalled()

    await expect(showScreenshotCaptureFailure(
      { showMessageBox },
      { isDestroyed: () => false },
      'CAPTURE_UNAVAILABLE',
    )).resolves.toBeUndefined()
    expect(showMessageBox).toHaveBeenCalledOnce()
  })
})
