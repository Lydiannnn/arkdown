import type { ArkdownApi } from '../../shared/contracts'
import type { ClosePreparationResult, ClosePreparationHandlerContext } from '../../shared/close-preparation'
import type { BusinessDialogController } from '../modal/BusinessDialogProvider'
import type { ModelPreferenceDraft } from './model-preference-draft'
import type { PreferencePersistence } from './preference-update-queue'

/** Failed model choices are retained intent, not an indefinitely running save.
 * Discard only on an explicit decision and after a fresh authoritative read. */
export async function settleClosePreferences(options: {
  persistence: PreferencePersistence; models: ModelPreferenceDraft
  api: Pick<ArkdownApi, 'getModelSettingsSnapshot'>
  confirm: BusinessDialogController['confirm']; enter: ClosePreparationHandlerContext['enter']
}): Promise<ClosePreparationResult> {
  options.enter('settle-preferences')
  let result = await options.persistence.drain()
  if (result.ok) return { status: 'ready' }
  if (result.failedCategories.length === 1 && result.failedCategories[0] === 'models') {
    options.enter('await-preferences')
    const decision = await options.confirm({ title: '大模型设置尚未保存',
      description: '你的设置修改仍保留。可以返回继续处理，或放弃这些未保存的设置，使用已经保存的设置并关闭窗口。文档内容不会因此被丢弃。',
      confirmLabel: '使用已保存设置并关闭', cancelLabel: '返回编辑' })
    if (decision !== 'confirm') return { status: 'cancelled' }
    options.enter('settle-preferences')
    await options.models.reload(options.api)
    result = await options.persistence.drain()
  }
  return result.ok ? { status: 'ready' } : { status: 'failed', code: 'preferences-save-failed' }
}
