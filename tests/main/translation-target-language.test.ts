import { describe, expect, it } from 'vitest'
import { resolveAutomaticTargetLanguage } from '../../src/main/models/translation-prompts'
import { resolveScreenshotTargetLanguage } from '../../src/main/screenshot-translation/screenshot-translation-prompts'

const cases = [
  ['普通中文', '今天下午交付订单，请提前确认数量。', 'en'],
  ['繁体中文', '請先確認訂單數量，再安排交付。', 'en'],
  ['英文', 'Please confirm the quantity before delivery.', 'zh-CN'],
  ['日语汉字', '今日は学校に行きます。', 'zh-CN'],
  ['日语缩写', '新しい API を使用して注文を取得します。', 'zh-CN'],
  ['半角假名', 'ﾌｧｲﾙを保存してください。', 'zh-CN'],
  ['韩文汉字', '오늘 注文 내역을 확인해 주세요.', 'zh-CN'],
  ['中文缩写', '请通过 API 获取订单数据，并核对返回结果。', 'en'],
  ['中文技术片段', '请检查订单数量。 https://example.com/really-long-resource-name@example.test?q=technical C:\\project\\documents\\very-long-file-name.md support@example-long-domain.com', 'en'],
  ['中文夹日语引文', '请先确认订单数量，再安排交付。附上对方的简短问候：“こんにちは”。', 'en'],
  ['中文夹单引号日语引文', '请先确认订单数量，再安排交付，并核对所有收货信息，附上对方问候‘こんにちは’。', 'en'],
  ['英文夹中文引文', 'Please confirm the complete order before delivery. The greeting was “你好”.', 'zh-CN'],
  ['主体不明确', 'English 混合文本', 'zh-CN'],
  ['纯汉字歧义兼容', '学校 東京 無料 设置 保存', 'en'],
  ['只有数字符号', '20260908 — … 😀 ー', 'zh-CN'],
  ['只有网址', 'https://example.com/很长的中文路径', 'zh-CN'],
  ['OCR 单行断开不分割日语语句', '東京\n駅から\n出発します。', 'zh-CN'],
  ['孤立长音符不翻转中文', '请确认这笔订单的数量ー', 'en'],
] as const

describe('shared automatic translation direction', () => {
  it.each(cases)('%s uses the same concrete target in selection and screenshot translation', (_name, text, expected) => {
    expect(resolveAutomaticTargetLanguage(text)).toBe(expected)
    expect(resolveScreenshotTargetLanguage([{ id: 'line-1', text }], 'auto')).toBe(expected)
  })

  it('excludes Markdown code, metadata and destinations from the detection sample', () => {
    const markdown = '---\ntitle: A very long English metadata value\n---\n\n'
      + '请先确认订单数量，再安排交付。\n\n'
      + '`' + 'identifier'.repeat(50) + '`\n\n```ts\n' + 'const value = calculateResult();\n'.repeat(40) + '```\n\n'
      + '[中文说明](https://example.com/a-long-resource-name) ![示意图](./english-long-image-path.png)'
    expect(resolveAutomaticTargetLanguage(markdown)).toBe('en')
    expect(resolveAutomaticTargetLanguage('```js\n// 中文代码注释\nconst x = 1\n```')).toBe('zh-CN')
  })

  it.each(['fr', 'ja', 'zh-TW'] as const)('keeps explicit %s for every supported sample', (target) => {
    for (const [, text] of cases) {
      expect(resolveScreenshotTargetLanguage([{ id: 'line-1', text }], target)).toBe(target)
    }
  })
})
