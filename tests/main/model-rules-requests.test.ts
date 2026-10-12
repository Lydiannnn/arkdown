import { afterEach, expect, it } from 'vitest'
import { createModelProtocolClient, type ModelChatInput } from '../../src/main/models/model-protocol-client'
import { setModelCapabilityRules, type RuleFile } from '../../src/shared/model-capability-rules'
import { parseModelCapabilityOverride } from '../../src/shared/large-model-settings'
import { modelThinkingControlState } from '../../src/shared/model-thinking'
const base: ModelChatInput={provider:'deepseek',protocol:'openai',baseUrl:'https://api.deepseek.com',modelId:'deepseek-flash',apiKey:'fixture',messages:[{role:'user',content:'test'}],thinkingMode:'enabled',reasoningEffort:'max',signal:new AbortController().signal,onDelta(){}}
afterEach(()=>setModelCapabilityRules(null))
async function bodyFor(input:Partial<ModelChatInput>={}) {
  let body:Record<string,any>={}
  const client=createModelProtocolClient(async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{content:'OK'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})})
  await client.streamChat({...base,...input});return body
}
it.each([
  ['deepseek','https://api.deepseek.com','deepseek-flash',['low','high','max']],
  ['hy','https://tokenhub.tencentmaas.com/v1','hy3',['low','high']],
  ['hy','https://tokenhub.tencentmaas.com/v1','hy4-preview',['high']],
  ['doubao','https://ark.cn-beijing.volces.com/api/v3','doubao-seed-evolving',['low','medium','high']],
  ['zhipu','https://open.bigmodel.cn/api/paas/v4','glm-5.2',['high','max']],
] as const)('sends each verified grade and a real off for %s %s %s',async(provider,baseUrl,modelId,efforts)=>{
  for(const reasoningEffort of efforts)expect(await bodyFor({provider,baseUrl,modelId,reasoningEffort})).toMatchObject({thinking:{type:'enabled'},reasoning_effort:reasoningEffort})
  const off=await bodyFor({provider,baseUrl,modelId,thinkingMode:'disabled'})
  expect(off).toHaveProperty('thinking.type','disabled');expect(off).not.toHaveProperty('reasoning_effort')
})
it('keeps Kimi Code fixed-on without inventing a parameter',async()=>{
  const body=await bodyFor({provider:'kimi',baseUrl:'https://api.moonshot.cn/v1',modelId:'kimi-k2.7-code',thinkingMode:'disabled'})
  expect(body).not.toHaveProperty('thinking');expect(body).not.toHaveProperty('reasoning_effort')
})
it('allows a manual thinking definition independently of token limits',async()=>{
  const capabilityOverride=parseModelCapabilityOverride({thinking:{thinking:'toggle',encoding:'enable-thinking',efforts:[],defaultThinking:'enabled',defaultEffort:'default',disabledEfforts:[]}})!
  expect(capabilityOverride).toBeDefined()
  expect(await bodyFor({modelId:'unknown',capabilityOverride,thinkingMode:'disabled'})).toHaveProperty('enable_thinking',false)
  expect(modelThinkingControlState({...base,modelId:'unknown',capabilityOverride},{thinkingMode:'default',reasoningEffort:'default'})).toMatchObject({toggle:true,enabled:true,efforts:[]})
})
it('updates a new model capability from a data file without changing the adapter',async()=>{
  const rules:RuleFile={schemaVersion:1,revision:'2026-09-13',rules:[{id:'future',provider:'deepseek',protocol:'openai',baseUrls:[base.baseUrl],modelIds:['future-flash'],capability:{thinking:'toggle',encoding:'thinking-effort',efforts:['low','xhigh'],defaultEffort:'xhigh',defaultThinking:'enabled',disabledEfforts:[]}}]}
  setModelCapabilityRules(rules)
  expect(await bodyFor({modelId:'future-flash',reasoningEffort:'xhigh'})).toMatchObject({thinking:{type:'enabled'},reasoning_effort:'xhigh'})
})
it.each(['json','sse'] as const)('preserves signed Chat replay for the same model and endpoint (%s)',async format=>{
  const sent:Record<string,any>[]=[];const visible:string[]=[]
  const cipher='signed-complete-content'
  const client=createModelProtocolClient(async(_url,init)=>{
    sent.push(JSON.parse(String(init?.body)))
    if(format==='json')return new Response(JSON.stringify({choices:[{message:{content:'Hello',encrypted_content:cipher},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})
    return new Response([{choices:[{delta:{reasoning_content:'summary'}}]},{choices:[{delta:{encrypted_content:cipher}}]},{choices:[{delta:{content:'Hello'}}]}].map(v=>'data: '+JSON.stringify(v)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  })
  const input={...base,provider:'doubao' as const,baseUrl:'https://ark.cn-beijing.volces.com/api/v3',modelId:'doubao-seed-evolving',onDelta:(text:string)=>visible.push(text)}
  const result=await client.streamChat(input)
  expect(visible).toEqual(['Hello']);expect(result.providerReplay).toMatchObject({protocol:'openai-chat',encryptedContent:cipher,modelId:input.modelId,baseUrl:input.baseUrl})
  const messages=[...base.messages,{role:'assistant' as const,content:'Hello',providerReplay:result.providerReplay!},{role:'user' as const,content:'continue'}]
  await client.streamChat({...input,messages})
  expect(sent[1].messages[1]).toHaveProperty('encrypted_content',cipher)
  await client.streamChat({...input,baseUrl:'https://proxy.example/v1',messages})
  expect(sent[2].messages[1]).not.toHaveProperty('encrypted_content')
})
