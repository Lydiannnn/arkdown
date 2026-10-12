import { expect, it } from 'vitest'
import { GUIDE_PAGES } from '../../user-guide/content'

it('documents the logical-pixel margin and body-width controls', () => {
  const content = GUIDE_PAGES.flatMap((page) => page.sections)
    .map((section) => section.body)
    .join('\n')
  expect(content).toContain('最小边距滑块范围为 30px～150px')
  expect(content).toContain('正文宽度滑块范围为 600px～1200px')
  expect(content).toContain('窗口变窄时，最小边距保持不变')
})
