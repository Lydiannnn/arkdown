# 悬浮翻译窗组件

入口：**工具 → 悬浮翻译窗**。工具面板默认 360 × 450 CSS px，可向外放大，长设置内容可滚动。新配置默认使用大模型、目标语言“自动”、快捷键触发且保持暂停；旧配置已选择的百度/大模型后端和目标语言保留。拖动取景框顶部的红色准星移动区域，拖动边缘或右下角调整大小。选择翻译方式与自动或固定目标语言，然后使用快捷键或“翻译一次”。

发行版首次打开会检查本地组件；尚未安装时点击“安装翻译组件”，从固定 GitHub Release 下载、校验并安装。可以取消、失败重试；成功后自动继续原有工具流程。后续打开验证已安装组件，无需重复下载。组件准备失败只在工具面板提示，不影响编辑器启动。

- **百度快译**：在面板展开“百度智能云密钥”，填写 API Key 与 Secret Key。密钥按当前 Windows 用户加密保存；不会自动导入独立 ArkTranslate 的配置。
- **大模型**：在“设置 → 管理大模型 → 功能应用 → 悬浮翻译窗”选择模型与目标语言；工具面板中的模型、思考偏好、目标语言与此处共享配置。支持 API 连接与动态 Codex CLI 模型，并按模型能力显示思考开关；按用户决定不展示推理强度菜单。此模式本地识别文字，仅把识别出的文字发给选定模型。修改共享配置不会切换当前百度/大模型后端。
- **自动**：每秒检查画面，跳过未变化内容；仅保留一个执行中任务和最新候选画面。
- **快捷键**：工具打开时，默认 `Ctrl+Shift+A` 翻译一次，`Ctrl+Shift+D` 清除译文，`Ctrl+Alt+T` 开始或暂停；可在“编辑 → 快捷键”修改。面板提示跟随当前绑定。被其他软件占用时仍可使用面板按钮。关闭工具即释放三项全局注册。
- **清除译文**：暂停自动翻译、取消正在处理和排队的请求、清除差分基线与可见译文，同时保留取景框的位置与大小。旧请求和旧截图编码结果不能恢复译文；可以立即重新翻译。
- 暂停保留当前译文；“显示原文”临时隐藏译文，“复制译文”复制当前文字；关闭收起取景框、停止子进程并取消请求。

## 边界

本目录只管理组件生命周期、受限 IPC、独立设置和模型适配。`native/screen-translation` 负责物理屏幕坐标、截图排除、鼠标穿透、差分和原位覆盖。`components/screen-translation` 负责 RapidOCR 与百度文本接口。专用预加载脚本只暴露 `arkScreenTranslation`，不暴露编辑器或文件系统 API。

模块数据放在现有 Arkdown 数据目录的 `screen-translation/`；后端、触发方式及取景框位置仍由模块管理。模型连接 ID、思考模式、强度与目标语言以中央 `models.floatingTranslation` 为准，不复制模型 API Key。旧模块模型和目标字段仅供缺失字段迁移：中央模型选择存在（包括已清空的绑定）时不重新导入模型；中央缺目标语言时读取旧模块有效语言，缺失或无效时补“自动”。单独使用百度且主设置文件缺失的旧配置也保留目标语言。两个面板按字段保存，修改语言不会覆盖另一面板新选择的模型。运行状态、截图与识别内容不落盘。

## 构建

`npm run build:screen-translation` 生成 `.native-cache/screen-translation/Arkdown.ScreenTranslation.exe` 及 `.config`。完整引擎目录放在 `.components/screen-translation/runtime/ArkTranslateEngine`（不提交 Git），按 `components/screen-translation/README.md` 构建。当前引擎为 Windows x64。

Forge 将专用 preload 编译为 `screen-translation-preload.js`。主包 `resources/screen-translation/` 只保留 helper、配置与固定下载描述清单，包审计拒绝重新内置引擎。引擎独立资源由 `scripts/package-screen-translation-component.ts` 构建，下载到现有 Arkdown 数据目录的 `components/screen-translation/active`。安装完成后才启动已校验的 EXE；开发模式仍可使用 `.components` 中的本地运行时。

## 验证范围

原生 core/controller、Python、主进程、preload、React 和快捷键事务均有回归测试。2026-09-13 使用合成桌面内容完成真实取景与 OCR → 模拟模型 → 原位回填闭环，并验证自动变化、暂停保留、面板截图排除、点击/滚轮穿透和退出清理。

真实百度账号与真实模型的在线悬浮翻译窗、混合 DPI 多显示器及全屏游戏覆盖仍需手测。隔离测试不读取用户凭据，也不将用户桌面发送到外部服务。
