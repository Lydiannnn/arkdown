export interface GuideSection {
  id: string
  title: string
  summary: string
  keywords: string[]
  body: string
}

export interface GuidePage {
  id: 'home' | 'workspace' | 'editing' | 'saving' | 'compatibility' | 'portable' | 'troubleshooting' | 'faq'
  output: string
  title: string
  eyebrow: string
  description: string
  group: '开始使用' | '编辑与保存' | '文件与便携' | '帮助'
  sections: GuideSection[]
}

export interface GuideGroup {
  title: GuidePage['group']
  pageIds: GuidePage['id'][]
}

export const GUIDE_VERSION = '0.1.0'
export const GUIDE_UPDATED_AT = '2026-09-07'

export const DEFERRED_FEATURES = [
  '外部变化实时监听',
  'HTML、PDF 或其他格式导出',
  '主题切换',
  '专注模式和打字机模式',
  '安装器和自动更新',
  '发布 ZIP',
] as const

const steps = (items: string[]) => `<ol class="steps">${
  items.map((item) => `<li><span>${item}</span></li>`).join('')
}</ol>`

const bullets = (items: string[]) => `<ul class="feature-list">${
  items.map((item) => `<li>${item}</li>`).join('')
}</ul>`

const callout = (
  kind: 'info' | 'warning' | 'danger',
  title: string,
  body: string,
) => `<aside class="callout callout-${kind}"><strong>${title}</strong><p>${body}</p></aside>`

const figure = (
  file: string,
  alt: string,
  caption: string,
) => `<figure class="manual-figure">
  <button class="figure-button" type="button"
    data-image-src="{{assetBase}}/images/${file}"
    data-image-alt="${alt}"
    data-image-caption="${caption}"
    aria-label="放大查看：${caption}">
    <img src="{{assetBase}}/images/${file}" alt="${alt}" loading="lazy">
  </button>
  <figcaption>${caption}</figcaption>
</figure>`

