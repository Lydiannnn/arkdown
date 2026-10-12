# Arkdown screen translation engine

基于 ArkTranslate 1.3.0 的生产 `engine/`（交接文档 2026-09-12），提供 Windows x64 常驻 RapidOCR 与百度文本翻译。原项目没有 Git 元数据；`manifest.json` 记录原始源码、交付源码、完整运行目录及模型的 SHA256。

## 部署

开发时可将完整引擎放在仓库的 `.components/screen-translation/runtime/ArkTranslateEngine/`，包括 EXE、`_internal/`、模型与 `licenses/`。发布包的 `resources/screen-translation/` 只包含原生辅助 EXE、配置和固定下载描述符，用户首次启用悬浮翻译时下载并验证独立引擎，不需要安装 Python。开发缓存、独立下载包与构建中间文件不提交 Git。

独立包由 `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/package-screen-translation-component.ts` 生成。它先验证原始清单，再仅复制清单中的资源，去除与 `_internal/models/` 哈希一致的 RapidOCR 重复模型、空 `.gitkeep` 和官方说明可独立移除的 FFmpeg 视频插件。原始开发运行目录不变。按 `docs/maintenance/screen-translation-component-release.md` 准备第三方源码配套、固定哈希并执行真实 OCR 冒烟测试后发布。

宿主以绝对路径启动 `ArkTranslateEngine.exe`，隐藏控制台，并重定向标准输入输出。UTF-8，每行一个 JSON。串行请求，宿主负责取消/终止进程、超时与丢弃迟到响应。`stderr` 不作为协议。启动成功为 `{"ready":true,"protocol":2}`；模型加载失败返回 `ready:false` 并退出。

## 请求与结果

```json
{"id":1,"mode":"ocr","target":"zh","image":"<PNG 的原始 Base64>"}
{"id":2,"mode":"translate","target":"en","image":"<PNG 的原始 Base64>"}
```

成功统一返回 `{"id":1,"ok":true,"result":{...}}`。`result` 包含 `target`、`blocks`、`ocr_ms`、`total_ms`、`api_requests`。`blocks` 的每项为：

```json
{"text":"识别原文或译文","box":[50,100,450,250],"background":"#FFFFFF","foreground":"#182030"}
```

`box` 为相对本次输入图的 0～1000 归一化 `[left,top,right,bottom]`。颜色字段沿用原协议名称 `background` / `foreground`，是 BGR 像素中位数估算。`ocr` 返回原文，完全不创建百度客户端、不读取凭据、不请求网络；`translate` 在有可识别文字时才延迟创建客户端。空白图片成功返回空 `blocks`，0 次远程请求。

固定目标代码：`zh, cht, en, jp, kor, fra, de, spa, ru, ara, pt, it, th, vie`。保留源引擎中文与原生语言名称别名。两种图像模式都拒绝 `auto`、空值和未知目标，源语言仍由百度逐行检测；所选目标永不自动变化。

Arkdown 宿主的“自动”选项由宿主处理，不改变此 worker v2 协议：先用 `mode:ocr,target:zh` 获取整次输入的原文（此处目标仅满足协议校验，不进行翻译），复用划词/截图的本地规则判定中文为主→英语、其他→简体中文。模型后端直接翻译识别文本；百度后端对同一 PNG 再请求 `mode:translate`，传入已解析的固定 `en` 或 `zh`。因此百度自动模式比固定模式多一次本地 OCR，远程翻译不重复，空白识别不会发起翻译请求；所有缓存仍按实际固定目标区分。

请求 `id` 必须是整数（不接受布尔值），`mode` 必须显式指定。每行最多 32,000,000 字符，必须以换行结束；超过长度或不完整尾行直接退出码 2。只接受 PNG，最多 20,000,000 像素、256 个 OCR 块。JSON 格式错误和单个请求失败返回 `ok:false` 与固定脱敏错误文本，不输出异常堆栈、远端响应、密钥或 token。

## 独立的宿主凭据

