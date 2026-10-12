import type { ArknoteClientRuntime } from '../arknote/arknote-client-runtime'
import type { NativeUpdateHandoff } from './update-helper'
export class UpdateNotesStopError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : '便签停止状态未能确认。', { cause }) }
}
export async function restoreNotesAfterUpdateAbort(client: Pick<ArknoteClientRuntime, 'ensureStarted' | 'requestIfConnected'>): Promise<void> {
  await client.ensureStarted()
  await cancelNotesUpdatePreparation(client)
}
export async function cancelNotesUpdatePreparation(client: Pick<ArknoteClientRuntime, 'requestIfConnected'>): Promise<void> {
  const result = await client.requestIfConnected('service.cancel-update', {}, value => value === null ? null : undefined)
  if (result !== null) throw new Error('便签未确认恢复，请手动打开 Arknote。')
}
export async function stopNotesForUpdate(client: Pick<ArknoteClientRuntime, 'connectIfRunning' | 'requestIfConnected' | 'ensureStarted'>, helper: Pick<NativeUpdateHandoff, 'notesRunning' | 'waitNotesStopped'>): Promise<boolean> {
  if (!await helper.notesRunning()) return false
  if (!await client.connectIfRunning()) throw new Error('Arknote 正在运行，但未能建立保存连接。请正常关闭便签后再安装更新。')
  try {
    const result = await client.requestIfConnected('service.prepare-update', {}, value =>
      value && typeof value === 'object' && (value as { prepared?: unknown }).prepared === true ? true : undefined)
    if (result !== true) throw new Error('便签未确认保存，安装已取消。')
    // service.quit closes its pipe as part of normal shutdown. Only the native
    // process inventory below can confirm that shared program files are free.
    await client.requestIfConnected('service.quit', {}, value => value === null ? null : undefined).catch(() => undefined)
    await helper.waitNotesStopped()
    return true
  } catch (error) {
    // Preparation or shutdown may have succeeded despite a lost response. The
    // coordinator must release the helper's launch gate before restoring notes.
    throw new UpdateNotesStopError(error)
  }
}
