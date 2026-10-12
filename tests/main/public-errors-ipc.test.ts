import { expect, it } from 'vitest'
import { ipcFailure } from '../../src/main/ipc/register-ipc'
import { appError } from '../../src/shared/public-errors'

it('preserves approved public error codes with bounded Chinese messages', () => {
  expect(ipcFailure(appError('UNSUPPORTED_FILE_TYPE'))).toEqual({
    ok: false,
    error: { code: 'UNSUPPORTED_FILE_TYPE', message: '不支持的文件类型' },
  })
})

it.each([
  ['ENOENT', 'FILE_NOT_FOUND', '文件已被移动或删除'],
  ['EACCES', 'PERMISSION_DENIED', '没有权限访问该文件'],
  ['EPERM', 'PERMISSION_DENIED', '没有权限访问该文件'],
] as const)('maps filesystem %s to %s', (sourceCode, publicCode, message) => {
  const error = Object.assign(new Error('C:\\private\\secret.txt'), { code: sourceCode })

  expect(ipcFailure(error)).toEqual({
    ok: false,
    error: { code: publicCode, message },
  })
})

it('does not leak internal error text through the fallback', () => {
  const result = ipcFailure(new Error('C:\\private\\secret.txt'))

  expect(result).toEqual({
    ok: false,
    error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
  expect(JSON.stringify(result)).not.toContain('private')
})
