# Arkdown 品牌资源 · 2026-09-11

Arkdown 来源：`Arkdown-品牌资源包-20260911-final.zip`；Arknote 来源：`Arknote-图标资源包-20260912-red-rounded.rar`。导入条目、原包路径、字节数及 SHA-256 见 `manifest.json`。资源直接复制，未重绘或重新导出。

- 折页 A 为正式品牌，保留左笔画内部上短、中长、下最短三条书写线；彩色、黑、白、反白 SVG 均保留原稿。
- Arkdown 程序使用圆角版 `arkdown-app-rounded.ico`，包含 42 个尺寸；窗口使用对应 256 PNG。方形版本保留为原稿，不再作为运行图标。
- Arknote 程序及系统托盘使用 `arknote-app.ico`，窗口使用 `arknote-app-256.png`；均为红圆角底、白色柔弧回折 N，不再使用无底板红 N。托盘由 Arknote 服务统一创建。
- `ark-md.ico`、`ark-txt.ico`、`ark-docx.ico`、`ark-markdown-other.ico` 是文档关联图标，不能用于主品牌。
- 运行时的八个文件通过 `scripts/package-branding.ts` 复制至包外 `resources/branding`，供 Windows Shell 读取，并进行精确名单和 SHA-256 审计。
- 文件树八种 SVG 位于 `src/renderer/assets/file-icons`，保留 `22 / devicePixelRatio` CSS px；目录和未知类型图标保留现有资源。
- HTML 说明书使用原版横向字标：浅色页面彩色版、深色页面反白版；模板修改后用 `build:guide` 重新生成。

文件关联只注册可选处理程序，不写 UserChoice。已有当前路径注册自动迁移旧 EXE 图标；另一便携目录不会在启动时接管默认程序。已拥有的 ShellNew 后备类型同步更新，仍受既有事务和撤销机制管理。文件的实际默认程序仍由 Windows 中的用户选择决定。
