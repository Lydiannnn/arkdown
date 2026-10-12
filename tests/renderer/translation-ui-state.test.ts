import { expect, it } from 'vitest'
import {
  isPartialTranslationTimeout,
  PARTIAL_TRANSLATION_TIMEOUT_MESSAGE,
} from '../../src/renderer/editor/translation-ui-state'

it('identifies only failed model timeouts with partial output', () => {
  expect(isPartialTranslationTimeout({
    requestId: null,
    status: 'failed',
    output: '部分译文',
    errorCode: 'MODEL_TIMEOUT',
    error: '大模型请求超时',
  })).toBe(true)

  expect(isPartialTranslationTimeout({
    requestId: null,
    status: 'failed',
    output: '',
    errorCode: 'MODEL_TIMEOUT',
    error: '大模型请求超时',
  })).toBe(false)
  expect(isPartialTranslationTimeout({
    requestId: null,
    status: 'failed',
    output: '部分译文',
    errorCode: 'MODEL_INVALID_ENDPOINT',
    error: '模型地址无效',
  })).toBe(false)
  expect(isPartialTranslationTimeout({
    requestId: 'request-1',
    status: 'streaming',
    output: '部分译文',
    errorCode: 'MODEL_TIMEOUT',
    error: '大模型请求超时',
  })).toBe(false)
})

it('provides the approved partial-timeout alert text', () => {
  expect(PARTIAL_TRANSLATION_TIMEOUT_MESSAGE).toBe('翻译内容过多，请分批次翻译')
})
