import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const css = [
  'node_modules/@milkdown/crepe/lib/theme/common/list-item.css',
  'src/renderer/app/styles.css',
  'src/renderer/sticky-notes/sticky-note-window.css',
].map((file) => readFileSync(path.resolve(file), 'utf8')).join('\n')

test('real Chromium preserves sticky task hit geometry and live theme colors', async ({ page }) => {
  await page.setContent(`
    <style>${css}</style>
    <main class="sticky-note-window" style="--theme-color-rgb:37 99 235">
      <div class="sticky-note-editor visual-editor milkdown">
        <div class="ProseMirror" style="color:rgb(12 34 56)">
          <ul>
            <div class="milkdown-list-item-block">
              <li class="list-item">
                <span class="label-wrapper" id="wrapper"><span class="label unchecked" id="label"><svg id="task-svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"></path></svg></span></span>
                <div class="children" id="children"><p>Task text</p></div>
              </li>
            </div>
            <div class="milkdown-list-item-block">
              <li class="list-item">
                <span class="label-wrapper"><span class="label bullet"><svg id="bullet-svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg></span></span>
                <div class="children"><p>Bullet text</p></div>
              </li>
            </div>
          </ul>
          <label class="task-list-item"><input id="legacy-task" type="checkbox" /></label>
          <blockquote id="quote">Quote</blockquote>
        </div>
      </div>
    </main>
    <script>
      window.taskClicks = 0
      document.querySelector('#label').addEventListener('click', () => { window.taskClicks += 1 })
    </script>
  `)

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect()
    const wrapper = rect('#wrapper')
    const label = rect('#label')
    const svg = rect('#task-svg')
    const children = rect('#children')
    return {
      wrapper: { left: wrapper.left, right: wrapper.right, width: wrapper.width },
      label: { left: label.left, right: label.right, width: label.width },
      svg: { left: svg.left, right: svg.right, width: svg.width },
      children: { left: children.left },
    }
  })
  expect(geometry.wrapper.width).toBe(14)
  expect(geometry.label.width).toBe(22)
  expect(geometry.label.right).toBeCloseTo(geometry.wrapper.right, 4)
  expect(geometry.label.left).toBeLessThan(geometry.wrapper.left)
  expect(geometry.svg.width).toBe(14)
  expect(geometry.svg.right).toBeLessThanOrEqual(geometry.wrapper.right)
  expect(geometry.children.left).toBeGreaterThan(geometry.svg.right)

  const labelBox = await page.locator('#label').boundingBox()
  await page.mouse.click(geometry.label.left + 2, labelBox!.y + 5)
  expect(await page.evaluate(() => (window as unknown as { taskClicks: number }).taskClicks)).toBe(1)

  const colors = await page.evaluate(() => ({
    svgFill: getComputedStyle(document.querySelector('#task-svg')!).fill,
    pathFill: getComputedStyle(document.querySelector('#task-svg path')!).fill,
    bulletFill: getComputedStyle(document.querySelector('#bullet-svg')!).fill,
    inputColor: getComputedStyle(document.querySelector('#legacy-task')!).color,
    inputAccent: getComputedStyle(document.querySelector('#legacy-task')!).accentColor,
    quote: getComputedStyle(document.querySelector('#quote')!, '::before').backgroundColor,
  }))
  expect(colors.svgFill).toBe('rgb(12, 34, 56)')
  expect(colors.pathFill).toBe('rgb(12, 34, 56)')
  expect(colors.bulletFill).toBe('rgb(12, 34, 56)')
  expect(colors.inputColor).toBe('rgb(12, 34, 56)')
  expect(colors.inputAccent).toBe('rgb(12, 34, 56)')
  expect(colors.quote).toBe('rgb(37, 99, 235)')

  await page.locator('.sticky-note-window').evaluate((element) =>
    (element as HTMLElement).style.setProperty('--theme-color-rgb', '24 134 75'))
  await expect.poll(() => page.locator('#quote').evaluate((element) =>
    getComputedStyle(element, '::before').backgroundColor))
    .toBe('rgb(24, 134, 75)')
})

test('ordered counters paint actual starts at all five depths and follow list edits', async ({ page }, testInfo) => {
  const item = (id: string, label: string, child = '') => `
    <div class="milkdown-list-item-block" id="${id}"><li class="list-item">
      <span class="label-wrapper"><span class="label ordered" data-expected="${label}">${label}</span></span>
      <div class="children"><div data-content-dom><p>Item ${id}</p>${child}</div></div>
    </li></div>`
  const list = (id: string, start: number, children: string) =>
    `<ol id="${id}" start="${start}" style="--arkdown-ordered-list-start:${start - 1}">${children}</ol>`
  const nested = list('level2', 3, item('b', '3)',
    list('level3', 3, item('c', 'c.',
      list('level4', 4, item('d', 'd)',
        list('level5', 4, item('e', 'iv') + item('f', 'v'))))))) + item('g', '4)'))
  await page.setContent(`<style>${css}</style>
    <div class="visual-editor milkdown" style="width:700px;background:white">
      <div class="ProseMirror" style="font:16px/24px Arial;padding:32px">
        ${list('top', 5, item('a', '5.', nested) + item('h', '6.'))}
        <p>Separator</p>${list('continued', 9, item('i', '9.') + item('j', '10.'))}
        <p>Separator</p>${list('ordinary', 1, item('k', '1.') + item('l', '2.'))}
      </div>
    </div>`)

  const assertPaintedNumbers = async (phase: string) => {
    const region = page.locator('.visual-editor')
    const actual = await region.screenshot({ path: testInfo.outputPath(`${phase}-actual.png`) })
    // A literal-text render is the independent pixel oracle for generated counters.
    const oracle = await page.addStyleTag({ content:
      '.visual-editor .ProseMirror .label.ordered::before { content: attr(data-expected) !important; }',
    })
    const expected = await region.screenshot({ path: testInfo.outputPath(`${phase}-expected.png`) })
    await oracle.evaluate((element) => element.parentNode!.removeChild(element))
    await testInfo.attach(`${phase}-actual`, { body: actual, contentType: 'image/png' })
    await testInfo.attach(`${phase}-expected`, { body: expected, contentType: 'image/png' })
    expect(actual.equals(expected), `${phase}: counters must paint the expected literal labels`).toBe(true)
  }
  await assertPaintedNumbers('initial')
  await page.locator('#h').evaluate((element) => {
    const added = element.cloneNode(true) as HTMLElement
    added.id = 'inserted'
    const label = added.querySelector<HTMLElement>('.label')!
    label.dataset.expected = '7.'
    element.after(added)
  })
  await assertPaintedNumbers('inserted')
  await page.locator('#h').evaluate((element) => element.remove())
  await page.locator('#inserted .label').evaluate((element) => { (element as HTMLElement).dataset.expected = '6.' })
  await assertPaintedNumbers('deleted')
  await page.locator('#top').evaluate((element) => {
    const ol = element as HTMLOListElement
    ol.start = 12
    ol.style.setProperty('--arkdown-ordered-list-start', '11')
  })
  await page.locator('#a > .list-item > .label-wrapper > .label').evaluate((element) => {
    (element as HTMLElement).dataset.expected = '12.'
  })
  await page.locator('#inserted .label').evaluate((element) => { (element as HTMLElement).dataset.expected = '13.' })
  await assertPaintedNumbers('changed-start')
})