宿主必须在 worker 环境中明确设置 `ARKDOWN_SCREEN_TRANSLATION_CREDENTIALS_FILE` 为自己的加密凭据文件**绝对路径**。没有值或为空即未配置。引擎不会读取旧 `%LOCALAPPDATA%/ArkTranslate/baidu.credentials.json`，也不读取其他默认凭据文件。

```json
{"id":3,"mode":"credentials-status"}
{"id":4,"mode":"configure-credentials","api_key":"<用户输入>","secret_key":"<用户输入>"}
```

状态操作只检查指定文件是否存在、可解密且字段完整，返回 `{"id":3,"ok":true,"result":{"configured":false}}`。配置操作经 stdin 接收两个非空字符串，Windows DPAPI CurrentUser 加密并验证，使用同目录临时密文文件原子替换；成功仅返回 `{"id":4,"ok":true,"result":{"configured":true}}`，并清除内存客户端 token 与译文缓存。空字段拒绝，不覆盖现有密钥。宿主不得记录配置请求内容，也不要经命令行参数传输密钥。

文件格式与旧引擎兼容：UTF-8 JSON `{"version":1,"protected":"<Base64 DPAPI bytes>"}`；明文是 UTF-8 JSON，字段 `api_key` 与 `secret_key`。DPAPI entropy 是 ASCII/UTF-8 字节 `ArkTranslate.BaiduCredentials.v1`，保护范围 CurrentUser。C# 可用 `ProtectedData.Protect(payload, Encoding.UTF8.GetBytes("ArkTranslate.BaiduCredentials.v1"), DataProtectionScope.CurrentUser)` 写同格式；推荐直接调用配置操作，避免宿主重复实现加密和原子写入。凭据只供同 Windows 用户在本机使用，不打入发布包。

## 实现与构建

`Pipeline.recognize(image)` 只执行 OCR 和布局/颜色估算；`Pipeline.translate(image,target,cache=True)` 调用 recognize，再执行固定目标译文去重和缓存。保留 3 个翻译线程、2048 项按 `(target,text)` 划分的 LRU、每帧等待全部翻译 future 完成后再响应。OCR 使用原模型/参数，ONNX CPU intra-op 4、inter-op 1。

源码运行可显式设置 `ARKDOWN_SCREEN_TRANSLATION_MODEL_DIR`；冻结运行默认用 `_internal/models`。构建脚本接受模型和输出目录参数，不修改用于执行的虚拟环境：

```powershell
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
& <python.exe> ./engine/build_engine.py --model-dir <models> --output-dir <runtime>
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
& <python.exe> -m unittest discover -s ./tests -p 'test*.py' -v
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
& <python.exe> ./tests/smoke_runtime.py --runtime-dir <完整 ArkTranslateEngine 目录>
if ($LASTEXITCODE -ne 0) { throw 'Runtime smoke failed' }
```

`--modelDir` / `--outputDir` 也可用；许可默认从本组件 `licenses/` 复制到完整运行目录，可用 `--licenses-dir` 指定。当前实际使用 ArkTranslate 的 Python 3.12.14 环境、PyInstaller 6.22.2 与三个已验证模型构建。

## 本次验证

2026-09-13：15 项 unittest 全通过。覆盖混合源固定目标、目标分区缓存/去重、LRU 淘汰、空白图片、坐标和颜色、OCR 无客户端/密钥访问/网络、错误 mode/id/目标、非 PNG 拒绝、错误文本脱敏、空路径不回退、损坏/缺字段凭据、仅临时 synthetic 凭据的真实 Windows DPAPI 往返与空值保护。

完整冻结 EXE 的离线 smoke 通过：握手协议 2，无凭据状态为 false，生成图片准确返回 `Hello Arkdown` 和 `Local OCR without network` 两块、0 次 API 请求，并拒绝未知 mode 与 auto。结果位于 `tests/smoke-output/runtime-results.json`。没有读取真实用户凭据，没有调用真实百度 API；百度请求链路仅以 fake client 验证，因此实际账号鉴权与网络翻译仍需宿主按需验证。
