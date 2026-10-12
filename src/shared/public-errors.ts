export const PUBLIC_ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: '请求参数无效',
  INVALID_RESPONSE: '响应数据无效',
  DOCUMENT_CONFLICT: '文件已被其他程序修改',
  DOCUMENT_ROLLBACK_INCOMPLETE: '文档操作失败，回滚未完整完成',
  UNSUPPORTED_FILE_TYPE: '不支持的文件类型',
  DOCUMENT_TEXT_TOO_LARGE: '文档超过 8 MiB 限制，无法打开',
  DOCUMENT_BINARY: '文件包含二进制内容，无法作为文本文档打开',
  DOCUMENT_ENCODING_UNSUPPORTED: '暂不支持此文档编码，请使用 UTF-8 或 UTF-8 BOM',
  FILE_NOT_FOUND: '文件已被移动或删除',
  LOCAL_FILE_NOT_FOUND: '无法找到文件。目标文件已不在原位置，或当前文档已被移动到新位置。',
  PERMISSION_DENIED: '没有权限访问该文件',
  PATH_OUTSIDE_WORKSPACE: '文件路径超出允许范围',
  ASSET_COPY_FAILED: '资源复制失败',
  MEDIA_PREVIEW_UNAVAILABLE: '无法在编辑器中预览',
  MERMAID_VIEWER_LIMIT_REACHED: '最多同时打开 4 个 Mermaid 查看窗口，请先关闭一个窗口',
  PANDOC_NOT_FOUND: '未找到 Pandoc。请安装 Pandoc，或将 pandoc.exe 放入程序目录的 pandoc 文件夹。',
  DOCX_CONVERSION_FAILED: 'DOCX 转换失败',
  DOCUMENT_CONVERSION_COMPONENT_MISSING: '文档转换组件尚未安装',
  DOCUMENT_CONVERSION_PACKAGE_MISSING: '当前安装包缺少文档转换组件',
  DOCUMENT_CONVERSION_INSTALL_FAILED: '文档转换组件安装失败，请重试',
  DOCUMENT_CONVERSION_DOWNLOAD_FAILED: '文档转换组件下载失败，请检查网络连接后重试',
  DOCUMENT_CONVERSION_COMPONENT_INVALID: '文档转换组件校验失败，请重新安装',
  DOCUMENT_CONVERSION_FAILED: '文档转换未能完成，请重试',
  DOCUMENT_CONVERSION_TIMEOUT: '文档转换超时，请重试',
  DOCUMENT_CONVERSION_EMPTY: '未从文档中提取到可转换内容',
  DOCUMENT_CONVERSION_INPUT_TOO_LARGE: '文档超过 256 MiB 限制，无法转换',
  DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE: '转换结果超过 32 MiB 限制，无法创建 Markdown 文档',
  UNTRUSTED_SENDER: '请求来源不受信任',
  OPERATION_FAILED: '操作未能完成',
  WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED: '参数已保存，但部分便签未能应用壁纸材质效果。请重试保存，或取消以结束调节。',
  DEFAULT_APPLICATIONS_UNSUPPORTED: '当前环境无法打开 Windows 默认应用设置',
  DEFAULT_APPLICATIONS_NOT_APPLIED: '注册已完成，但 Windows 尚未将全部格式交给 Arkdown。可在偏好设置中查看状态并手动设置。',
  DEFAULT_APPLICATIONS_RELEASE_FAILED: '未能完整取消 Arkdown 的默认关联。文件打开入口已保留，请检查当前状态或手动设置。',
  DEFAULT_APPLICATIONS_CONFLICT: 'Arkdown 的默认应用注册包含无法识别的配置，原设置已保留，请检查后重试',
  DEFAULT_APPLICATIONS_ROLLBACK_INCOMPLETE: '默认应用注册失败，部分恢复未完成，请检查 Windows 默认应用设置后重试',
  SHELL_INTEGRATION_CONFLICT: '右键菜单已被其他程序配置或修改，请保留原设置并检查冲突',
  SHELL_INTEGRATION_UNSUPPORTED: '当前文件类型的新建菜单布局无法安全配置，原设置已保留',
  SHELL_INTEGRATION_ROLLBACK_INCOMPLETE: '右键菜单操作失败，部分恢复未完成，请检查系统菜单后重试',
  MODEL_NOT_CONFIGURED: '尚未配置划词翻译使用的大模型',
  AI_MODEL_NOT_CONFIGURED: '尚未配置 AI 对话使用的大模型',
  AI_CONTEXT_LIMIT_REACHED: '当前模型上下文容量不足，读取次数仍有剩余也可能发生。请保留已返回的结论，减少引用、缩小文件范围或按章节处理；必要时复制需要保留的结论，再主动清空对话并以较小范围重新开始，也可选择实际支持更大上下文的模型。继续分析不会扩大上下文容量。',
  TOOL_RESULT_TOO_LARGE: '本次工具结果超过当前模型可接受的上下文容量。请保留已返回的结论，减少引用、缩小读取范围或按章节处理；必要时复制需要保留的结论，再主动清空对话并以较小范围重新开始，也可选择实际支持更大上下文的模型。继续分析不会扩大上下文容量。',
  MODEL_AUTHENTICATION_FAILED: '大模型认证失败',
  MODEL_NOT_FOUND: '未找到配置的大模型',
  MODEL_INVALID_ENDPOINT: '大模型接口地址无效或不可用',
  MODEL_TIMEOUT: '大模型请求超时',
  MODEL_RATE_LIMITED: '大模型服务商请求过于频繁',
  MODEL_QUOTA_EXCEEDED: '大模型账户余额或配额不足',
  MODEL_INCOMPATIBLE_RESPONSE: '大模型服务返回的响应格式不兼容',
  MODEL_ENCRYPTION_UNAVAILABLE: 'Windows 加密不可用',
  MODEL_SECRET_UNAVAILABLE: '无法读取已保存的大模型 API Key，请重新输入',
  MODEL_SECRET_STORAGE_FAILED: '大模型 API Key 存储失败',
} as const)

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES

export function isPublicErrorCode(value: unknown): value is PublicErrorCode {
  return (
    typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_MESSAGES, value)
  )
}

export class PublicError extends Error {
  constructor(readonly code: PublicErrorCode) {
    super(PUBLIC_ERROR_MESSAGES[code])
    this.name = 'PublicError'
  }
}

export function appError(code: PublicErrorCode): PublicError {
  return new PublicError(code)
}
