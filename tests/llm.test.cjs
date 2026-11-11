'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'..','code.js'),'utf8');
const ctx={clearTimeout,setTimeout,fetch:global.fetch,Map,Set,Date,JSON,Math,TextEncoder};vm.createContext(ctx);
vm.runInContext(code.split('// Figma is the source of truth')[0],ctx);
const C=ctx.VectorComposerCore,AI=ctx.VectorComposerAI;
const asset=(id,roles=['main','background'])=>{const a=C.CATALOG.find(x=>x.id===id);return{id:a.id,name:a.name,tags:[...a.tags],roles};};
const reply=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body,text:async()=>JSON.stringify(body)});
const profile={id:'custom-test',name:'Test API',baseUrl:'https://api.example.test/v1',model:'mock-model',format:'openai',authType:'header',authHeaderName:'X-API-Key',temperature:.4,maxOutputTokens:128,timeoutMs:2000,allowLocalHttp:false};
const books=[asset('book'),asset('phone')];
const choice=JSON.stringify({selectedObjects:[{id:'phone',role:'main'},{id:'book',role:'background'}],layout:'offset',reasoning:'Связь и знания'});

assert.deepEqual(JSON.parse(JSON.stringify(AI.PRESETS.map(p=>[p.id,p.model]))),[
 ['gemini','gemini-3.8-flash'],['groq','openai/gpt-oss-20b'],['openrouter','openrouter/auto'],
]);
assert.throws(()=>AI.validateProfile({...profile,baseUrl:'http://api.example.test/v1'}),/HTTPS/);
assert.throws(()=>AI.validateProfile({...profile,baseUrl:'not a URL'}),/адрес API/);
assert.throws(()=>AI.validateProfile({...profile,baseUrl:'https://api.example.test/v1?api_key=secret'}),/API-ключи/);
assert.throws(()=>AI.validateProfile({...profile,baseUrl:'http://192.168.1.4:11434/v1',allowLocalHttp:true}),/localhost/);
assert.doesNotThrow(()=>AI.validateProfile({...profile,baseUrl:'http://localhost:11434/v1',allowLocalHttp:true}));
for(const preset of AI.PRESETS.filter(p=>p.id!=='local')){
 const normalized=AI.validateProfile({...preset,baseUrl:'not a URL',format:'local',authType:'header',authHeaderName:'bad header'});
 assert.equal(normalized.baseUrl,preset.baseUrl,`${preset.id} keeps its built-in base URL`);
 assert.equal(normalized.format,preset.format,`${preset.id} keeps its built-in API format`);
 assert.equal(normalized.authType,preset.authType,`${preset.id} keeps its built-in authentication type`);
}
assert.throws(()=>AI.validateInterpretation({selectedObjects:[{id:'missing-id',role:'main'}],layout:'cluster'},books),/отсутствующий/);
assert.throws(()=>AI.validateInterpretation('{bad json',books),/некорректный JSON/);
assert.throws(()=>AI.validateInterpretation({selectedObjects:[{id:'phone',role:'background'}],layout:'cluster'},[asset('phone',['main'])]),/недоступен вариант/);
const deduped=AI.validateInterpretation({selectedObjects:[{id:'book',role:'main'},{id:'book',role:'background'}],layout:'cluster'},books);
assert.deepEqual(JSON.parse(JSON.stringify(deduped.selectedObjects)),[{id:'book',role:'main'}]);

const five=C.CATALOG.slice(0,5).map(a=>asset(a.id));
assert.equal(AI.validateInterpretation({selectedObjects:five.map(a=>({id:a.id,role:'main'}))},five).selectedObjects.length,5);

