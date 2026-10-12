import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'

const userGuidePath = path.join(process.cwd(), 'docs', 'user-guide', '便签功能用户说明书.md')
const blackBoxPath = path.join(process.cwd(), 'docs', 'testing', '便签功能黑盒测试手册.md')

it('contains no superseded Arkdown tray, startup, save, or exit instructions', async () => {
  const [userGuide, blackBox] = await Promise.all([
    readFile(userGuidePath, 'utf8'),
    readFile(blackBoxPath, 'utf8'),
  ])
  for (const obsolete of [
    '本节取代下文涉及旧生命周期的表述',
    '第一次打开便签盒子时，Arkdown 会询问是否启用开机启动',
    '停止输入约 500 毫秒后',
    'Arkdown 运行后会在 Windows 系统托盘显示图标',
    '退出 Arkdown。',
    '关闭主窗口后，Arkdown 继续在托盘运行',
    '打开“文件 → 偏好设置 → 便签设置”，可以修改七种颜色和七种底纹',
  ]) expect(userGuide).not.toContain(obsolete)
  for (const obsolete of [
    '本节取代旧版 Arkdown 托盘/驻留表述',
    'SN-I01 关闭主窗口并驻留托盘',
    '通过托盘菜单选择“显示 Arkdown”',
    '执行“退出 Arkdown”',
    '当前 Arkdown.exe 路径已登记',
    '关闭 Arkdown 后重新启动并打开该便签',
    '打开“文件 → 偏好设置 → 便签设置”。',
    '立即通过任务管理器结束 Arkdown 进程',
  ]) expect(blackBox).not.toContain(obsolete)
  expect(userGuide).toContain('停止输入约 2000 毫秒后')
  expect(userGuide).toContain('Arknote 运行后会在 Windows 系统托盘显示图标')
  expect(userGuide).toContain('固定颜色保留原有表现')
  expect(userGuide).toContain('默认颜色恢复白色')
  expect(userGuide).toContain('已有便签的颜色、底纹、材质、内容和图片背景都不随默认设置、重置或重启变化')
  expect(blackBox).toContain('Arkdown 主窗口关闭后直接退出，不驻留托盘')
  expect(blackBox).toContain('从 Arknote 托盘选择“退出 Arknote”，重新启动 Arknote 并打开该便签')
  expect(blackBox).toContain('从 Arknote 托盘打开“设置”。')
  expect(blackBox).toContain('立即通过任务管理器强制结束 Arknote 进程')

  const combined = userGuide + '\n' + blackBox
  for (const obsolete of [
    '实时保存中...',
    '随后显示“已保存”',
    '状态最终变为“已保存”',
    '等待所有便签显示“已保存”',
    '等待状态变为“已保存”',
    '保存成功，状态变为“已保存”',
    '固定九种样式',
    '逐项查看九种',
    '60% 黑',
  ]) expect(combined).not.toContain(obsolete)
  expect(userGuide).toContain('正常保存时不显示常驻状态')
  expect(userGuide).toContain('八种 1px 颜色预览')
  expect(userGuide).toContain('高度每次调整 1px')
  expect(blackBox).toContain('正常保存时没有常驻状态')
  expect(blackBox).toContain('八种 1px 颜色预览')
  expect(blackBox).toContain('显示七种固定内置颜色和“自定义”选项')
  expect(blackBox).toContain('默认材质 Mica、默认色白色')
  expect(blackBox).toContain('默认材质 Mica、默认色白色；旧色板与底纹数组保持原值')
})
