import type { CaptureFailureCode } from './display-capture'

export interface ScreenshotCaptureFailureOwner {
  isDestroyed(): boolean
}

export interface ScreenshotCaptureFailureDialog {
  showMessageBox(
    owner: ScreenshotCaptureFailureOwner,
    options: {
      type: 'error'
      title: string
      message: string
      buttons: string[]
      defaultId: number
      noLink: boolean
    },
  ): Promise<unknown>
}

export async function showScreenshotCaptureFailure(
  dialog: ScreenshotCaptureFailureDialog,
  owner: ScreenshotCaptureFailureOwner | undefined,
  _code: CaptureFailureCode,
): Promise<void> {
  if (!owner || owner.isDestroyed()) return
  try {
    await dialog.showMessageBox(owner, {
      type: 'error',
      title: '截图翻译',
      message: '无法截取该区域',
      buttons: ['确定'],
      defaultId: 0,
      noLink: true,
    })
  } catch {
    // A native dialog failure must not expose private capture details or reject the launcher.
  }
}