(async()=>{
 // Replay the singleton response shown in Figma through the real providers.
 for(const format of ['openai','gemini']){
  const all=C.CATALOG.map(a=>asset(a.id));let calls=0;
  const selection=[{id:'coin',role:'main'},{id:'wallet',role:'main'},{id:'folder',role:'main'}];
  const provider=AI.createProvider({...profile,format},'test-key',async(_,init)=>{
   calls++;
   const payload=JSON.parse(init.body);
   const schema=format==='gemini'?payload.generationConfig.responseFormat.text.schema:payload.response_format.json_schema.schema;
   if(calls===2)assert.equal(schema.properties.selectedObjects.minItems,3,'retry keeps the theme cardinality constraint');
   const content=JSON.stringify({selectedObjects:calls===1?selection.slice(0,1):selection});
   return reply(format==='gemini'?{candidates:[{content:{parts:[{text:content}]}}]}:{choices:[{message:{content}}]});
  });
  const interpreted=await provider.interpret('Рост бизнеса',all,{mode:'metaphor'});
  assert.equal(calls,2,'a single-object theme response is requested again from the LLM');
  assert.equal(interpreted.selectedObjects.length,3,'theme selection is not reduced to a single symbol');
  const scene=C.plan({mode:'metaphor',prompt:'Рост бизнеса',size:'L',format:'landscape',layout:'cluster',palette:'lilac',seed:42,background:true},interpreted);
  assert.equal(scene.items.length,3,'the complete provider selection reaches the canvas planner');
 }
 // A requested single component and a one-object library remain valid.
 for(const format of ['openai','gemini']){
  let calls=0;
  const provider=AI.createProvider({...profile,format},'test-key',async()=>{
   calls++;const content=JSON.stringify({selectedObjects:[{id:'book',role:'main'}]});
   return reply(format==='gemini'?{candidates:[{content:{parts:[{text:content}]}}]}:{choices:[{message:{content}}]});
  });
  assert.equal((await provider.interpret('книга',books,{mode:'components'})).selectedObjects.length,1);
  assert.equal(calls,1,'explicit singleton is not expanded');
  assert.equal((await provider.interpret('учёба',[asset('book')],{mode:'metaphor'})).selectedObjects.length,1);
  calls=0;
  await assert.rejects(provider.interpret('учёба',C.CATALOG.map(a=>asset(a.id)),{mode:'metaphor'}),/минимум 3/);
  assert.equal(calls,2,'a persistently short answer fails after one retry without local additions');
 }
 let duplicates=0;
 const duplicateProvider=AI.createProvider(profile,'key',async()=>{
  duplicates++;return reply({choices:[{message:{content:JSON.stringify({selectedObjects:Array.from({length:3},()=>({id:'book',role:'main'}))})}}]});
 });
 await assert.rejects(duplicateProvider.interpret('учёба',C.CATALOG.map(a=>asset(a.id)),{mode:'metaphor'}),/минимум 3/);
 assert.equal(duplicates,2,'duplicate IDs cannot satisfy the requested item count');
 let captured;
 const openai=AI.createProvider(profile,'secret-never-stored',async(url,init)=>{captured={url:String(url),init,body:JSON.parse(init.body)};return reply({choices:[{message:{content:choice}}]});});
 const result=await openai.interpret('инновации и развитие бизнеса',books,{preferredLayout:'headline',background:true});
 assert.equal(captured.url,'https://api.example.test/v1/chat/completions');
 assert.equal(captured.init.headers['X-API-Key'],'secret-never-stored');
 assert.equal(captured.init.redirect,'error');assert.equal(captured.body.model,'mock-model');
 assert.equal(captured.body.response_format.type,'json_schema');assert.equal(captured.body.response_format.json_schema.schema.properties.selectedObjects.items.properties.id.enum.length,2);assert.equal(captured.body.max_tokens,128);
 assert.ok(!captured.init.body.includes('secret-never-stored'));
 assert.ok(captured.body.messages[0].content.includes('phone'));
 assert.equal(result.layout,undefined,'layout remains a user setting');assert.equal(result.selectedObjects.length,2);

 const builtInEndpoints={
  gemini:'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
  groq:'https://api.groq.com/openai/v1/chat/completions',
  openrouter:'https://openrouter.ai/api/v1/chat/completions',
 };
 const testChoice=JSON.stringify({selectedObjects:[{id:C.CATALOG[0].id,role:'main'}],layout:'cluster',reasoning:'ok'});
 for(const [id,expectedUrl] of Object.entries(builtInEndpoints)){
  const preset=AI.PRESETS.find(p=>p.id===id);let request;
  const provider=AI.createProvider({...preset,baseUrl:'not a URL',format:'local',authType:'header',authHeaderName:'bad header'},'embedded-key',async(url,init)=>{
   request={url:String(url),init,body:JSON.parse(init.body)};
   const body=preset.format==='gemini'?{candidates:[{content:{parts:[{text:testChoice}]}}]}:{choices:[{message:{content:testChoice}}]};
   return reply(body);
  });
  assert.equal(await provider.testConnection(),true,`${id} Test Connection makes a valid request`);
  assert.equal(request.url,expectedUrl,`${id} uses its full provider endpoint`);
  assert.deepEqual(Object.keys(request.init).sort(),['body','headers','method','redirect'],`${id} sends only Figma-supported fetch options`);
  if(preset.format==='openai'){
   assert.equal(request.body.model,preset.model);
   assert.equal(JSON.parse(request.body.messages[1].content).request,C.CATALOG[0].name,'connection check explicitly requests its available component');
  }
  assert.equal(request.init.headers[preset.authType==='bearer'?'Authorization':preset.authHeaderName],preset.authType==='bearer'?'Bearer embedded-key':'embedded-key');
 }

 const geminiProfile={...AI.PRESETS.find(p=>p.id==='gemini')};let geminiRequest;
 const gemini=AI.createProvider(geminiProfile,'gemini-secret',async(url,init)=>{geminiRequest={url:String(url),init,body:JSON.parse(init.body)};return reply({candidates:[{content:{parts:[{text:choice}]}}]});});
 await gemini.interpret('обучение',books);
 assert.equal(geminiRequest.url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
 assert.equal(geminiRequest.init.headers['x-goog-api-key'],'gemini-secret');
 assert.equal(geminiRequest.body.generationConfig.responseFormat.text.mimeType,'APPLICATION_JSON');
 assert.ok(!geminiRequest.init.body.includes('gemini-secret'));

 let fullEndpointRequest;
 const fullEndpoint=AI.createProvider({...profile,baseUrl:'https://api.example.test/v1/chat/completions?version=2026'},'key',async(url,init)=>{
  fullEndpointRequest={url:String(url),init};return reply({choices:[{message:{content:choice}}]});
 });
 await fullEndpoint.interpret('full endpoint',books);
 assert.equal(fullEndpointRequest.url,'https://api.example.test/v1/chat/completions?version=2026','an already complete endpoint is not extended again');

 let retryCalls=0;const compatibleFallback=AI.createProvider(profile,'key',async(_,init)=>{
  retryCalls++;if(retryCalls===1)return{ok:false,status:400,text:async()=>'response_format json_schema is unsupported'};
  assert.equal(JSON.parse(init.body).response_format,undefined);return reply({choices:[{message:{content:choice}}]});
 });
 await compatibleFallback.interpret('retry schema fallback',books);assert.equal(retryCalls,2);

 assert.equal(AI.LocalSemanticResolver,undefined,'offline semantic fallback is removed');
 assert.throws(()=>AI.createProvider(profile,''),/API-ключ/);
 const options={mode:'metaphor',prompt:'другая метафора',size:'S',format:'landscape',layout:'cluster',palette:'mint',seed:34,background:true};
 const scene=C.plan(options,result);
 assert.equal(scene.layout,'cluster');assert.equal(scene.palette,'mint');assert.deepEqual([...new Set(scene.items.map(x=>x.scale))],[scene.items[0].scale]);
 assert.equal(scene.items.find(x=>x.id==='book').role,'background');assert.ok(scene.items.every(x=>x.rotation===0));
 assert.equal(scene.items.find(x=>x.id==='phone').scale,scene.items.find(x=>x.id==='book').scale);

 for(const [code,message] of [[401,/API-ключ/],[403,/API-ключ/],[429,/квота/],[402,/квота/],[404,/модель/]]){
  const provider=AI.createProvider(profile,'key',async()=>reply({error:'mock'},code));
  await assert.rejects(provider.interpret('x',books),message);
 }
 const secretKey='private-api-key';
 const rejected=AI.createProvider(profile,secretKey,async()=>({ok:false,status:401,text:async()=>JSON.stringify({error:{message:`Invalid key ${secretKey}`}})}));
 await assert.rejects(rejected.testConnection(),error=>{
  assert.match(error.message,/Invalid key \[API Key скрыт\]/);
  assert.ok(!error.message.includes(secretKey),'provider errors never expose the API key');
  return true;
 });
 const offline=AI.createProvider(profile,'key',async()=>{throw TypeError('network denied');});
 await assert.rejects(offline.interpret('x',books),/CORS.*networkAccess/);
 const timeoutProfile={...profile,timeoutMs:1000};
 const timeout=AI.createProvider(timeoutProfile,'key',()=>new Promise(()=>{}));
 await assert.rejects(timeout.interpret('x',books),/время ожидания/);
 const stalledBody=AI.createProvider(timeoutProfile,'key',async()=>({ok:true,status:200,json:()=>new Promise(()=>{}),text:async()=>''}));
 await assert.rejects(stalledBody.testConnection(),/время ожидания/,'timeout also covers reading the response body');
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'..','manifest.json'),'utf8'));
 assert.ok(manifest.networkAccess.allowedDomains.includes('https://api.groq.com'),'Groq origin is allowed by Figma networkAccess');
 console.log('llm: provider requests, secure profiles, strict asset validation, LLM-only mode, user layout, auth/rate/timeout failures passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
