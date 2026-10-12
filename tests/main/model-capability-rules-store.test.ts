import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ModelCapabilityRulesStore } from '../../src/main/models/model-capability-rules-store'
import { getModelCapabilityRules, setModelCapabilityRules, type RuleFile } from '../../src/shared/model-capability-rules'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { resolveModelThinkingCapability } from '../../src/shared/model-thinking'

const folders: string[] = []
const file: RuleFile = {schemaVersion:1,revision:'2026-09-13',rules:[{
  id:'future',provider:'deepseek',protocol:'openai',baseUrls:['https://api.deepseek.com'],modelIds:['future-flash'],
  capability:{thinking:'toggle',encoding:'thinking-effort',efforts:['low','max'],defaultEffort:'low',defaultThinking:'enabled',disabledEfforts:[]},recommendation:1,
}]}
async function store() {
  const root=await mkdtemp(path.join(os.tmpdir(),'arkdown-model-rules-')); folders.push(root)
  return new ModelCapabilityRulesStore(root)
}
afterEach(async()=>{setModelCapabilityRules(null);await Promise.all(folders.splice(0).map(f=>rm(f,{recursive:true,force:true})))})
describe('portable model rules',()=>{
  it('persists an import, reloads it before use, and restores bundled defaults',async()=>{
    const first=await store();await first.load()
    expect(first.getState().rules).toBeNull()
    await first.update(file)
    setModelCapabilityRules(null)
    const reopened=new ModelCapabilityRulesStore(path.dirname(first.filePath));await reopened.load()
    expect(getModelCapabilityRules()).toEqual(file)
    expect(resolveModelThinkingCapability({provider:'deepseek',protocol:'openai',baseUrl:'https://api.deepseek.com',modelId:'future-flash'}).efforts).toEqual(['low','max'])
    await reopened.update(null);await reopened.load()
    expect(reopened.getState()).toMatchObject({rules:null,warning:null})
  })
  it('rejects invalid imports without changing disk or the current registry',async()=>{
    const s=await store();await s.update(file)
    const before=await readFile(s.filePath,'utf8')
    await expect(s.update({...file,schemaVersion:99} as unknown as RuleFile)).rejects.toThrow()
    expect(await readFile(s.filePath,'utf8')).toBe(before)
    expect(getModelCapabilityRules()).toEqual(file)
  })
  it('keeps corrupt data and warns, and accepts a UTF-8 BOM',async()=>{
    const s=await store();await writeFile(s.filePath,'broken','utf8');await s.load()
    expect(s.getState().warning).toContain('原文件保留')
    expect(await readFile(s.filePath,'utf8')).toBe('broken')
    await writeFile(s.filePath,'\uFEFF'+JSON.stringify(file),'utf8')
    const s2=new ModelCapabilityRulesStore(path.dirname(s.filePath));await s2.load()
    expect(s2.getState()).toMatchObject({rules:file,warning:null})
  })
  it('serializes concurrent updates and returns isolated snapshots',async()=>{
    const s=await store();await Promise.all([s.update(file),s.update({...file,revision:'2026-09-14'})])
    const snapshot=s.getState();snapshot.rules!.rules[0].modelIds.push('tampered')
    expect(s.getState().rules!.revision).toBe('2026-09-14')
    expect(s.getState().rules!.rules[0].modelIds).not.toContain('tampered')
  })
  it('reloads a valid near-limit import without expanding its disk size',async()=>{
    const s=await store()
    const large:RuleFile={...file,rules:Array.from({length:20},(_,ruleIndex)=>({...file.rules[0],id:'large-'+ruleIndex,modelIds:Array.from({length:128},(_,id)=>`${ruleIndex}-${id}-`+'x'.repeat(394))}))}
    const compact=JSON.stringify(large)
    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(1_048_576)
    expect(Buffer.byteLength(JSON.stringify(large,null,2))).toBeGreaterThan(1_048_576)
    await s.update(large)
    await s.load()
    expect(s.getState()).toMatchObject({rules:large,warning:null})
  })
  it('roundtrips imports through the same IPC and preload validation used by the UI',async()=>{
    const s=await store()
    const operations=createIpcOperations({chooseDirectory:vi.fn(),workspace:{} as never,documents:{} as never,getLastWorkspace:()=>null,setLastWorkspace:vi.fn(),reportError:vi.fn(),modelCapabilityRules:s})
    const invoke=vi.fn(async(channel:string,...args:unknown[])=>channel===IPC_CHANNELS.getModelCapabilityRules?operations.getModelCapabilityRules(args[0]):operations.setModelCapabilityRules(args[0]))
    const api=createArkdownApi(invoke)
    expect(await api.setModelCapabilityRules!(file)).toMatchObject({ok:true,value:{rules:file}})
    expect(await api.getModelCapabilityRules!()).toMatchObject({ok:true,value:{rules:file}})
    const calls=invoke.mock.calls.length
    expect(await api.setModelCapabilityRules!({malformed:true} as never)).toMatchObject({ok:false})
    expect(invoke.mock.calls).toHaveLength(calls)
    expect(await operations.setModelCapabilityRules({schemaVersion:2})).toMatchObject({ok:false})
    expect(s.getState().rules).toEqual(file)
  })
})
