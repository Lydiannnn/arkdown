# Arkdown HTML 使用说明书

“帮助 → 使用说明书”打开本目录构建的离线 HTML。正文和初始工作区共用 `initial-workspace/01–10` 十篇 Markdown；不再另外维护一套介绍。

## 修改与构建

- 修改正文：编辑 `initial-workspace` 中对应的编号文档。
- `content.mjs` 读取文档、生成章节数据，并把 Markdown 章节链接转为 HTML 页面链接。
- `build.mjs` 沿用说明书的导航、搜索、深浅色和移动布局。
- 应用内的“选择工作区／新建文档”入口在网页中显示为文字；需要在 Arkdown 内操作。
- `npm run build:guide` 生成网页，并复制到 `user-guide/dist/使用说明书`，入口为 `user-guide/dist/使用说明书.html`。
- `node guide-web/verify.mjs user-guide/dist/使用说明书` 检查页面、链接、搜索索引和离线资源。

## 内容与发布

正文共十章、五十个小节，版本从项目 `package.json` 读取，当前内容核对日期为 2026-10-13。

生成后的 HTML 使用相对路径，可离线打开。发布时保留 `使用说明书.html` 和 `使用说明书` 文件夹的相对位置。程序的帮助菜单及打包入口保持不变。

本轮移除示例散文及四张配图，不会清理用户工作区中已有的文档。维护规则见 `user-guide/RULES.md`。`user-guide/content.ts` 及旧模板属于早期说明书，不是当前打包内容来源。
