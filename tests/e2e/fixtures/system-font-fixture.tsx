import './startup-guide-layout-fixture'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../../src/shared/arknote-preferences'
import { DEFAULT_FONT_CHOICES } from '../../../src/shared/editor-appearance-preferences'
import type { ArkdownApi } from '../../../src/shared/contracts'

const sample = [
  '# Arkdown 字体测试', '',
  '实现便签常驻 Mica 效果，已经实际确认失焦时渲染有效。', '',
  '调整底板明暗 · MotionLab · Arkdown · Pull Request', '',
  '4609 项测试通过 · 已编辑 12 个文件 · +277 -34', '',
  '## 中文、英文和数字', '',
  '用同一段文字观察笔画、字面高度和混排效果。**这是重点内容。**', '',
  '- [ ] 整理文档和任务', '- [x] 比较字体效果', '',
  '| 项目 | 状态 | 数量 |', '| --- | --- | --- |', '| Mica 材质 | 已确认 | 12 |',
  '', '行内代码 `const size = 14` 和代码块继续使用等宽字体。', '',
  '```typescript', 'const message = "Arkdown / 中文 123";', 'console.log(message);', '```',
].join('\n')
const overrides: Partial<ArkdownApi> = {
  getSearchPreferences: async () => ({ ok: true, value: { provider: 'baidu', customTemplate: '' } }),
  getArknotePreferences: async () => ({ ok: true, value: DEFAULT_ARKNOTE_PREFERENCES }),
  getSystemFonts: async () => ({ ok: true, value: [...DEFAULT_FONT_CHOICES] }),
  getShellIntegrationPreferences: async () => ({ ok: true, value: { values: { documentOpenMenu: true, markdownShellNew: true }, unavailable: [],
    observation: { version: 1, revision: 0, minimumBaseRevision: 0, fields: {} } } }),
  getDefaultApplicationsStatus: async () => ({ ok: true, value: { markdown: false, text: false } }),
  listDirectory: async () => ({ ok: true, value: [{ kind: 'document', name: '字体测试.md', relativePath: '字体测试.md' }] }),
  readDocument: async () => ({ ok: true, value: { relativePath: '字体测试.md', markdown: sample,
    revision: 'a'.repeat(64), encoding: 'utf8', newline: 'lf', mtimeMs: 1 } }),
}
Object.assign(window.arkdown, overrides)
