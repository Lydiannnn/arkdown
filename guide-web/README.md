# Arkdown 全新网页使用说明

本目录是一份从零编写的独立说明网站。没有复用旧说明书的内容、版面或截图。

## 阅读

直接用浏览器打开 `index.html`。请保留 HTML、CSS、JavaScript 和 assets 文件夹的相对位置，搜索、主题切换、目录与图片放大均不依赖网络。

本地预览：在 Arkdown 目录执行 `node guide-web/serve.mjs`，打开 http://127.0.0.1:8766。

## 资料依据

- 核对日期：2026-09-07。
- 最新程序：`Arkdown-packages/shell-defaults-de7990d/Arkdown-win32-x64/Arkdown.exe`。
- 对应源码：`.worktrees/ui-optimization-round2`，提交 `de7990d146d3ef3a2b3b43dfcf9e8819b71fe7cd`。
- 使用 Computer Use 实际启动上述程序，检查菜单、偏好设置、背景设置、编辑器与 AI 侧栏。
- assets 中的三张界面图均来自该程序的当次实际运行；编辑器图使用本目录 sample 中的专用示例文档。
- 内容同时核对当前菜单、快捷键注册、文档类型注册表、保存与资源处理代码；未使用旧说明书作为功能依据。

## 编辑与验证

- `content.mjs`：11 章正文，共 45 个小节。
- `build.mjs`：页面与搜索索引生成器。
- `guide.css`、`guide.js`：暖色排版、深浅色、移动目录与交互。
- 在 Arkdown 目录运行 `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON guide-web/build.mjs` 重新生成。
- 再运行 `node guide-web/verify.mjs` 验证所有页面、链接、锚点与离线资源。
- 构建使用项目已有的 React、Phosphor 图标和最新源码中的文档类型注册表；生成后的网页不需要 Node.js 或项目源码即可阅读。

视觉：Taste 指导下的暖色纸质手册风格，以米白、砖红和麦黄色构成。网页独立提供深浅色切换，不会修改 Arkdown 本身的设置。

## Arkdown 集成

本目录也是 Arkdown 内置离线说明书的维护源。`npm run build:guide` 会先按 `content.mjs` 重新生成本目录的页面和搜索索引，再把发布页面、样式、脚本与本地图片复制到 `user-guide/dist/使用说明书`，并生成兼容既有打开路径的 `user-guide/dist/使用说明书.html` 入口。Electron 打包继续复制这一个入口和整个 `使用说明书` 目录。运行 `node guide-web/verify.mjs user-guide/dist/使用说明书` 可直接验证构建后的目标目录。