export const GUIDE_PAGES: GuidePage[] = [
  {
    id: 'home',
    output: '使用说明书.html',
    title: 'Arkdown 使用说明书',
    eyebrow: 'PRODUCT GUIDE',
    description: '从第一次打开文件夹，到安心编辑和保存 Markdown 文档，这里汇集了 Arkdown 0.1.0 的全部基础用法。',
    group: '开始使用',
    sections: [
      {
        id: 'home-about',
        title: '认识 Arkdown',
        summary: '了解 Arkdown 的用途、本地运行方式和当前版本范围。',
        keywords: ['是什么', '介绍', '本地', '离线', 'Windows', '版本'],
        body: `
          <p>Arkdown 是一款面向 Windows 的本地 Markdown 编辑器。它使用单栏即时渲染方式：正文看起来接近最终阅读效果，同时仍可直接编辑。</p>
          <div class="stat-grid" aria-label="产品特点">
            <div class="stat"><strong>Windows</strong><span>适用于 Windows 10/11 x64</span></div>
            <div class="stat"><strong>完全本地</strong><span>编辑文档不需要联网</span></div>
            <div class="stat"><strong>免安装</strong><span>双击程序即可运行</span></div>
            <div class="stat"><strong>草稿保护</strong><span>编辑内容先备份到程序 temp</span></div>
          </div>
          ${callout('info', '本地独立运行', 'Arkdown 是一款独立的本地编辑器，文档编辑不依赖联网服务。')}
        `,
      },
      {
        id: 'home-first-run',
        title: '三步开始使用',
        summary: '运行程序、选择文件夹并打开第一篇 Markdown 文档。',
        keywords: ['第一次', '开始', '打开文件夹', '运行', '文档'],
        body: `
          ${steps([
            '<strong>运行程序：</strong>在 Arkdown 文件夹中双击 <code>Arkdown.exe</code>。',
            '<strong>选择文件夹：</strong>没有文件、恢复草稿或最近文档可打开时，程序展示只读使用说明书；点击左侧“选择文件夹”、使用“文件 → 打开文件夹”，或把文件夹拖入窗口。',
            '<strong>选择文档：</strong>在左侧文件树中点击支持的 Markdown 或纯文本文档开始编辑。',
          ])}
          ${callout('info', '也可以新建', '使用“文件 → 新建”可进入真正空白的可编辑文档。进入工作区后，也可在文件树空白处或目标文件夹上点击右键并选择“新建文档”；名称未写扩展名时会自动补上 .md。')}
          ${figure('app-start.png', 'Arkdown 空白文档界面', '使用“文件 → 新建”开始空白文档，需要时再打开或拖入工作区。')}
        `,
      },
      {
        id: 'home-interface',
        title: '主界面一览',
        summary: '认识工作区名称、文件树、编辑区、模式开关和保存状态。',
        keywords: ['界面', '文件树', '编辑区', '状态栏', '模式'],
        body: `
          <p>打开工作区后，界面分为三个主要部分：</p>
          ${bullets([
            '<strong>左侧工作区：</strong>可在文件树、文档列表、大纲和搜索之间切换。',
            '<strong>中间编辑区：</strong>用于即时渲染编辑或查看 Markdown 源码。',
            '<strong>底部状态栏：</strong>显示“未保存”“正在保存”“已保存”“保存冲突”等状态。',
          ])}
          <p>Windows 窗口标题显示当前文件名；文档有尚未手动保存的修改时，标题前会出现圆点。菜单栏下方不再额外显示文件名栏。</p>
          ${figure('app-workspace.png', 'Arkdown 工作区主界面，左侧为文件树，右侧为编辑区域', '打开工作区后的主界面：左侧文件树、中间编辑区、右下角保存状态。')}
        `,
      },
      {
        id: 'home-scope',
        title: '当前版本的功能边界',
        summary: '查看 Arkdown 0.1.0 已支持和暂未支持的功能。',
        keywords: ['限制', '不支持', '功能', 'docx', '导出', '主题'],
        body: `
          <p>Arkdown 0.1.0 已支持本地媒体资源、DOCX 导入与导出、临时草稿、异常恢复和对象右键菜单。当前暂未提供以下功能：</p>
          ${bullets([
            '外部变化实时监听',
            'HTML、PDF 或其他格式导出',
            '主题切换',
            '专注模式和打字机模式',
            '安装器和自动更新',
            '发布 ZIP',
          ])}
          ${callout('info', '说明书版本', '本说明书适用于 Arkdown 0.1.0。软件后续增加功能时，说明书也会同步更新。')}
        `,
      },
    ],
  },
  {
    id: 'workspace',
    output: '使用说明书/workspace.html',
    title: '工作区与文件',
    eyebrow: 'WORKSPACE',
    description: '把一个普通文件夹作为工作区，在左侧文件树中浏览并打开 Markdown 文档。',
    group: '开始使用',
    sections: [
      {
        id: 'workspace-concept',
        title: '什么是工作区',
        summary: '工作区就是存放 Markdown 文档的普通 Windows 文件夹。',
        keywords: ['工作区', '文件夹', '目录', '笔记'],
        body: `
          <p>工作区不是特殊数据库，而是你在 Windows 中已经使用的普通文件夹。Arkdown 只在这个文件夹范围内显示支持的 Markdown 文件。</p>
          ${callout('info', '文档仍属于你', '文件始终保存在原来的工作区中，可以继续使用资源管理器、备份软件或其他文本编辑器管理。')}
        `,
      },
      {
        id: 'workspace-open',
        title: '打开或更换工作区',
        summary: '从使用说明书或文档界面打开文件夹，也可拖入文件夹直接切换。',
        keywords: ['打开文件夹', '选择', '更换', '切换工作区', '拖入'],
        body: `
          ${steps([
            '启动时优先打开指定文件，其次恢复草稿、打开最近文档；没有可打开的内容时显示只读使用说明书。',
            '点击左侧“选择文件夹”、选择“文件 → 打开文件夹”，或把 Windows 文件夹拖入窗口。文件夹选择器会记住上次通过该方式选择的位置。',
            '确认后，文件夹名称和支持的文档会显示在左侧。',
            '需要更换工作区时，再次使用“打开文件夹”或拖入另一个文件夹。',
          ])}
          ${callout('info', '不会主动修改文件夹', '只打开工作区不会改写其中的文档；只有手动保存当前文档时才写入原文件。')}
        `,
      },
      {
        id: 'workspace-tree',
        title: '浏览文件树',
        summary: '展开子文件夹并选择支持的 Markdown 或纯文本文档。',
        keywords: ['文件树', '展开', '子文件夹', '.md', '.markdown', '.txt'],
        body: `
          ${bullets([
            '点击文件夹左侧的三角标记可展开或收起子文件夹。',
            '子文件夹只在第一次展开时读取，较大的工作区也能逐步浏览。',
            '点击文件名即可在中间编辑区打开。',
            '文档注册表支持常见 Markdown 扩展名以及 <code>.txt</code>、<code>.text</code>；详细清单见“格式兼容与数据安全”。',
            '“文档”按名称列出支持的文档，并显示路径和三行正文摘要；摘要不会重复标题。',
            '“大纲”显示当前文档标题结构；有下级标题的项目可以折叠或展开。<br>“搜索”在输入关键字并按 Enter 后，按文件名或正文检索当前文件夹；点击输入框后的“×”可以取消搜索。',
          ])}
          ${figure('file-tree.png', 'Arkdown 文件树，显示文件夹和支持的文档', '展开文件夹后，点击文档即可在编辑区打开。')}
        `,
      },
      {
        id: 'workspace-switch-documents',
        title: '切换文档与拖入文档',
        summary: '有未保存修改时先确认；有内容的窗口接收拖入文档时会另开窗口。',
        keywords: ['切换文档', '拖入文件', '新窗口', '保存提示'],
        body: `
          ${bullets([
            '点击另一篇文档前，如当前内容有修改，软件会询问“保存”“不保存”或“取消”。',
            '把支持的文档拖到空白窗口，可在当前窗口打开。',
            '当前窗口已经显示文档或已有内容时，拖入另一篇文档会新建窗口打开，不会覆盖当前编辑状态。',
            '把文件夹拖入窗口会切换工作区；如当前内容有修改，也会先出现保存确认。',
          ])}
        `,
      },
      {
        id: 'workspace-context-menus',
        title: '用右键管理工作区',
        summary: '在文件树、文档列表和搜索结果中管理文档与文件夹。',
        keywords: ['右键', '重命名', '创建副本', '回收站', '属性', '新窗口'],
        body: `
          <p>在左侧文件树、文档列表或搜索结果中右键文档，会显示与当前对象匹配的菜单。右键只选择目标并打开菜单，不会同时打开文档。</p>
          ${bullets([
            '<strong>文档：</strong>打开、在新窗口中打开、重命名、创建副本、显示位置、复制绝对路径、移到回收站和查看属性。',
            '<strong>文件夹：</strong>新建文档或文件夹、重命名、在新窗口中打开、显示位置、复制绝对路径、移到回收站和查看属性。',
            '<strong>文件树空白处：</strong>新建文档或文件夹、打开文件或文件夹、刷新、打开工作区位置和查看属性。',
          ])}
          ${callout('warning', '删除和重命名前先处理未保存内容', '如果操作会影响当前打开的文档，Arkdown 会先询问保存、不保存或取消；删除文件夹还会进行第二次确认。')}
          ${callout('info', '创建副本不会覆盖', '文档副本依次命名为“名称 - 副本”“名称 - 副本 (2)”等，已有文件不会被静默覆盖。')}
        `,
      },
      {
        id: 'workspace-missing-files',
        title: '文件没有显示怎么办',
        summary: '检查扩展名、文件夹位置和读取权限。',
        keywords: ['看不到', '不显示', '文件丢失', '扩展名', '权限'],
        body: `
          ${steps([
            '确认文件位于当前工作区或它的子文件夹中。',
            '确认文件使用“支持的文件”章节列出的扩展名；<code>.docx</code> 会显示并通过 Pandoc 导入。',
            '在 Windows 资源管理器中确认文件夹仍然存在并且可以读取。',
            '如果文件是刚从外部加入的，请点击侧栏刷新按钮，或重新打开工作区。',
          ])}
          ${callout('info', '两种搜索不要混淆', '软件侧栏“搜索”检索当前工作区；说明书左侧搜索只检索帮助内容。')}
        `,
      },
    ],
  },
  {
    id: 'editing',
    output: '使用说明书/editing.html',
    title: 'Markdown 编辑',
    eyebrow: 'EDITING',
    description: '在即时渲染和 Markdown 源码之间切换，用最适合当前任务的方式编辑。',
    group: '编辑与保存',
    sections: [
      {
        id: 'editing-visual',
        title: '即时渲染模式',
        summary: '默认使用接近最终阅读效果的单栏编辑方式。',
        keywords: ['即时渲染', '视觉模式', '所见即所得', '默认模式'],
        body: `
          <p>打开文档后默认进入即时渲染模式。标题、列表、强调、引用、链接和代码等常规 Markdown 内容会显示为排版后的样式，可以像编辑普通文章一样直接修改。</p>
          ${callout('info', 'Markdown 仍是源文件', '即时渲染只改变编辑体验，保存到磁盘的仍然是标准 Markdown 文本。')}
          ${figure('visual-mode.png', 'Arkdown 即时渲染模式，Markdown 显示为排版后的正文', '即时渲染模式把 Markdown 显示成接近最终阅读效果的单栏正文。')}
        `,
      },
      {
        id: 'editing-source',
        title: '源码模式',
        summary: '查看和编辑完整 Markdown 标记。',
        keywords: ['源码', 'Markdown 标记', '原始文本', '切换'],
        body: `
          <p>点击编辑区上方的模式开关可进入源码模式。此时会显示完整 Markdown 标记，适合精确检查标题符号、列表缩进、链接地址或其他原始文本。</p>
          <p>再次点击模式开关即可返回即时渲染模式。</p>
          ${figure('source-mode.png', 'Arkdown 源码模式，显示完整 Markdown 标记和行号', '源码模式适合检查 Markdown 标记、缩进和链接地址。')}
        `,
      },
      {
        id: 'editing-mermaid',
        title: 'Mermaid 图表',
        summary: '用标准 Mermaid 围栏保留源码，并在即时渲染模式查看本地图形。',
        keywords: ['Mermaid', '图表', '流程图', '围栏代码', '编辑源码', '显示图形', '离线'],
        body: `
          <p>在 Markdown 中使用标准 <code>mermaid</code> 围栏即可创建图表：</p>
          <pre><code>\`\`\`mermaid
flowchart LR
  A[开始] --&gt; B[完成]
\`\`\`</code></pre>
          <p>Markdown 源码是唯一的数据源。Arkdown 不会把生成的 SVG 写回文档；无论切换整个编辑器的源码模式，还是在图表工具栏选择“编辑源码”或“显示图形”，保存的仍是同一段围栏文本。</p>
          ${callout('info', '本地、按需生成', 'Mermaid 随 Arkdown 一起运行，只在需要显示图表时加载。日常编辑、图形显示和重新打开文档均无需联网。')}
          ${callout('warning', '语法错误或无法显示', '图形区域会提示“Mermaid 语法错误”或资源限制错误，但不会删除或替换你的源码。点击“编辑源码”检查围栏、图表类型和连线；修正后会重新生成图形。')}
          <p>为避免单个文档占用过多资源，每个 Mermaid 源码块最多 20,000 个字符、100 条边；同一编辑器最多显示 30 个 Mermaid 图块。单次生成预算为 2.5 秒，超时或队列繁忙时请简化图表后重试。</p>
          <p>选择“文件 → 打印”或按 <kbd>Ctrl</kbd> + <kbd>P</kbd> 时，Arkdown 会强制调度并等待文档中的全部 Mermaid 图块进入终态，因此可以通过 Windows 打印对话框输出到纸张或 PDF。导出 DOCX 时，首版只保留 Mermaid 源码块，不会把图表转换为 DOCX 内的图片。</p>
        `,
      },
      {
        id: 'editing-mode-history',
        title: '切换模式与撤销',
        summary: '两种模式共享内容，但各自使用新的本地撤销历史。',
        keywords: ['撤销', 'Ctrl+Z', '历史', '切换模式', 'undo'],
        body: `
          <p>切换模式前，Arkdown 会先同步当前内容。切换后看到的是同一篇文档，但目标编辑器会建立新的撤销历史。</p>
          ${callout('warning', '撤销不会跨越模式边界', '切换模式后按 Ctrl+Z，只撤销在当前模式中完成的编辑，不会回到另一个模式切换前的编辑状态。')}
        `,
      },
      {
        id: 'editing-basics',
        title: '常用编辑操作',
        summary: '输入中文、选中文本并使用常规 Markdown 结构。',
        keywords: ['中文输入', '标题', '列表', '粗体', '引用', '代码'],
        body: `
          ${bullets([
            '直接输入中文或英文正文。',
            '使用标题、段落、有序列表、无序列表和引用组织内容。',
            '使用粗体、斜体、删除线、行内代码和链接表达重点。',
            '使用围栏代码块保存多行代码或命令。',
            '按 <kbd>Ctrl</kbd> + <kbd>Z</kbd> 撤销当前模式中的最近编辑。',
          ])}
        `,
      },
      {
        id: 'editing-context-menus',
        title: '编辑区右键菜单',
        summary: '菜单会按普通文字、链接、图片或表格切换，并在代码块和列表中显示当前状态。',
        keywords: ['右键菜单', '浏览器搜索', '段落', '插入', '图片', '表格', '代码块'],
        body: `
          <p>在即时渲染模式中右键，Arkdown 会先判断鼠标所在对象，再显示对应菜单。菜单会根据文字、链接、图片或表格显示相应分组和子菜单；原来的行悬停“＋”和整行拖拽手柄已移除。</p>
          ${bullets([
            '<strong>普通文字：</strong>默认浏览器搜索、剪切/复制/粘贴、粗体、斜体、代码块、链接、引用、三类列表、增减缩进、段落和插入。',
            '<strong>结构按钮：</strong>引用、代码块、无序列表、有序列表和任务列表采用开关按钮；按钮高亮表示当前位置已启用，再点一次会恢复正文。',
            '<strong>代码块和任务列表：</strong>右键菜单与普通正文一致，不再显示单独的对象菜单。',
            '<strong>链接：</strong>打开、复制地址、编辑地址或移除文档内链接。',
            '<strong>图片：</strong>显示位置、复制、另存副本、复制到新位置、复制地址、切换语法、缩放、替代文本和删除引用。',
            '<strong>表格：</strong>插入或删除行列、对齐、移动、复制为 Markdown/HTML 和格式化。',
            '<strong>源码模式：</strong>提供搜索、撤销/重做、剪贴板、常用格式和整行上移/下移。',
          ])}
          ${callout('info', '使用默认浏览器搜索', '先选择文字再右键，选择“使用默认浏览器搜索”。Arkdown 只在你主动点击时，把选中文字交给系统默认浏览器。')}
        `,
      },
      {
        id: 'editing-ai-conversation',
        title: 'AI 对话与文档授权',
        summary: '在右侧栏与已配置的大模型多轮对话，并按需授权读取当前文档。',
        keywords: ['AI 对话', '大模型设置', '文档授权', '/文档', '/document', '代码解读', '右侧栏'],
        body: `
          <p>点击编辑区右侧栏中的“AI 对话”标签，可以和已配置的大模型进行多轮对话。首次使用前，先选择“文件 → 偏好设置”，再进入“大模型设置”为“AI 对话”指定模型和推理强度。</p>
          <p>“允许 AI 查看文档”是权限开关，不是上传按钮。点击后只表示你同意当前文档在当前对话中可被读取；Arkdown 不会因为这一步立即读取、复制或发送文档内容。</p>
          ${bullets([
            '<strong>按需授权：</strong>当模型确实需要当前文档时，Arkdown 才会在对话里显示授权卡片。你可以选择“仅本次允许”“本对话允许”或“拒绝”。',
            '<strong>一次性命令：</strong>在输入框开头输入 <code>/文档</code> 或 <code>/document</code>，只为当前这一轮消息提供一次性文档访问。命令前缀会在发送前移除，不会原样交给模型。',
            '<strong>撤销与失效：</strong>已授权时按钮会显示为“AI 可查看文档”，再次点击即可撤销。清空当前文档的对话、切换到另一篇文档，或关闭窗口后，这个授权也会自动失效。',
            '<strong>读取内容：</strong>模型读取的是当前编辑区里的规范化 Markdown，包含尚未保存的修改，而不是重新从磁盘读取旧文件。模型可见内容只包括显示名称、源格式、是否未保存，以及分页状态 <code>cursor</code>、<code>nextCursor</code>、<code>hasMore</code>、<code>totalChars</code> 和当前这一页的 Markdown 正文；内部用于授权归属校验的 <code>documentKey</code> 不会发给模型，也不包含绝对路径。',
            '<strong>代码解读：</strong>普通可编辑代码块会显示“代码解读”入口。点击后只把该代码块的语言和代码内容作为本轮问题发送到“AI 对话”，不会自动附带整篇文档。',
            '<strong>图片限制：</strong>首版不会把 Markdown 中引用的图片作为视觉输入发送给模型，也不会自动执行 OCR。模型只能看到正文、链接文字和图片替代文本等已经写在 Markdown 里的内容。',
            '<strong>会话保存：</strong>AI 对话记录只保存在当前应用会话内，不写入磁盘；不同文档的对话彼此独立。',
          ])}
        `,
      },
      {
        id: 'editing-search-preferences',
        title: '偏好设置与排版显示',
        summary: '选择搜索提供商，并设置单换行、标题/正文字体、最小边距和即时渲染正文宽度。',
        keywords: ['偏好设置', '最小边距', '正文宽度', '单个换行', '标题字体', '正文字体', '搜索引擎', 'Bing', '百度', 'Google', 'DuckDuckGo', '自定义'],
        body: `
          <p>选择“文件 → 偏好设置”，当前窗口会进入单独的偏好设置页面。有效的设置修改会立即生效并自动保存，无需另行确认。点击左上角“返回”回到编辑器，不会撤销已经修改的设置；尚未填写完整或不合法的内容不会保存，页面会显示提示。</p>
          <p>在“大模型设置”下选择“管理大模型”可进入模型管理页。该页左上角与底部的“返回”都会回到上一层偏好设置，不会撤销模型配置；连接、测试及删除等操作仍使用各自的按钮或确认提示。</p>
          <p>“浏览器搜索”区域可以为“使用默认浏览器搜索”选择提供商。默认使用百度，也可选择 Bing、Google、DuckDuckGo，或填写含 <code>{query}</code> 的自定义 HTTPS 搜索地址。</p>
          <p>“编辑器”区域默认开启“保留单个换行”。开启时，源码中的每个真实换行都会在即时渲染中显示；关闭时遵循标准 Markdown，把段落中的单换行合并显示。此功能不会在文件中生成额外的 <code>&lt;br /&gt;</code>。</p>
          <p>标题和正文分别提供中文、英文字体选择，列表来自本机已安装字体；默认英文字体为 Arial，默认中文字体为黑体（SimHei）。字体只影响 Arkdown 显示，不修改 Markdown 内容。</p>
          <p>最小边距滑块范围为 30px～150px，控制正文左右两侧各自保留的最小距离；正文宽度滑块范围为 600px～1200px，控制正文允许达到的最大宽度。窗口变窄时，最小边距保持不变，正文会自动收窄和换行；图片和表格也会适应可用宽度。设置自动保存后会在下次启动时继续使用。</p>
          ${callout('warning', '不会读取浏览器内部设置', 'Windows 只允许应用把地址交给默认浏览器。Arkdown 无法自动读取浏览器内部的默认搜索引擎；如需一致，请在偏好设置中选择相同提供商。')}
        `,
      },
      {
        id: 'editing-sticky-note-box',
        title: '便签盒子与实时保存',
        summary: '创建、导入、搜索和整理便签，并把选中的 Markdown 内容直接建立为便签。',
        keywords: ['便签盒子', '创建便签', '实时保存', '导入便签', '归档', '搜索', '35个', '建立便签'],
        body: `
          <p>点击编辑面板工具栏中的“便签盒子”按钮可以打开或关闭管理面板。第一次使用时，盒子内已经有一篇“便签盒子使用说明”；点击便签卡片会打开独立的便签编辑窗口。</p>
          ${steps([
            '点击“创建新便签”，确认或修改自动生成的名称。活跃便签最多保存 35 个；归档便签不占用这个上限。',
            '在便签窗口中输入内容。停止输入约 500 毫秒后会实时保存，状态栏依次显示“实时保存中...”和“已保存”。',
            '在便签盒子中按 Ctrl+F 搜索活跃便签；切换到“归档”后可单独搜索归档内容。',
            '在便签卡片上点击右键，可以改变颜色和材质、设置图片背景、重命名、归档或删除。',
          ])}
          ${bullets([
            '<strong>导入文件：</strong>把 <code>.md</code>、<code>.markdown</code> 或 <code>.txt</code> 拖入便签盒子即可导入；Markdown 引用的本地资源会复制到便签自己的资源目录，源文档和源资源不会被修改。',
            '<strong>从正文建立：</strong>在编辑区选中内容，点击右键并选择“建立便签”。标题、列表、链接、加粗、表格和可识别的本地图片会尽量按 Markdown 格式保留。',
            '<strong>归档：</strong>归档适合收纳暂时不用的便签；归档便签只能预览，恢复到便签盒子后才能继续编辑。',
            '<strong>默认样式：</strong>在 Arknote 设置中选择 Mica、Acrylic 或颜色，只影响新便签。颜色便签保存独立快照；修改默认值或恢复默认均不改变已有便签，旧色板和底纹继续兼容。',
          ])}
          ${callout('warning', '实时保存不是原文档保存', '便签是便签盒子中的独立 Markdown 文档。把正文建立或导入为便签只会创建副本，不会改写原文档。')}
          ${figure('sticky-note-box.png', 'Arkdown 主窗口右侧打开便签盒子，显示创建新便签和现有便签卡片', '便签盒子集中管理活跃便签和归档便签；卡片可打开、搜索或通过右键整理。')}
        `,
      },
      {
        id: 'editing-media',
        title: '拖入图片、音频和视频',
        summary: '把本地媒体拖到编辑区域，以本地源路径插入可预览内容。',
        keywords: ['拖入图片', '音频', '视频', '预览', '源路径', '本地资源'],
        body: `
          ${steps([
            '把本地图片、音频或视频文件拖到右侧编辑区域；拖到侧栏不会插入。',
            'Arkdown 在光标位置插入该资源的 Windows 绝对源路径，不复制或改写原资源。',
            '图片直接显示预览；音频显示播放条；视频显示画面，鼠标移入时可使用播放控件。',
            '手动保存文档，使插入的引用写入原文件。',
          ])}
          ${bullets([
            '<strong>图片：</strong><code>.png</code>、<code>.jpg</code>、<code>.jpeg</code>、<code>.gif</code>、<code>.webp</code>、<code>.bmp</code>、<code>.svg</code>。',
            '<strong>音频：</strong><code>.mp3</code>、<code>.wav</code>、<code>.ogg</code>、<code>.m4a</code>、<code>.aac</code>、<code>.flac</code>。',
            '<strong>视频：</strong><code>.mp4</code>、<code>.webm</code>、<code>.ogv</code>、<code>.mov</code>、<code>.m4v</code>。',
          ])}
          ${callout('warning', '不要移动引用资源', '文档保存的是本地源路径。以后移动或删除源文件，预览或链接会失效；右键“复制图片到”可以先建立新副本，再更新文档引用。')}
        `,
      },
      {
        id: 'editing-pdf',
        title: '拖入并打开 PDF',
        summary: 'PDF 以本地链接插入，按 Ctrl 并点击可用系统默认程序打开。',
        keywords: ['PDF', 'Ctrl+点击', '默认程序', '文件已被移动或删除'],
        body: `
          <p>把 <code>.pdf</code> 文件拖到编辑区域后，Arkdown 会插入包含原文件绝对路径的链接；鼠标移到链接上时显示手型，提示该链接可以点击。</p>
          ${steps([
            '按住 <kbd>Ctrl</kbd>。',
            '点击 PDF 链接。',
            'Windows 使用系统默认 PDF 程序打开文件。',
          ])}
          ${callout('warning', '链接找不到文件时', '如果资源后来被移动或删除，点击链接会提示“文件已被移动或删除”。请重新拖入文件，或在源码模式修正引用。')}
        `,
      },
    ],
  },
  {
    id: 'saving',
    output: '使用说明书/saving.html',
    title: '保存与状态',
    eyebrow: 'SAVING',
    description: '理解临时草稿、手动保存和异常恢复，分清 temp 副本与原文件。',
    group: '编辑与保存',
    sections: [
      {
        id: 'saving-auto',
        title: '自动备份临时草稿',
        summary: '停止输入约 800 毫秒后备份草稿，但不自动改写原文件。',
        keywords: ['临时草稿', '自动备份', '800毫秒', 'temp', '原文件'],
        body: `
          <p>文档发生修改后，Arkdown 会在停止输入约 800 毫秒后，把当前内容备份到程序目录的 <code>temp</code> 文件夹。持续输入时也会定期刷新草稿。</p>
          ${callout('info', '不会自动覆盖原文件', '看到“已备份到临时草稿”只表示恢复副本已经写入 <code>temp</code>；原始文档仍保持打开时的内容，直到你手动保存。')}
        `,
      },
      {
        id: 'saving-manual',
        title: '手动保存原文件',
        summary: '按 Ctrl+S 才把当前内容写入原文件。',
        keywords: ['Ctrl+S', '手动保存', '原文件', '另存为'],
        body: `
          <p>按 <kbd>Ctrl</kbd> + <kbd>S</kbd>，或选择“文件 → 保存”，可把当前内容写入原文件。保存完成后，底部显示“已保存”，对应临时草稿会被移除。</p>
          <p>未命名文档第一次保存时会打开“另存为”窗口。图片、音频、视频和 PDF 继续引用你拖入时的原文件绝对路径；保存文档不会复制、移动或改写这些资源。</p>
        `,
      },
      {
        id: 'saving-close',
        title: '关闭、切换与未保存提示',
        summary: '主动离开有修改的文档时，可选择保存、不保存或取消。',
        keywords: ['关闭窗口', '保存', '不保存', '取消', '切换文档'],
        body: `
          <p>关闭窗口、切换文档或更换工作区时，如果当前内容尚未手动保存，Arkdown 会先显示确认窗口：</p>
          ${bullets([
            '<strong>保存：</strong>写入原文件；未命名文档会先询问保存位置。',
            '<strong>不保存：</strong>放弃本次修改，并删除对应临时草稿。',
            '<strong>取消：</strong>留在当前窗口继续编辑。',
          ])}
          ${callout('warning', '意外结束不会弹窗', '崩溃、断电或在任务管理器中结束进程时无法询问；此时依靠 <code>temp</code> 中的草稿在下次启动时恢复。')}
        `,
      },
      {
        id: 'saving-statuses',
        title: '状态栏说明',
        summary: '区分草稿备份、原文件保存、出错和保存冲突。',
        keywords: ['状态栏', '未保存', '临时草稿', '已保存', '保存冲突'],
        body: `
          <div class="status-table-wrap"><table class="status-table">
            <thead><tr><th>状态</th><th>含义</th><th>需要做什么</th></tr></thead>
            <tbody>
              <tr><td>就绪</td><td>尚未打开文档</td><td>打开文件夹或拖入文档</td></tr>
              <tr><td>未保存</td><td>内容已经修改</td><td>等待草稿备份或按 Ctrl+S</td></tr>
              <tr><td>正在备份草稿…</td><td>正在写入 temp</td><td>短暂等待</td></tr>
              <tr><td>已备份到临时草稿</td><td>恢复副本已更新，原文件未变</td><td>需要写回原文件时按 Ctrl+S</td></tr>
              <tr><td>正在保存原文件…</td><td>正在写入原文档</td><td>等待保存完成</td></tr>
              <tr><td>已保存</td><td>当前内容已经写入原文件</td><td>无需操作</td></tr>
              <tr><td>出错</td><td>本次操作没有成功</td><td>阅读错误信息并排查</td></tr>
              <tr><td>保存冲突</td><td>原文件在编辑期间发生变化</td><td>先保护当前内容，再人工合并</td></tr>
            </tbody>
          </table></div>
          ${figure('save-states.png', 'Arkdown 编辑界面右下角显示保存状态', '右下角状态栏区分临时草稿备份与原文件保存。')}
        `,
      },
      {
        id: 'saving-recovery',
        title: '异常退出后的恢复',
        summary: '下次启动时可从程序 temp 中恢复意外关闭前的编辑内容。',
        keywords: ['恢复未保存的内容', '崩溃恢复', '进程被杀', 'temp', '异常退出'],
        body: `
          <p>如果程序崩溃、断电或进程被强制结束，下次启动 Arkdown 时会检查可恢复草稿，并显示“恢复未保存的内容”。</p>
          ${steps([
            '选择“恢复”，每份草稿会在窗口中打开，内容以 <code>temp</code> 中的恢复副本为准。',
            '检查恢复内容；此时原文件仍未被改写。',
            '确认后按 Ctrl+S 写回原文件，或使用“另存为”保留成新文档。',
            '选择“暂不恢复”会保留草稿，但不会在以后每次启动时重复提示。',
          ])}
          ${callout('warning', '原文件已变化', '如果恢复期间检测到原文件在草稿创建后被其他程序修改，会显示保存冲突。请先另存恢复内容，再人工比较两个版本。')}
        `,
      },
      {
        id: 'saving-error',
        title: '保存失败',
        summary: '操作失败时保留编辑窗口，检查权限、空间和文件状态后重试。',
        keywords: ['保存失败', '草稿失败', '出错', '磁盘满', '只读', '权限'],
        body: `
          ${steps([
            '不要立即关闭程序，先保留当前编辑窗口。',
            '查看状态栏“出错”后面的信息。',
            '检查程序文件夹和工作区是否可写，以及磁盘是否仍有空间。',
            '问题处理后按 Ctrl+S 重试；状态变为“已保存”后再继续。',
          ])}
          ${callout('danger', '先复制重要修改', '如果错误持续存在，请切换到源码模式，按 Ctrl+A、Ctrl+C，把当前 Markdown 临时粘贴到记事本中。')}
        `,
      },
      {
        id: 'saving-conflict',
        title: '处理保存冲突',
        summary: '原文件被外部修改时，先另存当前编辑，再人工合并两个版本。',
        keywords: ['保存冲突', '外部修改', '另存为', '合并'],
        body: `
          <p>保存时如果发现原文件已不是打开时的版本，Arkdown 会停止覆盖并显示“保存冲突”。这是为了避免覆盖其他程序写入的内容。</p>
          ${steps([
            '先使用“文件 → 另存为”，把 Arkdown 中的当前内容保存成新文件。',
            '在其他编辑器中打开磁盘上的原文件。',
            '对比两份内容，人工合并后再保存。',
          ])}
          ${callout('warning', '当前版本的限制', 'Arkdown 0.1.0 没有内置冲突合并按钮，也没有外部变化实时监听；冲突通常在下一次保存时才会发现。')}
          ${figure('save-conflict.png', 'Arkdown 状态栏显示保存冲突和原文件已变化提示', '检测到原文件发生变化时，Arkdown 停止覆盖并显示“保存冲突”。')}
        `,
      },
    ],
  },
  {
    id: 'compatibility',
    output: '使用说明书/compatibility.html',
    title: '格式兼容与数据安全',
    eyebrow: 'FILES & SAFETY',
    description: '了解支持的文件、字符编码、换行方式以及 Arkdown 的安全保存原则。',
    group: '文件与便携',
    sections: [
      {
        id: 'compatibility-files',
        title: '支持的文件',
        summary: '文档、拖入和文件树共同使用一份文档类型注册表。',
        keywords: ['支持格式', '.md', '.markdown', '.txt', '文档类型注册表', 'docx'],
        body: `
          <p>Arkdown 使用唯一的“文档类型注册表”，因此文件树、打开窗口和拖入识别采用同一套扩展名规则。</p>
          ${bullets([
            '<strong>Markdown：</strong><code>.md</code>、<code>.markdown</code>、<code>.mmd</code>、<code>.mkd</code>、<code>.mdwn</code>、<code>.mdown</code>、<code>.mdx</code>。',
            '<strong>Markdown 相关文本：</strong><code>.mdtxt</code>、<code>.mdtext</code>、<code>.apib</code>、<code>.rmarkdown</code>、<code>.rmd</code>、<code>.qmd</code>。',
            '<strong>纯文本：</strong><code>.txt</code>、<code>.text</code>。',
            '<strong>Word：</strong><code>.docx</code> 通过 Pandoc 转换为可编辑的 Markdown 会话；导入本身不算修改，实际编辑后才显示“未保存”。也可把当前 Markdown 导出为新的 DOCX。',
          ])}
          ${callout('info', 'DOCX 不会被直接改写', '导入 DOCX 只读取源文件；未编辑时可以直接关闭，修改后保存会选择 Markdown 位置。导出时必须选择新的 DOCX，不能覆盖导入源文件。')}
        `,
      },
      {
        id: 'compatibility-assets',
        title: '本地资源引用',
        summary: '媒体和附件保留原位置，文档记录本地绝对源路径。',
        keywords: ['源路径', '本地资源', '图片', '音频', '视频', 'PDF'],
        body: `
          <p>图片、音频、视频、PDF 和 XLSX 拖入编辑区域后，文档引用原文件的 Windows 绝对路径。Arkdown 不复制、移动、重命名或删除这些被引用资源。</p>
          ${callout('warning', '移动文档时', '绝对路径引用不会随文档一起移动。需要整理资源时，请先用图片右键“复制图片到”创建副本并更新引用，或在源码模式手动调整链接。')}
        `,
      },
      {
        id: 'compatibility-encoding',
        title: '字符编码',
        summary: '支持 UTF-8 和带 BOM 的 UTF-8 文档。',
        keywords: ['UTF-8', 'BOM', '乱码', '编码'],
        body: `
          <p>Arkdown 支持 UTF-8 和带 UTF-8 BOM 的 Markdown 文件。保存时会保留文件原有的 BOM 形式。</p>
          ${callout('warning', '出现乱码时', '文件可能使用了 GBK、UTF-16 等其他编码。请先在能识别该编码的编辑器中转换为 UTF-8，再用 Arkdown 打开。')}
        `,
      },
      {
        id: 'compatibility-newlines',
        title: '换行格式',
        summary: '保留原文件的 Windows CRLF 或 Unix LF 换行。',
        keywords: ['换行', 'CRLF', 'LF', 'Windows'],
        body: `
          <p>文件原来使用 Windows 的 CRLF 还是常见于跨平台项目的 LF，Arkdown 保存时都会继续使用原来的换行方式。</p>
        `,
      },
      {
        id: 'compatibility-safe-write',
        title: '安全写入与草稿隔离',
        summary: '编辑先写临时草稿，手动保存时才检查版本并替换原文件。',
        keywords: ['安全', '原子写入', '临时草稿', '不重写', '版本检查', '备份'],
        body: `
          ${bullets([
            '只打开但没有编辑的文件不会被重新写入。',
            '普通编辑只更新程序 <code>temp</code> 中的草稿，不直接改写原文件。',
            '手动保存前会确认原文件仍是打开时的版本。',
            '写入完成后再替换原文件，降低只写入一部分内容的风险。',
          ])}
          ${callout('info', '临时草稿不等于历史备份', '草稿只保留当前恢复状态，不提供多个历史版本。重要工作区仍应使用文件历史、云盘版本或其他独立备份。')}
        `,
      },
      {
        id: 'compatibility-permissions',
        title: '只读、权限与磁盘空间',
        summary: '检查文件属性、文件夹写入权限和剩余磁盘空间。',
        keywords: ['只读', '权限不足', '磁盘空间', '无法写入'],
        body: `
          ${bullets([
            '在资源管理器的文件属性中检查是否勾选“只读”。',
            '确认当前 Windows 账号对工作区有写入权限。',
            '确认磁盘仍有可用空间。',
            '不要把日常工作区放在需要管理员权限的系统目录中。',
          ])}
        `,
      },
    ],
  },
  {
    id: 'portable',
    output: '使用说明书/portable.html',
    title: '免安装版使用',
    eyebrow: 'PORTABLE',
    description: '直接运行、整体移动和备份 Arkdown 文件夹，不在电脑中安装额外服务。',
    group: '文件与便携',
    sections: [
      {
        id: 'portable-run',
        title: '直接运行',
        summary: '解压或复制程序文件夹后双击 Arkdown.exe。',
        keywords: ['免安装', '直接运行', 'exe', '管理员'],
        body: `
          <p>Arkdown 不需要安装。把完整程序文件夹放在有写入权限的位置，双击 <code>Arkdown.exe</code> 即可。</p>
          ${callout('warning', '不要在压缩包内直接运行', '如果收到的是压缩文件，请先完整解压，再运行其中的程序。当前项目本身不提供发布 ZIP。')}
          ${figure('portable-folder.png', 'Windows 资源管理器中的 Arkdown 免安装版目录', '移动或备份时应整体保留 Arkdown.exe、resources、使用说明书和 portable-data 等内容。')}
        `,
      },
      {
        id: 'portable-data',
        title: '便携设置与临时草稿目录',
        summary: '程序目录可写时，设置和恢复草稿都保存在程序旁边。',
        keywords: ['portable-data', 'temp', '设置', '临时草稿', '恢复'],
        body: `
          ${bullets([
            '<code>portable-data</code>：保存窗口位置等少量程序设置。',
            '<code>temp</code>：保存编辑中的临时草稿和未命名文档资源，用于异常恢复。',
            '<code>使用说明书.html</code> 与 <code>使用说明书</code>：本地帮助知识库。',
          ])}
          ${callout('warning', '移动前先手动保存', '关闭程序并确认重要文档已经按 Ctrl+S 写回原文件。不要在程序运行时移动或删除 <code>temp</code>。')}
        `,
      },
      {
        id: 'portable-shell-default-applications',
        title: 'Windows 右键菜单与 md/txt 默认程序',
        summary: '在偏好设置中管理三个右键入口，通过 Windows 确认 Markdown 和文本文档的默认程序。',
        keywords: ['右键菜单', '使用Arkdown打开', '创建新便签', '新建 Markdown', '默认程序', 'md', 'txt'],
        body: `
          <p>打开“文件 → 偏好设置 → 右键菜单”，可以分别控制以下三个入口：</p>
          ${bullets([
            'md/txt文档上右键增加“使用Arkdown打开”',
            '在桌面右键菜单中增加“创建新便签”',
            '在右键‘新建’菜单中增加 Markdown 文档',
          ])}
          <p>首次正常启动时，这三个入口默认启用；以前手动关闭的选项会继续保持关闭。未能完成注册的入口会显示为未勾选，可以再次勾选重试。文档打开入口只适用于 .md 和 .txt；TXT 文档的“新建”入口暂未提供。</p>
          <p>同一区域的“md/txt默认程序”提供“将Arkdown设为Markdown文件和文本文档的默认程序”。点击后会打开 Windows 的默认应用设置，在系统中分别为 .md 和 .txt 选择当前 Arkdown。较早的 Windows 版本会打开默认应用总页，可在其中查找 Arkdown 或文件扩展名。</p>
          <p>回到 Arkdown 后，只有两种文件都已由当前 Arkdown 默认打开，复选框才会勾选。只修改一种、取消系统设置或仅打开设置页，都不会显示为全部完成。点击已勾选的选项也会打开系统设置，方便选择其他程序。</p>
          <p>此功能启用后的第二次正常启动会询问“是否将Arkdown设为Markdown文件和文本文档的默认程序？”。选择“是”进入系统确认流程；选择“稍后”保持原有默认程序，后续仍可从偏好设置打开。两种文件都已经默认使用当前 Arkdown 时不会询问，此提示也不会在每次启动时重复出现。</p>
          ${callout('info', '移动免安装文件夹后', 'Windows 菜单与默认程序使用程序的位置。移动前可先关闭三个右键入口；移动后重新开启，并在系统默认应用中重新选择当前 Arkdown。遇到注册冲突时保留现有设置，按提示处理后重试。')}
        `,
      },
      {
        id: 'portable-sticky-note-lifecycle',
        title: '桌面便签、系统托盘与开机启动',
        summary: '把便签释放为独立窗口，并选择关闭主窗口后是否让 Arkdown 留在系统托盘。',
        keywords: ['桌面便签', '释放到桌面', '从桌面回收', 'Pin', '开机启动', '系统托盘', '关闭时'],
        body: `
          ${bullets([
            '<strong>释放到桌面：</strong>在便签卡片右键菜单中选择“释放到桌面”，会打开独立的便签窗口；这不会从便签盒子删除内容。',
            '<strong>Pin：</strong>点击便签左上角的 Pin 按钮可让窗口始终置顶；关闭 Pin 后恢复为普通窗口。',
            '<strong>从桌面回收：</strong>关闭桌面展示并保留便签内容，稍后仍可从便签盒子重新打开。',
            '<strong>窗口关闭：</strong>偏好设置可选择“关闭窗口，并在系统托盘显示图标”或“关闭整个软件（无法维持桌面便签功能）”。',
          ])}
          <p>第一次打开便签盒子时，Arkdown 会询问是否启用开机启动。启用后，Windows 登录时会启动 Arkdown，并重新打开上次正常退出时仍释放在桌面的便签。也可在“文件 → 偏好设置 → 便签设置”中更改开机启动和关闭行为。</p>
          ${callout('danger', '免安装版路径提示', '免安装版启用开机启动时，如果移动了程序文件夹，开机启动将失效')}
          ${callout('info', '完整退出', '如果选择关闭整个软件，桌面便签窗口也会一同关闭；内容会先完成实时保存。')}
        `,
      },
      {
        id: 'portable-move',
        title: '移动到另一台电脑或位置',
        summary: '关闭程序后整体复制 Arkdown 文件夹，并单独迁移工作区。',
        keywords: ['移动', '复制', 'U盘', '另一台电脑', '迁移'],
        body: `
          ${steps([
            '确认底部显示“已保存”，然后关闭 Arkdown。',
            '整体复制 Arkdown 程序文件夹，不要只复制 exe。',
            '另行复制需要使用的 Markdown 工作区。',
            '在新位置运行 Arkdown.exe，并重新选择工作区。',
          ])}
        `,
      },
      {
        id: 'portable-backup',
        title: '备份建议',
        summary: '重点备份工作区及文档引用的原始资源；需要时再备份便携设置。',
        keywords: ['备份', '工作区', '引用资源', 'temp', '设置', '升级'],
        body: `
          ${bullets([
            '<strong>必须备份：</strong>工作区中的文档，以及文档所引用的原始图片、音频、视频和 PDF；Arkdown 不会自动制作资源副本。',
            '<strong>恢复未保存内容：</strong>异常发生后先不要清理程序 <code>temp</code>，重新启动并选择“恢复”。',
            '<strong>可选备份：</strong>程序旁的 <code>portable-data</code> 设置目录。',
            '<strong>升级前：</strong>先手动保存并关闭程序，再替换程序文件。',
          ])}
          <p>当前版本没有安装器和自动更新，也不提供发布 ZIP。请从可信来源获取新版本，并保留独立文档备份。</p>
        `,
      },
    ],
  },
  {
    id: 'troubleshooting',
    output: '使用说明书/troubleshooting.html',
    title: '常见问题排查',
    eyebrow: 'TROUBLESHOOTING',
    description: '按现象查找原因，从最安全、最容易恢复的步骤开始处理。',
    group: '帮助',
    sections: [
      {
        id: 'troubleshooting-start',
        title: '程序无法打开',
        summary: '确认已完整解压、文件齐全，并尝试换到普通可写目录。',
        keywords: ['打不开', '无法启动', '双击无反应', 'Windows 拦截'],
        body: `
          ${steps([
            '确认程序已经完整解压，不是在压缩包预览窗口中运行。',
            '确认 <code>Arkdown.exe</code> 旁的 <code>resources</code> 等程序文件仍然存在。',
            '把整个程序文件夹复制到“文档”或其他普通目录后重试。',
            '如果 Windows 显示安全提示，请先确认文件来自可信来源，再决定是否运行。',
          ])}
        `,
      },
      {
        id: 'troubleshooting-workspace',
        title: '工作区无法打开或恢复',
        summary: '检查文件夹是否存在、路径是否变化以及访问权限。',
        keywords: ['工作区错误', '恢复失败', '文件夹移动', '访问权限'],
        body: `
          ${steps([
            '在资源管理器中确认原文件夹仍然存在。',
            '如果文件夹被移动或改名，点击“打开文件夹”重新选择新位置。',
            '确认当前账号能够打开该文件夹及其子文件夹。',
            '网络盘或移动盘断开时，重新连接后再选择。',
          ])}
        `,
      },
      {
        id: 'troubleshooting-tree-missing',
        title: '文件树看不到文档',
        summary: '确认扩展名属于支持列表，并刷新或重新打开工作区。',
        keywords: ['文件树', '看不到文档', '文件不显示', '扩展名', '刷新'],
        body: `
          ${steps([
            '确认文件位于当前工作区或子文件夹中。',
            '到“格式兼容与数据安全 → 支持的文件”核对扩展名；<code>.docx</code> 需要可用的 Pandoc 才能导入。',
            '点击文件夹名前的小三角展开子文件夹，或点击侧栏刷新按钮。',
            '仍然看不到时，重新打开同一工作区并检查文件读取权限。',
          ])}
        `,
      },
      {
        id: 'troubleshooting-document-open',
        title: '文档无法打开',
        summary: '检查文件类型、访问权限和文件是否仍在原位置。',
        keywords: ['文档无法打开', '拖入失败', '读取失败', '权限', '文件移动'],
        body: `
          ${steps([
            '在资源管理器中确认文件仍然存在，并可用记事本读取。',
            '核对扩展名是否列在“支持的文件”中；仅修改后缀不能转换文件格式。',
            '如果当前窗口已有内容，拖入支持的文档会在新窗口打开。',
            '媒体和 PDF 必须拖到右侧编辑区域，拖到文件树不会插入。',
          ])}
        `,
      },
      {
        id: 'troubleshooting-save-failure',
        title: '保存失败',
        summary: '先复制当前文字，再检查工作区、程序目录和磁盘状态。',
        keywords: ['保存失败', '草稿失败', 'temp', '一直未保存', '只读'],
        body: `
          ${steps([
            '先全选并复制当前内容到记事本或另一个安全文件。',
            '如果“已备份到临时草稿”没有出现，检查程序文件夹是否可写。',
            '如果 Ctrl+S 失败，检查原文档是否只读、工作区是否可写以及磁盘空间。',
            '修复后重试；确认状态变为“已保存”再关闭窗口。',
          ])}
        `,
      },
      {
        id: 'troubleshooting-save-conflict',
        title: '出现保存冲突',
        summary: '先另存当前内容，再比较原文件，避免覆盖另一份修改。',
        keywords: ['出现保存冲突', '保存冲突', '外部修改', '另存为'],
        body: `
          ${steps([
            '不要反复按 Ctrl+S，先选择“文件 → 另存为”保存当前内容。',
            '在另一个编辑器中打开磁盘上的原文件。',
            '人工比较并合并两个版本，确认重要段落都保留。',
          ])}
          ${callout('warning', '不要直接覆盖', '“保存冲突”是在保护磁盘上的外部修改；当前版本不提供自动合并。')}
        `,
      },
      {
        id: 'troubleshooting-recovery',
        title: '没有出现恢复提示',
        summary: '确认编辑时曾生成临时草稿，并且程序 temp 没有被移动或清理。',
        keywords: ['恢复未保存的内容', '没有提示', 'temp', '崩溃恢复'],
        body: `
          ${steps([
            '确认异常前底部曾显示“已备份到临时草稿”。',
            '确认 Arkdown 程序文件夹中的 <code>temp</code> 仍在原位置。',
            '必须重新运行同一份免安装程序；只复制 exe 或换用另一份程序目录无法读取原 temp。',
            '如果之前选择了“暂不恢复”，该草稿会保留但不再自动提示。',
          ])}
        `,
      },
      {
        id: 'troubleshooting-mode',
        title: '两种模式看起来不同',
        summary: '源码模式显示标记，即时渲染模式显示排版结果。',
        keywords: ['模式不同', '显示不一样', '源码', '渲染'],
        body: `
          <p>源码模式会显示 <code>#</code>、<code>**</code> 等 Markdown 标记，即时渲染模式显示它们对应的排版效果，因此外观本来就不同。</p>
          ${callout('warning', '先查看源码', '如果某段内容在即时渲染模式中表现异常，请切到源码模式检查符号是否完整。不要在没有备份时用其他文件覆盖当前文档。')}
        `,
      },
      {
        id: 'troubleshooting-portable-settings',
        title: '移动程序后设置没有保留',
        summary: '免安装版需要连同 portable-data 和全部程序文件一起移动。',
        keywords: ['移动程序', '设置没有保留', 'portable-data', '免安装', '工作区记录'],
        body: `
          ${steps([
            '退出 Arkdown，确认程序不再运行。',
            '移动或复制整个 Arkdown 文件夹，不要只复制 <code>Arkdown.exe</code>。',
            '确认新位置中仍有 <code>portable-data</code> 文件夹；这里保存最近工作区和窗口位置等设置。',
            '如果文档工作区本身也换了位置，请运行程序后重新选择新的工作区路径。',
          ])}
          ${callout('info', '文档不会放在 portable-data 中', 'Markdown 文档始终保存在你选择的工作区。portable-data 只保存软件设置，不能代替文档备份。')}
        `,
      },
      {
        id: 'troubleshooting-guide',
        title: '说明书页面或图片无法显示',
        summary: '保持使用说明书.html 与使用说明书文件夹的相对位置。',
        keywords: ['说明书打不开', '图片不显示', '样式丢失', '页面空白'],
        body: `
          <p><code>使用说明书.html</code> 必须与 <code>使用说明书</code> 文件夹一起保存在 Arkdown 程序根目录。只复制入口文件会导致样式、脚本、子页面和截图缺失。</p>
        `,
      },
    ],
  },
  {
    id: 'faq',
    output: '使用说明书/faq.html',
    title: '常见问答',
    eyebrow: 'FAQ',
    description: '集中回答联网、安装、文件位置、备份和功能范围等常见问题。',
    group: '帮助',
    sections: [
      {
        id: 'faq-install-network',
        title: '运行时需要安装或联网吗',
        summary: 'Arkdown 免安装，日常编辑和说明书都不需要联网。',
        keywords: ['联网', '离线', '安装', '管理员权限'],
        body: `
          <div class="faq-item"><h3>需要安装吗？</h3><p>不需要。完整解压或复制程序文件夹后，双击 Arkdown.exe。</p></div>
          <div class="faq-item"><h3>编辑文档需要联网吗？</h3><p>不需要。应用和这套说明书都在本地运行。</p></div>
        `,
      },
      {
        id: 'faq-platform-files',
        title: '支持哪些系统和文件',
        summary: '当前支持 Windows 10/11 x64、常见 Markdown 和纯文本文档。',
        keywords: ['Windows', 'macOS', 'Linux', '文件格式', 'docx'],
        body: `
          <div class="faq-item"><h3>支持 macOS 或 Linux 吗？</h3><p>当前版本仅支持 Windows 10/11 x64。</p></div>
          <div class="faq-item"><h3>支持哪些文档？</h3><p>支持常见 Markdown、纯文本以及通过 Pandoc 导入和导出的 <code>.docx</code>；完整清单见“格式兼容与数据安全”。</p></div>
          <div class="faq-item"><h3>支持哪些拖入资源？</h3><p>支持常见图片、音频、视频、PDF 和 XLSX；文档记录原文件的本地绝对路径。</p></div>
        `,
      },
      {
        id: 'faq-storage-backup',
        title: '文档和草稿保存在哪里',
        summary: '原文件留在工作区，未手动保存的编辑先写入程序 temp。',
        keywords: ['保存位置', '工作区', 'temp', 'portable-data', '备份'],
        body: `
          <div class="faq-item"><h3>编辑后会立即改写原文件吗？</h3><p>不会。编辑内容先自动备份到程序 <code>temp</code>；按 Ctrl+S 后才写入原文件。</p></div>
          <div class="faq-item"><h3>媒体保存在哪里？</h3><p>媒体保持在原位置；Markdown 保存它的 Windows 绝对路径。图片“另存为”和“复制图片到”只创建新副本。</p></div>
          <div class="faq-item"><h3>临时草稿能代替备份吗？</h3><p>不能。它只用于恢复当前未保存状态，不提供历史版本；请独立备份重要工作区。</p></div>
        `,
      },
      {
        id: 'faq-feature-scope',
        title: '为什么找不到某些功能',
        summary: '0.1.0 已支持本地媒体和恢复，但仍有部分功能暂缓。',
        keywords: ['docx', '导出', '主题', '专注模式', '更新'],
        body: `
          <p>Arkdown 0.1.0 已支持图片、音频、视频、PDF 资源、DOCX 导入与导出、右键菜单、临时草稿和崩溃恢复。</p>
          <p>当前仍未提供外部变化实时监听、HTML/PDF 导出、主题切换、专注模式和打字机模式、安装器和自动更新以及发布 ZIP。</p>
        `,
      },
      {
        id: 'faq-relationship-version',
        title: '说明书版本',
        summary: '通过页眉确认说明书适用版本。',
        keywords: ['版本号', '说明书版本'],
        body: `
          <div class="faq-item"><h3>如何确认说明书是否适用？</h3><p>查看每页顶部的版本信息。本说明书适用于 Arkdown 0.1.0，更新日期为 ${GUIDE_UPDATED_AT}。</p></div>
        `,
      },
    ],
  },
]

export const GUIDE_GROUPS: GuideGroup[] = [
  { title: '开始使用', pageIds: ['home', 'workspace'] },
  { title: '编辑与保存', pageIds: ['editing', 'saving'] },
  { title: '文件与便携', pageIds: ['compatibility', 'portable'] },
  { title: '帮助', pageIds: ['troubleshooting', 'faq'] },
]
