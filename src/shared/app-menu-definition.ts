export const APP_MENU_SECTIONS = [
  { id: 'file', label: '文件' },
  { id: 'edit', label: '编辑' },
  { id: 'paragraph', label: '段落' },
  { id: 'format', label: '格式' },
  { id: 'view', label: '视图' },
  { id: 'theme', label: '主题' },
  { id: 'tools', label: '工具' },
  { id: 'help', label: '帮助' },
] as const

export type AppMenuSectionId = typeof APP_MENU_SECTIONS[number]['id']

const APP_MENU_SECTION_IDS = new Set<string>(
  APP_MENU_SECTIONS.map((section) => section.id),
)

export function isAppMenuSectionId(value: unknown): value is AppMenuSectionId {
  return typeof value === 'string' && APP_MENU_SECTION_IDS.has(value)
}
