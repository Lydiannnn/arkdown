import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { codexNativeExecutable } from '../../src/main/codex/codex-cli-executable'
const roots: string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
it.each(['x64','arm64'])('resolves the installed npm %s binary without executing the wrapper',async arch=>{
  const root=await mkdtemp(path.join(tmpdir(),'arkdown-codex-discovery-'));roots.push(root)
  const packageRoot=path.join(root,'node_modules','@openai','codex')
  const platformRoot=path.join(packageRoot,'node_modules','@openai',`codex-win32-${arch}`)
  const binary=path.join(platformRoot,'vendor',arch==='x64'?'x86_64-pc-windows-msvc':'aarch64-pc-windows-msvc','bin','codex.exe')
  await mkdir(path.dirname(binary),{recursive:true})
  await writeFile(path.join(packageRoot,'package.json'),'{}')
  await writeFile(path.join(platformRoot,'package.json'),'{}')
  await writeFile(binary,'synthetic binary, do not execute')
  expect(codexNativeExecutable([path.join(root,'codex.cmd')],arch as NodeJS.Architecture)).toBe(binary)
})
it('rejects relative and missing executable candidates',()=>{
  expect(codexNativeExecutable(['codex.exe','C:/definitely-not-installed/codex.exe'])).toBeUndefined()
})
