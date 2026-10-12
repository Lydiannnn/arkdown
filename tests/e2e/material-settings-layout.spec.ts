import {expect,test} from '@playwright/test'
import {createServer,type ViteDevServer} from 'vite'
import {DEFAULT_ARKNOTE_PREFERENCES} from '../../src/shared/arknote-preferences'
let vite:ViteDevServer
test.beforeAll(async()=>{vite=await createServer({configFile:'vite.renderer.config.ts',logLevel:'error',server:{host:'127.0.0.1',port:4189,strictPort:true}});await vite.listen()})
test.afterAll(async()=>{await vite?.close()})
for(const width of [1100,640]) test(`Arknote material page at ${width} CSS px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:640})
  await page.addInitScript(p=>{
    let prefs=structuredClone(p)
    ;(window as any).__materialPreviews=[]
    Object.defineProperty(window,'arkdown',{value:{
      getArknotePreferences:async()=>({ok:true,value:prefs}),
      setArknotePreferences:async(v:any)=>{prefs={...prefs,...v};return {ok:true,value:prefs}},
      previewStickyNoteWallpaperAppearances:async(v:any)=>{(window as any).__materialPreviews.push(v);return {ok:true,value:v??prefs}},
    }})
  },DEFAULT_ARKNOTE_PREFERENCES)
  await page.goto('/?surface=arknote-settings')
  await expect(page.getByRole('radio',{name:'暖雾玻璃',exact:true})).toBeVisible()
  const color=page.getByRole('radio',{name:'颜色',exact:true}), custom=page.getByLabel('自定义颜色',{exact:true})
  const row=await color.boundingBox(), colorBox=await custom.boundingBox(); expect(row!.x).toBeLessThan(colorBox!.x);expect(Math.abs(row!.y+row!.height/2-colorBox!.y-colorBox!.height/2)).toBeLessThan(2)
  await expect(custom).toBeDisabled();await color.check();await expect(custom).toBeEnabled()
  await page.screenshot({path:testInfo.outputPath('arknote-settings.png')})
  await page.getByRole('button',{name:'材质设置',exact:true}).click()
  await expect(page.getByRole('heading',{name:'材质设置',exact:true})).toBeVisible()
  await expect(page.getByRole('region',{name:'Mica',exact:true}).getByRole('slider')).toHaveCount(3)
  await expect(page.getByRole('region',{name:'暖雾玻璃',exact:true}).getByRole('slider')).toHaveCount(6)
  await expect(page.getByRole('region',{name:'深色玻璃',exact:true}).getByRole('slider')).toHaveCount(6)
  await expect(page.getByRole('region',{name:'Acrylic',exact:true}).getByRole('slider')).toHaveCount(3)
  await expect(page.getByRole('spinbutton')).toHaveCount(0)
  await expect(page.getByRole('button',{name:'保存',exact:true})).toBeInViewport()
  const content=page.locator('.preferences-page-content')
  expect(await content.evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true)
  const mica=page.getByRole('region',{name:'Mica',exact:true})
  await mica.getByRole('slider',{name:'Mica 着色强度',exact:true}).fill('34')
  await expect.poll(async()=>await page.evaluate(()=>(window as any).__materialPreviews.at(-1)?.micaAppearance.tintOpacity)).toBe(.34)
  await page.screenshot({path:testInfo.outputPath('material-settings-top.png')})
  await page.getByRole('region',{name:'Acrylic',exact:true}).getByRole('checkbox',{name:'去除描边'}).scrollIntoViewIfNeeded()
  await expect(page.getByRole('region',{name:'Acrylic',exact:true})).toBeInViewport()
  const checkbox = page.getByRole('region',{name:'Acrylic',exact:true}).getByRole('checkbox',{name:'去除描边'})
  const alignment = await checkbox.evaluate(input => {
    const check = input.getBoundingClientRect(), label = input.parentElement!.querySelector('span')!.getBoundingClientRect()
    return { check: check.y + check.height / 2, text: label.y + label.height / 2 }
  })
  expect(Math.abs(alignment.check - alignment.text)).toBeLessThanOrEqual(1)
  await page.screenshot({path:testInfo.outputPath('material-settings-bottom.png')})
  await page.getByRole('button',{name:'返回 Arknote 设置',exact:true}).click()
  await expect(page.getByRole('button',{name:'恢复便签默认样式',exact:true})).toBeVisible()
})
