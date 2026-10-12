import {readFile, readdir, access} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

const root = resolve(process.argv[2] || import.meta.dirname);
const pages = (await readdir(root)).filter(name => name.endsWith('.html'));
const documents = new Map();
for (const name of pages) {
  const html = await readFile(resolve(root, name), 'utf8');
  const document = new JSDOM(html).window.document;
  documents.set(name, document);
  assert.equal(document.querySelectorAll('h1').length, 1, `${name}: one main heading`);
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert(document.querySelector('meta[name="viewport"]'));
  assert(document.querySelector('meta[name="description"]')?.content);
  const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
  assert.equal(ids.length, new Set(ids).size, `${name}: duplicate IDs`);
  for (const img of document.querySelectorAll('img')) assert(img.hasAttribute('alt'));
  assert(document.querySelector('#search-input').getAttribute('aria-label'));
  assert(!html.includes('C:\\Users\\'), `${name}: local user path leaked`);
}
let references = 0;
for (const [name, document] of documents) {
  for (const el of document.querySelectorAll('[href], [src]')) {
    const ref = el.getAttribute('href') ?? el.getAttribute('src');
    if (!ref) continue;
    assert(!/^(https?:)?\/\//.test(ref), `${name}: remote dependency ${ref}`);
    const [path, hash] = ref.split('#');
    const target = decodeURIComponent(path || name);
    const absolute = resolve(root, target);
    assert(absolute.startsWith(root + sep), `Outside handbook: ${ref}`);
    await access(absolute);
    if (hash) assert(documents.get(target)?.getElementById(decodeURIComponent(hash)), `${name}: broken anchor ${ref}`);
    references++;
  }
}
const indexSource = await readFile(resolve(root, 'search-index.js'), 'utf8');
const index = JSON.parse(indexSource.slice('window.guideIndex='.length).trim().replace(/;$/, ''));
for (const entry of index) {
  const [page, id] = entry.url.split('#');
  assert(documents.get(page)?.getElementById(id), `Broken search result: ${entry.url}`);
  assert(entry.title && entry.summary && entry.text);
}
assert.equal(new Set(index.map(item => item.url)).size, index.length);
console.log(`PASS: ${pages.length} pages, ${references} local references, ${index.length} searchable sections; headings, metadata, labels, image descriptions and offline resources verified.`);
