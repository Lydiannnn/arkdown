import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'

it.each([
  ['DOCUMENT_CONVERSION_COMPONENT_MISSING', '文档转换组件尚未安装'],
  ['DOCUMENT_CONVERSION_PACKAGE_MISSING', '当前安装包缺少文档转换组件'],
  ['DOCUMENT_CONVERSION_INSTALL_FAILED', '文档转换组件安装失败，请重试'],
  ['DOCUMENT_CONVERSION_COMPONENT_INVALID', '文档转换组件校验失败，请重新安装'],
  ['DOCUMENT_CONVERSION_FAILED', '文档转换未能完成，请重试'],
  ['DOCUMENT_CONVERSION_TIMEOUT', '文档转换超时，请重试'],
  ['DOCUMENT_CONVERSION_EMPTY', '未从文档中提取到可转换内容'],
  ['DOCUMENT_CONVERSION_INPUT_TOO_LARGE', '文档超过 256 MiB 限制，无法转换'],
  ['DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE', '转换结果超过 32 MiB 限制，无法创建 Markdown 文档'],
] as const)('reconstructs %s with its stable Chinese message', async (code, message) => {
  const api = createArkdownApi(vi.fn().mockResolvedValue({
    ok: false,
    error: { code, message: 'C:\\private\\component-path' },
  }))

  await expect(api.chooseWorkspace()).resolves.toEqual({
    ok: false,
    error: { code, message },
  })
})

it('reconstructs known failures from the local Chinese catalog', async () => {
  const api = createArkdownApi(vi.fn().mockResolvedValue({
    ok: false,
    error: {
      code: 'UNSUPPORTED_FILE_TYPE',
      message: 'C:\\private\\internal-path.docx',
    },
  }))

  await expect(api.openDroppedPath('C:\\notes\\draft.docx')).resolves.toEqual({
    ok: false,
    error: { code: 'UNSUPPORTED_FILE_TYPE', message: '不支持的文件类型' },
  })
})

it('fails closed in Chinese for unknown or malformed errors', async () => {
  const api = createArkdownApi(vi.fn().mockResolvedValue({
    ok: false,
    error: { code: 'PRIVATE_INTERNAL_ERROR', message: 'secret' },
  }))

  await expect(api.chooseWorkspace()).resolves.toEqual({
    ok: false,
    error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
})
