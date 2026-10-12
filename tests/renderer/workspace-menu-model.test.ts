import { expect, it } from 'vitest'
import { collectEnabledCommandIds } from '../../src/renderer/context-menu/context-menu-types'
import { buildWorkspaceMenu } from '../../src/renderer/workspace/workspace-menu-model'

const colorMenu = (checked?: string) => ({
  kind: 'submenu' as const,
  id: 'workspace-color-mark',
  label: '标记颜色',
  items: [
    ['红色', '#C62828'],
    ['紫色', '#800080'],
    ['蓝色', '#2563EB'],
    ['青色', '#007C91'],
    ['绿色', '#18864B'],
    ['橙色', '#C66A00'],
    ['粉色', '#B83280'],
  ].map(([label, color], index) => ({
    kind: 'command' as const,
    id: `workspace-color-mark-${index}`,
    label,
    swatchColor: color,
    iconChoice: true,
    checked: checked === color,
  })).concat([
    { kind: 'separator' as const, id: 'workspace-color-clear-separator' } as never,
    {
      kind: 'command' as const,
      id: 'workspace-color-clear',
      label: '清除标记',
      disabled: checked === undefined,
    } as never,
  ]),
})

it('builds document and folder menus in the approved visible order', () => {
  const documentMenu = buildWorkspaceMenu({
    kind: 'document',
    name: 'note.md',
    relativePath: 'note.md',
  })
  expect(documentMenu).toEqual([
    { kind: 'command', id: 'workspace-open-new-window', label: '在新窗口中打开' },
    { kind: 'command', id: 'workspace-reveal', label: '打开所在的文件夹' },
    { kind: 'command', id: 'workspace-copy-path', label: '复制绝对路径' },
    { kind: 'separator', id: 'workspace-document-primary-separator' },
    colorMenu(),
    { kind: 'command', id: 'workspace-rename', label: '重命名…' },
    { kind: 'command', id: 'workspace-duplicate', label: '创建副本' },
    { kind: 'separator', id: 'workspace-document-danger-separator' },
    { kind: 'command', id: 'workspace-trash', label: '移到回收站', danger: true },
    { kind: 'command', id: 'workspace-properties', label: '属性' },
  ])

  const folderMenu = buildWorkspaceMenu({
    kind: 'directory',
    name: 'notes',
    relativePath: 'notes',
  })
  expect(folderMenu).toEqual([
    { kind: 'command', id: 'workspace-open-new-window', label: '在新窗口中打开' },
    { kind: 'command', id: 'workspace-reveal', label: '打开所在的文件夹' },
    { kind: 'command', id: 'workspace-copy-path', label: '复制绝对路径' },
    { kind: 'separator', id: 'workspace-folder-primary-separator' },
    colorMenu(),
    { kind: 'command', id: 'workspace-rename', label: '重命名…' },
    { kind: 'separator', id: 'workspace-folder-danger-separator' },
    { kind: 'command', id: 'workspace-trash', label: '移到回收站', danger: true },
    { kind: 'command', id: 'workspace-properties', label: '属性' },
  ])

  expect(collectEnabledCommandIds(documentMenu)).toEqual([
    'workspace-open-new-window',
    'workspace-reveal',
    'workspace-copy-path',
    'workspace-color-mark-0',
    'workspace-color-mark-1',
    'workspace-color-mark-2',
    'workspace-color-mark-3',
    'workspace-color-mark-4',
    'workspace-color-mark-5',
    'workspace-color-mark-6',
    'workspace-rename',
    'workspace-duplicate',
    'workspace-trash',
    'workspace-properties',
  ])

  expect(collectEnabledCommandIds(folderMenu)).toEqual([
    'workspace-open-new-window',
    'workspace-reveal',
    'workspace-copy-path',
    'workspace-color-mark-0',
    'workspace-color-mark-1',
    'workspace-color-mark-2',
    'workspace-color-mark-3',
    'workspace-color-mark-4',
    'workspace-color-mark-5',
    'workspace-color-mark-6',
    'workspace-rename',
    'workspace-trash',
    'workspace-properties',
  ])
})

it('checks the active color and enables clearing only for a marked entry', () => {
  const menu = buildWorkspaceMenu({
    kind: 'document', name: 'note.md', relativePath: 'note.md',
  }, '#2563EB')
  expect(menu).toContainEqual(colorMenu('#2563EB'))
})

it('keeps root creation commands unchanged', () => {
  expect(collectEnabledCommandIds(buildWorkspaceMenu({
    kind: 'root',
    name: 'workspace',
    relativePath: '',
  }))).toEqual([
    'workspace-new-document',
    'workspace-new-folder',
    'workspace-open-file',
    'workspace-open-folder',
    'workspace-refresh',
    'workspace-reveal',
    'workspace-properties',
  ])
})
