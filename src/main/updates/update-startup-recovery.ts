import path from 'node:path'
import { app, ipcMain, nativeTheme } from 'electron'
import { createBusinessMessageDialog } from '../dialogs/business-message-dialog'
import { preloadPathForBuild } from '../create-main-window'
import { ArknoteClientRuntime } from '../arknote/arknote-client-runtime'
import { prepareRecoveryHelper, type NativeUpdateHandoff } from './update-helper'
import { createUpdateDiagnosticLog } from './update-diagnostic-log'
import { cancelNotesUpdatePreparation, stopNotesForUpdate, UpdateNotesStopError } from './update-notes'

export async function showUpdateStartupFailure(buildDirectory: string, error: unknown): Promise<void> {
  await app.whenReady()
  const dialogs = createBusinessMessageDialog({ ipcMain, preloadPath: preloadPathForBuild(buildDirectory),
    rendererFile: path.join(buildDirectory, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), appearance: () => ({ dark: nativeTheme.shouldUseDarkColors }) })
  try {
    await dialogs.showMessageBox(undefined, { title: '更新状态无法确认', message: '无法校验上次更新的记录，暂未打开文档。',
      detail: '请保留现有程序、用户数据和更新备份，使用官方完整包修复程序。'
        + (error instanceof Error && /^[\u3400-\u9fff]/.test(error.message) ? '\n' + error.message : ''), buttons: ['关闭'] })
  } finally { dialogs.dispose() }
}

/** Runs before document restoration or editing is admitted. */
export async function recoverInterruptedUpdate(session: string, buildDirectory: string, mode: 'arkdown' | 'arknote'): Promise<void> {
  await app.whenReady()
  const dialogs = createBusinessMessageDialog({ ipcMain, preloadPath: preloadPathForBuild(buildDirectory),
    rendererFile: path.join(buildDirectory, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), appearance: () => ({ dark: nativeTheme.shouldUseDarkColors }) })
  let helper: NativeUpdateHandoff | undefined
  const notes = new ArknoteClientRuntime({ executablePath: path.join(path.dirname(process.execPath), 'Arkdown.exe') })
  let stopped = false
  try {
    if (mode !== 'arkdown') {
      await dialogs.showMessageBox(undefined, { title: '程序更新尚未完成', message: '请先打开 Arkdown，恢复上一次中断的更新，再使用便签。', buttons: ['关闭'] })
      app.quit(); return
    }
    const answer = await dialogs.showMessageBox(undefined, { title: '恢复中断的更新', message: '上一次更新尚未完成，需要先恢复原版本程序。',
      detail: '恢复过程会保留用户文档与设置。若便签正在运行，会先保存并退出，恢复完成后重新展开。', buttons: ['恢复并重启', '关闭'], defaultId: 0, cancelId: 1 })
    if (answer.response !== 0) { app.quit(); return }
    const diagnostics = createUpdateDiagnosticLog({ directory: path.join(app.getPath('userData'), 'diagnostics', 'update') })
    const recovery = await prepareRecoveryHelper({ resourcesPath: process.resourcesPath, executablePath: process.execPath,
      version: app.getVersion(), session, diagnostics })
    helper = recovery.helper
    stopped = await stopNotesForUpdate(notes, helper)
    await helper.commit({ documents: recovery.documents, restoreArknote: stopped || recovery.restoreArknote })
    app.quit()
  } catch (error) {
    if (error instanceof UpdateNotesStopError) stopped = true
    let revoked = !helper
    if (helper) { try { await helper.revoke(); revoked = true } catch { /* Keep the parent alive on ambiguous commit. */ } }
    if (!revoked) {
      await dialogs.showMessageBox(undefined, { title: '更新恢复未完成',
        message: '无法确认更新助手已停止，请等待助手显示结果。Arkdown 将暂时保持运行，避免触发未确认的替换。', buttons: ['知道了'] })
      // Keep both the parent and its note connection alive until the launch gate
      // is certainly released. A missing exit signal must not permit a quit.
      await (helper?.exited ?? new Promise<void>(() => {}))
    }
    let notesDetail = ''
    if (stopped) {
      try {
        // Persistent pending may describe a partially replaced installation.
        // Only unfreeze a live service; never start a potentially mixed version.
        if (await notes.connectIfRunning()) await cancelNotesUpdatePreparation(notes)
        else notesDetail = '便签未在运行；请在修复程序后重新打开 Arknote，恢复已保存的便签。'
      } catch { notesDetail = '便签自动恢复未能完成；请在修复程序后重新打开 Arknote，恢复已保存的便签。' }
    }
    const detail = [error instanceof Error && /^[\u3400-\u9fff]/.test(error.message) ? error.message : '', notesDetail].filter(Boolean).join('\n')
    await dialogs.showMessageBox(undefined, { title: '更新恢复未完成',
      message: '更新恢复未能完成，未开放文档编辑。请保留现有文件，通过官方安装包修复程序。', detail: detail || undefined, buttons: ['知道了'] })
    app.quit()
  } finally { dialogs.dispose(); notes.dispose() }
}
