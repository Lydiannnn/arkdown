import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// The editable workspace chapters are also the source of the packaged HTML handbook.
export const version = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
export const updated = '2026-10-13';
export const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const definitions = [
  ['index', '01-欢迎使用.md', '欢迎使用', 'BookOpenText'],
  ['ai', '02-与 AI 一起处理文档.md', '与 AI 一起处理文档', 'Sparkle'],
  ['workspace', '03-管理文件与工作区.md', '管理文件与工作区', 'FolderOpen'],
  ['writing', '04-编辑与排版.md', '编辑与排版', 'PencilLine'],
  ['saving', '05-保存、转换与导出.md', '保存、转换与导出', 'FloppyDisk'],
  ['media', '06-图片与本地资源.md', '图片与本地资源', 'Image'],
  ['notes', '07-用便签收纳零散想法.md', '桌面便签', 'Note'],
  ['translation', '08-划词翻译与截图识别.md', '翻译与文字识别', 'Translate'],
  ['settings', '09-把 Arkdown 调整得顺手.md', '偏好设置', 'SlidersHorizontal'],
  ['shortcuts', '10-常用快捷键.md', '常用快捷键', 'Keyboard'],
];
const links = new Map(definitions.map(([id, file]) => [file, `${id}.html`]));
function render(markdown) {
  return renderToStaticMarkup(React.createElement(Markdown, {
    remarkPlugins: [remarkGfm],
    components: {
      a: ({ href, children }) => {
        if (href?.startsWith('arkdown:')) return React.createElement('span', { title: '请在 Arkdown 中使用这个入口' }, children);
        const target = href ? (links.get(decodeURIComponent(href)) ?? href) : undefined;
        return React.createElement('a', { href: target }, children);
      },
      table: ({ children }) => React.createElement('div', { className: 'table-scroll' }, React.createElement('table', null, children)),
      pre: ({ children }) => React.createElement('div', { className: 'code-example' },
        React.createElement('div', null, React.createElement('span', null, '示例'), React.createElement('button', { type: 'button', 'data-copy': '' }, '复制')),
        React.createElement('pre', null, children)),
    },
    // Keep internal app links until the component above converts them to plain text.
    urlTransform: url => /^(?:https?:|arkdown:|#)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : '',
    children: markdown,
  }));
}
export const chapters = definitions.map(([id, sourceFile, short, icon]) => {
  const markdown = readFileSync(resolve(import.meta.dirname, '..', 'initial-workspace', sourceFile), 'utf8');
  const titleMatch = markdown.match(/^# (.+)\r?$/m);
  if (!titleMatch) throw new Error(`Missing chapter title: ${sourceFile}`);
  const headings = [...markdown.matchAll(/^## (.+)\r?$/gm)];
  const intro = markdown.slice(titleMatch.index + titleMatch[0].length, headings[0]?.index).trim();
  const sections = headings.map((heading, index) => {
    const bodyMarkdown = markdown.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim();
    const title = heading[1].replace(/^\d{2}\s+/, '').trim();
    return { id: `${id}-${String(index + 1).padStart(2, '0')}`, title, body: render(bodyMarkdown),
      summary: bodyMarkdown.split('\n').find(line => line.trim())?.replace(/[*`]/g, '').slice(0, 140) || title,
      keywords: short };
  });
  return { id, sourceFile, markdown, short, icon, group: '使用指南', title: titleMatch[1].trim(), intro, introHtml: render(intro), sections };
});
