import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelRulesSettings } from '../../src/renderer/settings/ModelRulesSettings'
import { initializeModelRules } from '../../src/renderer/settings/model-rules-runtime'
import { ModelThinkingControls } from '../../src/renderer/editor/ModelThinkingControls'
import { ManualModelThinkingFields } from '../../src/renderer/settings/ManualModelThinkingFields'
import { setModelCapabilityRules, getModelCapabilityRules, type RuleFile, type ModelThinkingCapability } from '../../src/shared/model-capability-rules'
import { choosePreferencesOption } from './preferences-select-test-helpers'
import type { ModelCapabilityRulesState } from '../../src/shared/model-capability-rules-state'
const capability:ModelThinkingCapability={thinking:'toggle',encoding:'thinking-effort',efforts:['low','max'],defaultEffort:'low',defaultThinking:'enabled',disabledEfforts:[]}
const rules:RuleFile={schemaVersion:1,revision:'2026-09-13',rules:[{id:'unknown-fixture',provider:'deepseek',protocol:'openai',baseUrls:['https://api.deepseek.com'],modelIds:['unknown-fixture'],capability}]}
const state=(value:RuleFile|null):ModelCapabilityRulesState=>({rules:value,bundledRevision:'2026-09-12',warning:null})
afterEach(()=>setModelCapabilityRules(null))
it('imports and restores a rule file while rejecting malformed data locally',async()=>{
  const set=vi.fn(async(value:RuleFile|null)=>({ok:true as const,value:state(value)}))
  render(<ModelRulesSettings api={{getModelCapabilityRules:async()=>({ok:true,value:state(null)}),setModelCapabilityRules:set}} />)
  const input=screen.getByLabelText('选择模型规则文件')
  const file={size:100,text:async()=>JSON.stringify(rules)}
  fireEvent.change(input,{target:{files:[file]}})
  await screen.findByText('当前规则：2026-09-13（已导入）')
  expect(set).toHaveBeenCalledExactlyOnceWith(rules)
  fireEvent.change(input,{target:{files:[{size:100,text:async()=>'{invalid'}]}})
  await screen.findByRole('alert');expect(set).toHaveBeenCalledTimes(1)
  expect(getModelCapabilityRules()).toEqual(rules)
  fireEvent.click(screen.getByRole('button',{name:'恢复内置规则'}))
  await waitFor(()=>expect(getModelCapabilityRules()).toBeNull())
})
it('rerenders existing thinking controls when a new rule is imported',()=>{
  render(<ModelThinkingControls label="AI 对话" togglePresentation="menu" thinkingConnection={{provider:'deepseek',protocol:'openai',baseUrl:'https://api.deepseek.com',modelId:'unknown-fixture'}} thinkingPreference={{thinkingMode:'default',reasoningEffort:'low'}} onThinkingChange={vi.fn()} />)
  expect(screen.queryByRole('combobox')).toBeNull()
  act(()=>setModelCapabilityRules(rules))
  expect(screen.getByRole('combobox',{name:'AI 对话思考'})).toBeVisible()
  expect(screen.getByRole('combobox',{name:'AI 对话推理强度'})).toBeVisible()
})
it('does not overwrite a newer live update with a late startup read',async()=>{
  let resolve!:(value:{ok:true;value:ModelCapabilityRulesState})=>void
  let changed!:(state:ModelCapabilityRulesState)=>void
  const unsubscribe=vi.fn()
  const initialization=initializeModelRules({getModelCapabilityRules:()=>new Promise(done=>{resolve=done}),onModelCapabilityRulesChanged:listener=>{changed=listener;return unsubscribe}})
  changed(state(rules));resolve({ok:true,value:state(null)})
  const dispose=await initialization
  expect(getModelCapabilityRules()).toEqual(rules);dispose();expect(unsubscribe).toHaveBeenCalledOnce()
})
it('lets manual controls select real wire formats and remove unsupported efforts',()=>{
  const onChange=vi.fn()
  const detected={...capability,thinking:'unknown' as const,encoding:'none' as const,efforts:[],defaultThinking:'default' as const,defaultEffort:'default' as const}
  const view=render(<ManualModelThinkingFields protocol="openai" value={capability} detected={detected} onChange={onChange} />)
  choosePreferencesOption('思考参数格式','enable_thinking（true / false）')
  expect(onChange).toHaveBeenLastCalledWith({...capability,encoding:'enable-thinking',efforts:[],disabledEfforts:[],defaultEffort:'default'})
  view.rerender(<ManualModelThinkingFields protocol="openai" value={onChange.mock.lastCall![0]} detected={detected} onChange={onChange} />)
  expect(screen.queryByText('有效强度')).toBeNull()
  choosePreferencesOption('思考能力识别','自动识别（未识别）')
  expect(onChange).toHaveBeenLastCalledWith(undefined)
})
