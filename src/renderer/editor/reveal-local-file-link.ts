import type { ArkdownApi } from '../../shared/contracts'
import type { LocalFileRevealRequest } from '../../shared/document-view'
import { PUBLIC_ERROR_MESSAGES } from '../../shared/public-errors'
import type { BusinessDialogController } from '../modal/BusinessDialogProvider'

export async function revealLocalFileLink(
  request: LocalFileRevealRequest,
  dialogs: Pick<BusinessDialogController, 'alert'> | null | undefined,
  reveal: ArkdownApi['revealLocalFileLink'] = window.arkdown?.revealLocalFileLink,
): Promise<void> {
  let message: string | undefined
  try {
    const result = await reveal?.(request)
    if (!result) message = PUBLIC_ERROR_MESSAGES.OPERATION_FAILED
    else if (!result.ok) message = result.error.message
  } catch { message = PUBLIC_ERROR_MESSAGES.OPERATION_FAILED }
  if (message) await dialogs?.alert({ title: '打开文件位置', description: message })
}
