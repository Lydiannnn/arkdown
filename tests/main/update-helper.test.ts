// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { UpdateHelperConnection, parseApplicationUpdaterTrust } from '../../src/main/updates/update-helper'
function fixture(onDiagnostic?: (diagnostic: unknown) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() })
  const messages: unknown[] = []; child.stdin.on('data', b => messages.push(JSON.parse(b.toString())))
  const connection = new UpdateHelperConnection(child as unknown as ChildProcessWithoutNullStreams, 'token', onDiagnostic)
  return { child, messages, connection, reply(type: string) { child.stdout.write(JSON.stringify({ type }) + '\n') } }
}
it('does not grant installation until explicit commit is acknowledged', async () => {
  const f = fixture(); const ready = f.connection.wait('ready', 1000); f.reply('ready'); await ready
  expect(f.messages).toEqual([])
  let done = false; const commit = f.connection.handoff().commit({ documents: ['one.md'], restoreArknote: true }).then(() => { done = true })
  await Promise.resolve(); expect(done).toBe(false)
  expect(f.messages).toEqual([{ type: 'commit', token: 'token', documents: ['one.md'], restoreArknote: true }])
  f.reply('committed'); await commit; expect(done).toBe(true)
})
const failureDiagnostic = () => ({ schemaVersion: 1, origin: 'helper', phase: 'stage.verify.open', operation: 'CreateFileW',
  pathScope: 'stage', relativePath: 'resources/app.asar', pathPrecision: 'exact', ancestorLevelsAboveSession: null,
  exceptionType: 'System.ComponentModel.Win32Exception', nativeErrorCode: 32, nativeCodeSource: 'Win32Exception',
  hresult: -2147467259, access: 2147483648, share: 1, creation: 3, flags: 2097152, validationReason: null, primaryStack: null, terminalStack: null })
it('records the first valid preflight failure independently of later fatal and revoke state', async () => {
  const failures: unknown[] = [], f = fixture(value => failures.push(value))
  const ready = f.connection.wait('ready', 1000)
  f.child.stdout.write(JSON.stringify({ type: 'error', message: '原始错误', diagnostic: failureDiagnostic() }) + '\n')
  await expect(ready).rejects.toThrow('原始错误')
  expect(failures).toEqual([failureDiagnostic()])
  const revoke = f.connection.handoff().revoke()
  f.child.stdout.write(JSON.stringify({ type: 'error', message: '撤销错误', diagnostic: { ...failureDiagnostic(), nativeErrorCode: 5 } }) + '\n')
  await expect(revoke).rejects.toThrow('撤销错误')
  f.child.emit('exit', 1)
  await expect(f.connection.wait('ready', 1000)).rejects.toThrow('更新助手已退出')
  expect(failures).toEqual([failureDiagnostic()])
})
it('ignores malformed optional diagnostics while preserving the original error and total response bound', async () => {
  for (const diagnostic of [undefined, { ...failureDiagnostic(), token: 'PRIVATE' }, { ...failureDiagnostic(), phase: 'unexpected' },
    { ...failureDiagnostic(), primaryStack: '\n'.repeat(4200) }]) {
    const failures: unknown[] = [], f = fixture(value => failures.push(value)), ready = f.connection.wait('ready', 1000)
    f.child.stdout.write(JSON.stringify({ type: 'error', message: '原始错误', diagnostic }) + '\n')
    await expect(ready).rejects.toThrow('原始错误'); expect(failures).toEqual([])
  }
  const failures: unknown[] = [], f = fixture(value => failures.push(value)), ready = f.connection.wait('ready', 1000)
  f.child.stdout.write(JSON.stringify({ type: 'error', message: '原始错误', diagnostic: { ...failureDiagnostic(), primaryStack: 'x'.repeat(16384) } }) + '\n')
  await expect(ready).rejects.toThrow('响应过大'); expect(failures).toEqual([])
})
it('keeps recorder failures out of UI errors and performs no diagnostic work on success or post-ready errors', async () => {
  const f = fixture(() => { throw new Error('PRIVATE recorder failed') }), ready = f.connection.wait('ready', 1000)
  f.child.stdout.write(JSON.stringify({ type: 'error', message: '原始错误', diagnostic: failureDiagnostic() }) + '\n')
  await expect(ready).rejects.toThrow('原始错误')
  const failures: unknown[] = [], success = fixture(value => failures.push(value)), wait = success.connection.wait('ready', 1000)
  success.reply('ready'); await wait
  const commit = success.connection.handoff().commit({ documents: [], restoreArknote: false })
  success.child.stdout.write(JSON.stringify({ type: 'error', message: '提交错误', diagnostic: failureDiagnostic() }) + '\n')
  await expect(commit).rejects.toThrow('提交错误'); expect(failures).toEqual([])
})
it('can revoke after a lost commit acknowledgement and requires a fresh revoke response', async () => {
  const f = fixture(); const commit = f.connection.handoff().commit({ documents: [], restoreArknote: false })
  f.child.stdout.write('{"type":"error","message":"交接失败"}\n'); await expect(commit).rejects.toThrow('交接失败')
  const revoke = f.connection.handoff().revoke(); f.reply('revoked'); await revoke
  expect(f.messages).toHaveLength(2)
})
it('rejects malformed or oversized helper output and invalid build trust', async () => {
  const f = fixture(); const ready = f.connection.wait('ready', 1000); f.child.stdout.write('x'.repeat(16385)); await expect(ready).rejects.toThrow('响应过大')
  expect(() => parseApplicationUpdaterTrust({ bytes: 1, sha256: 'a'.repeat(64), path: 'anything' })).toThrow()
  expect(() => parseApplicationUpdaterTrust({ bytes: -1, sha256: 'a'.repeat(64) })).toThrow()
})
