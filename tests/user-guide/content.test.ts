import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  DEFERRED_FEATURES,
  GUIDE_GROUPS,
  GUIDE_PAGES,
  GUIDE_UPDATED_AT,
  GUIDE_VERSION,
} from '../../user-guide/content'

describe('Arkdown user-guide content contract', () => {
  it('defines the approved eight-page Chinese guide for version 0.1.0', () => {
    expect(GUIDE_VERSION).toBe('0.1.0')
    expect(GUIDE_UPDATED_AT).toBe('2026-09-07')
    expect(GUIDE_PAGES.map(({ output }) => output)).toEqual([
      '使用说明书.html',
      '使用说明书/workspace.html',
      '使用说明书/editing.html',
      '使用说明书/saving.html',
      '使用说明书/compatibility.html',
      '使用说明书/portable.html',
      '使用说明书/troubleshooting.html',
      '使用说明书/faq.html',
    ])
    expect(GUIDE_GROUPS.map(({ title }) => title)).toEqual([
      '开始使用',
      '编辑与保存',
      '文件与便携',
      '帮助',
    ])
    const faqVersion = GUIDE_PAGES.find(({ id }) => id === 'faq')?.sections
      .find(({ id }) => id === 'faq-relationship-version')

    expect(faqVersion?.body).toContain(`更新日期为 ${GUIDE_UPDATED_AT}`)
  })

  it('documents delivered media and recovery capabilities while keeping deferred features explicit', () => {
    expect(DEFERRED_FEATURES).toEqual(expect.arrayContaining([
      'HTML、PDF 或其他格式导出',
      '主题切换',
      '安装器和自动更新',
    ]))
    expect(DEFERRED_FEATURES).not.toContain('Word（.docx）导入')
    expect(DEFERRED_FEATURES).not.toContain('图片与资源管理')
    expect(DEFERRED_FEATURES).not.toContain('崩溃恢复')
    const userCopy = GUIDE_PAGES.flatMap((page) => page.sections)
      .map((section) => section.body)
      .join('\n')
    for (const feature of DEFERRED_FEATURES) {
      expect(userCopy).toContain(feature)
    }
    for (const delivered of [
      '已备份到临时草稿',
      '恢复未保存的内容',
      'DOCX',
      '使用默认浏览器搜索',
      'Ctrl',
      '文件已被移动或删除',
      '手型',
      '文件 → 偏好设置',
      '立即生效并自动保存',
      '不会撤销已经修改的设置',
      '左上角与底部的“返回”都会回到上一层偏好设置',
      '最小边距',
      '正文宽度',
      '30px～150px',
      '600px～1200px',
      '保留单个换行',
      '标题和正文分别提供中文、英文字体选择',
      'Arial',
      'SimHei',
    ]) expect(userCopy).toContain(delivered)
    expect(userCopy).not.toContain('本地浏览器搜索')
  })

  it('documents Mermaid fenced source, recovery, offline rendering, output limits, and export boundaries', () => {
    const userCopy = GUIDE_PAGES.flatMap((page) => page.sections)
      .map((section) => [section.title, section.summary, section.body].join('\n'))
      .join('\n')

    for (const required of [
      '```mermaid',
      'Markdown 源码是唯一的数据源',
      '显示图形',
      '编辑源码',
      'Mermaid 语法错误',
      '无需联网',
      '20,000',
      '100 条边',
      '30 个 Mermaid 图块',
      '2.5 秒',
      '打印',
      'PDF',
      'DOCX',
      '只保留 Mermaid 源码块',
    ]) expect(userCopy).toContain(required)
  })

  it('documents the complete sticky-note workflow and its portable lifecycle', async () => {
    const userCopy = GUIDE_PAGES.flatMap((page) => page.sections)
      .map((section) => [section.title, section.summary, section.body].join('\n'))
      .join('\n')
    for (const required of [
      '便签盒子',
      '实时保存',
      '释放到桌面',
      '从桌面回收',
      'Pin',
      '归档',
      '搜索',
      '开机启动',
      '免安装版启用开机启动时，如果移动了程序文件夹，开机启动将失效',
    ]) expect(userCopy).toContain(required)

    const rules = await readFile('user-guide/RULES.md', 'utf8')
    for (const required of [
      '活跃便签最多 35 个',
      '归档便签不计入 35 个上限',
      '复制引用的本地资源',
      '不得修改源文档或源资源',
      '独立样式不受全局预设修改影响',
    ]) expect(rules).toContain(required)
  })

  it('uses unique section ids and searchable summaries', () => {
    const sections = GUIDE_PAGES.flatMap((page) => page.sections)
    const ids = sections.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const section of sections) {
      expect(section.summary.trim().length).toBeGreaterThan(8)
      expect(section.keywords.length).toBeGreaterThan(0)
    }
  })

  it('ships a dedicated maintenance rulebook', async () => {
    const rules = await readFile('user-guide/RULES.md', 'utf8')
    for (const heading of [
      '# Arkdown 使用说明书维护规则',
      '## 内容真实性',
      '## 页面与链接',
      '## 截图',
      '## 搜索索引',
      '## 版本与打包',
      '## 发布前检查',
    ]) expect(rules).toContain(heading)
  })
})
