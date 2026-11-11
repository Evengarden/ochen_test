'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const js=fs.readFileSync(path.join(__dirname,'..','code.js'),'utf8');
const projectRoot=path.join(__dirname,'..'),pluginManifest=JSON.parse(fs.readFileSync(path.join(projectRoot,'manifest.json'),'utf8'));
const bundledFiles=Object.fromEntries(Object.keys(pluginManifest.ui).filter(file=>file.startsWith('assets/svg/')).map(file=>[file,fs.readFileSync(path.join(projectRoot,file),'utf8')]));
assert.equal(pluginManifest.enablePrivatePluginApi,true,'local plugin APIs are enabled for private document data and clientStorage');
assert.equal(Object.keys(bundledFiles).length,40,'all 40 bundled SVG files are exposed to the plugin runtime');
assert.match(fs.readFileSync(path.join(projectRoot,'src/plugin.ts'),'utf8'),/migrationNamespace:'vector_composer'/,'legacy migration namespace uses only valid Figma characters');
assert.match(fs.readFileSync(path.join(projectRoot,'src/plugin.ts'),'utf8'),/figma\.pluginId\)node\.setPluginData\(key,value\);else node\.setSharedPluginData\(STORAGE\.migrationNamespace,key,value\)/,'local manifests without an ID use persistent document storage');
const storage=new Map(),fetchCalls=[],diagnostics=[];
const pluginConsole={...console,error(...args){diagnostics.push(args);}};
let nextFetchResponse=null;
let modelSelection=[{id:'book',role:'main'},{id:'phone',role:'main'},{id:'puzzle',role:'background'}];
const ctx={console:pluginConsole,TextEncoder,Map,Set,Date,JSON,Math,setTimeout,clearTimeout,__uiFiles__:bundledFiles,fetch:async(url,init)=>{for(const key of Object.keys(init||{}))assert.ok(['method','headers','headersObject','body','credentials','cache','redirect','referrer','integrity'].includes(key),'Figma fetch rejects unsupported init key: '+key);fetchCalls.push({url:String(url),init,body:JSON.parse(init.body)});if(nextFetchResponse){const response=nextFetchResponse;nextFetchResponse=null;return response;}return{ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({selectedObjects:modelSelection,reasoning:'mock'})}}]}),text:async()=>''};}};vm.createContext(ctx);
vm.runInContext(js.split('// Figma is the source of truth')[0],ctx);
const C=ctx.VectorComposerCore;
let sequence=100000;
const allNodes=new Map();
class Node {
 constructor(type='FRAME',id=null,name='Object') {this.type=type;this.id=id||String(sequence++);this.name=name;this.width=100;this.height=100;this.x=0;this.y=0;this.rotation=0;this.children=[];this.parent=null;this.removed=false;this.data={};this.fills=[];this.strokes=[];this.svg=null;allNodes.set(this.id,this);}
 appendChild(n){if(n.parent){n.parent.children=n.parent.children.filter(c=>c!==n);}n.parent=this;this.children.push(n);}
 insertChild(i,n){if(n.parent)n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=this;this.children.splice(i,0,n);}
 findAll(fn){const out=[];for(const c of this.children){if(fn(c))out.push(c);out.push(...c.findAll(fn));}return out;}
 clone(){const n=new Node(this.type,null,this.name);n.width=this.width;n.height=this.height;n.x=this.x;n.y=this.y;n.rotation=this.rotation;n.fills=JSON.parse(JSON.stringify(this.fills));n.strokes=JSON.parse(JSON.stringify(this.strokes));n.shared=JSON.parse(JSON.stringify(this.shared||{}));n.data=JSON.parse(JSON.stringify(this.data));n.failDataKey=this.failDataKey;for(const c of this.children)n.appendChild(c.clone());return n;}
 rescale(s){this.width*=s;this.height*=s;for(const c of this.children)c.rescale(s);}
 resize(w,h){this.width=w;this.height=h;}
 remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
 setSharedPluginData(ns,key,value){if(this.failDataKey===key)throw new Error(`in setSharedPluginData: test denied ${key}`);if(!/^[A-Za-z0-9_.]+$/.test(ns))throw new Error(`The namespace can only consist of alphanumeric characters, _ or .: ${ns}`);this.shared=this.shared||{};this.shared[ns+':'+key]=value;}
 getSharedPluginData(ns,key){if(!/^[A-Za-z0-9_.]+$/.test(ns))throw new Error(`The namespace can only consist of alphanumeric characters, _ or .: ${ns}`);return this.shared?.[ns+':'+key]||'';}
 setPluginData(key,value){if(this.failDataKey===key)throw new Error(`in setPluginData: test denied ${key}`);this.data[key]=value;}
 getPluginData(key){return this.data[key]||'';}
 getPluginDataKeys(){return Object.keys(this.data);}
 async exportAsync(opts){assert.equal(opts.format,'SVG_STRING');return this.svg||'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L10 10Z"/></svg>';}
}
const assets=new Map();
for(const a of C.CATALOG)for(const sz of ['L','S'])for(const role of ['main','background']) {
 const n=new Node('GROUP',a.sources[sz][role],a.name);n.width=a.dims[sz][role].width;n.height=a.dims[sz][role].height;
 const child=new Node('VECTOR');child.fills=[{type:'SOLID',color:role==='main'?{r:1,g:0.89,b:0.88}:{r:0.84,g:0.80,b:0.96}}];n.appendChild(child);assets.set(n.id,n);
}
const sharedPluginData=new Map(),root=new Node('DOCUMENT','root','Document'),sourcePage=new Node('PAGE','page','Библиотека компонентов');
root.getSharedPluginData=(namespace,key)=>{if(!/^[A-Za-z0-9_.]+$/.test(namespace))throw new Error(`The namespace can only consist of alphanumeric characters, _ or .: ${namespace}`);return sharedPluginData.get(`${namespace}:${key}`)||'';};
root.setSharedPluginData=(namespace,key,value)=>{if(!/^[A-Za-z0-9_.]+$/.test(namespace))throw new Error(`The namespace can only consist of alphanumeric characters, _ or .: ${namespace}`);sharedPluginData.set(`${namespace}:${key}`,value);};
root.appendChild(sourcePage);
const messages=[];const figma={root,currentPage:sourcePage,ui:{postMessage:m=>messages.push(m),onmessage:null},clientStorage:{async getAsync(k){return storage.get(k);},async setAsync(k,v){storage.set(k,v);}},notify:()=>{},viewport:{scrollAndZoomIntoView:()=>{}},showUI:()=>{},
 async loadAllPagesAsync(){},async getNodeByIdAsync(id){return assets.get(id)||allNodes.get(id)||null;},async setCurrentPageAsync(p){this.currentPage=p;},
 createPage(){const p=new Node('PAGE',null,'New Page');root.appendChild(p);return p;},
 createFrame(){const f=new Node('FRAME');this.currentPage.appendChild(f);return f;},
 createNodeFromSvg(svg){const n=new Node('GROUP',null,'SVG');const vb=/viewBox=["']([^"']+)/i.exec(svg)?.[1]?.split(/[ ,]+/).map(Number);n.width=vb?.[2]||Number.parseFloat(/width=["']([^"']+)/i.exec(svg)?.[1]||'24');n.height=vb?.[3]||Number.parseFloat(/height=["']([^"']+)/i.exec(svg)?.[1]||'24');const fill=/#([\da-f]{6})/i.exec(svg)?.[0]||'#336699';const child=new Node('VECTOR');child.fills=[{type:'SOLID',color:{r:parseInt(fill.slice(1,3),16)/255,g:parseInt(fill.slice(3,5),16)/255,b:parseInt(fill.slice(5,7),16)/255}}];n.appendChild(child);assets.set(n.id,n);return n;}
};
ctx.figma=figma;ctx.__html__='<html></html>';vm.runInContext(js,ctx);
(async()=>{
 for(const preset of ctx.VectorComposerAI.PRESETS){
  const before=messages.length,requests=fetchCalls.length;
  await figma.ui.onmessage({type:'ai-select',profile:preset});
  assert.ok(!messages.slice(before).some(m=>m.type==='error'||m.type==='ai-status'&&m.state==='error'),`selecting ${preset.id} must not report an endpoint error without browser URL`);
  assert.equal(fetchCalls.length,requests,'selecting a provider does not make an API request');
 }
 const baseState=messages.findLast(m=>m.type==='library-state');
 assert.equal(baseState.activeId,'base','base library is selected on the first run');
 assert.equal(baseState.libraries[0].name,'Базовая библиотека','base library has its final user-facing name');
 assert.equal(messages.findLast(m=>m.type==='scan-result').count,40,'base library is connected during initialization');
 assert.ok(!messages.some(m=>m.type==='error'&&/namespace can only consist/i.test(m.message)),'Figma namespace validation is not triggered');
 const book=assets.get('21:29965'),rescale=book.rescale;book.rescale=null;
 await figma.ui.onmessage({type:'library-select',id:'base'});
 await figma.ui.onmessage({type:'scan'});
 assert.equal(messages.findLast(m=>m.type==='scan-result').count,40,'a non-usable native source is covered by its bundled vector fallback');
 book.rescale=rescale;
 await figma.ui.onmessage({type:'scan'});
 assert.equal(messages.findLast(m=>m.type==='scan-result').count,40);
 const original=JSON.stringify(assets.get('21:29965').children[0].fills);
 await figma.ui.onmessage({type:'ai-save',profile:ctx.VectorComposerAI.PRESETS.find(p=>p.id==='openrouter'),apiKey:'startup-test-key'});
 const options={mode:'components',prompt:'книга, телефон, пазлы',size:'L',format:'landscape',layout:'cluster',palette:'lilac',seed:55,background:true};
 await figma.ui.onmessage({type:'compose',options});
 assert.ok(!messages.some(m=>m.type==='error'&&m.message.includes('private plugin data')),'composition must not require a Figma plugin ID');
 const frame=figma.currentPage.children.find(n=>n.name.startsWith('VC ·'));
 assert.ok(frame,'frame exists');assert.equal(frame.children.length,3);
 assert.equal(frame.width,1200);assert.equal(frame.height,630);assert.equal(frame.clipsContent,true);
 assert.equal(frame.x,0,'first output starts at the page origin');assert.equal(frame.y,0);
 assert.equal(messages.findLast(m=>m.type==='composed').items.filter(x=>x.role==='background').length,1);
 const failingSource=assets.get('21:29965'),framesBeforeStorageFailure=figma.currentPage.children.filter(n=>n.name.startsWith('VC · ')).length;failingSource.failDataKey='vc.originalFills';
 await figma.ui.onmessage({type:'compose',options:{...options,prompt:'книга',seed:56}});failingSource.failDataKey=undefined;
 assert.equal(messages.findLast(m=>m.type==='error').code,'STORAGE_WRITE_FAILED','plugin data write errors are reported with a stable storage code');
 assert.match(messages.findLast(m=>m.type==='error').message,/сохранить данные библиотеки/,'storage errors get a user-facing explanation');
 assert.equal(figma.currentPage.children.filter(n=>n.name.startsWith('VC · ')).length,framesBeforeStorageFailure,'a storage failure removes the incomplete composition frame');
 await figma.ui.onmessage({type:'palette',key:'mint'});
 const fills=frame.children[0].children[0].fills;assert.ok(fills.length);
 assert.equal(JSON.stringify(assets.get('21:29965').children[0].fills),original,'original paints unchanged');
 await figma.ui.onmessage({type:'toggle-role',id:'book'});
 assert.equal(frame.children.length,3);assert.equal(messages.findLast(m=>m.type==='role-changed').items.find(x=>x.id==='book').role,'background');
 const bitmapSvg='<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>';
 frame.svg=bitmapSvg;await figma.ui.onmessage({type:'export'});
 assert.ok(messages.some(m=>m.type==='error'&&m.message.includes('<image>')),'composition export rejects raster images');
 assert.equal(messages.filter(m=>m.type==='svg-ready').length,0);
 frame.svg=null;await figma.ui.onmessage({type:'export'});assert.ok(messages.findLast(m=>m.type==='svg-ready').svg.includes('<svg'));
 assets.get('21:29965').svg=bitmapSvg;await figma.ui.onmessage({type:'export-library'});
 assert.ok(messages.some(m=>m.type==='error'&&m.message.includes('<image>')),'library export rejects raster images');
 assert.equal(messages.filter(m=>m.type==='library-svg-ready').length,0);
 assets.get('21:29965').svg=null;await figma.ui.onmessage({type:'export-library'});
 assert.equal(messages.findLast(m=>m.type==='library-svg-ready').items.length,40);
 await figma.ui.onmessage({type:'compose',options:{...options,format:'square',seed:56}});
 await figma.ui.onmessage({type:'compose',options:{...options,format:'portrait',seed:57}});
 const outputs=figma.currentPage.children.filter(n=>n.type==='FRAME'&&n.name.startsWith('VC · '));
 assert.equal(outputs.length,3);
 for(let i=0;i<outputs.length;i++)for(let j=i+1;j<outputs.length;j++) {
  const a=outputs[i],b=outputs[j];
  assert.ok(a.x+a.width+120<=b.x||b.x+b.width+120<=a.x||a.y+a.height+120<=b.y||b.y+b.height+120<=a.y,'different output formats stay in separate grid cells');
 }
 nextFetchResponse={ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({selectedObjects:[{id:'слон',role:'main'}]})}}]})};
 await figma.ui.onmessage({type:'compose',options:{...options,prompt:'книга, слон'}});
 assert.ok(messages.some(m=>m.type==='error'&&m.message.includes('слон')));
 const originalCreateFrame=figma.createFrame;let brokenFrame=null;
 const framesBefore=figma.currentPage.children.length;
 figma.createFrame=function(){brokenFrame=originalCreateFrame.call(this);brokenFrame.appendChild=()=>{};return brokenFrame;};
 await figma.ui.onmessage({type:'compose',options:{...options,prompt:'книга, телефон, пазлы',seed:88}});
 figma.createFrame=originalCreateFrame;
 assert.ok(messages.some(m=>m.type==='error'&&m.message.includes('0/3')),'missing cloned children are reported');
 assert.equal(brokenFrame.removed,true,'a failed composition removes its incomplete frame');
 assert.equal(figma.currentPage.children.length,framesBefore,'a failed composition leaves no empty frame behind');
 modelSelection=[{id:'book',role:'main'}];
 const profile={id:'custom-mock',name:'Mock provider',baseUrl:'https://mock.example.test/v1',model:'mock-model',format:'openai',authType:'bearer',authHeaderName:'Authorization',temperature:.2,maxOutputTokens:128,timeoutMs:2000,allowLocalHttp:false};
 const apiKey='do-not-persist-this-key';
 await figma.ui.onmessage({type:'ai-save',profile,apiKey});
 assert.ok(JSON.stringify([...storage.entries()]).includes('custom-mock'));
 assert.ok(!JSON.stringify([...storage.entries()]).includes(apiKey),'API key is never persisted to clientStorage');
 assert.ok(!JSON.stringify(messages).includes(apiKey),'API key is never echoed to UI messages');
 await figma.ui.onmessage({type:'ai-test',profile});
 assert.equal(messages.findLast(m=>m.type==='ai-status').state,'success',messages.findLast(m=>m.type==='ai-status').message);
 assert.equal(fetchCalls.at(-1).init.headers.Authorization,'Bearer '+apiKey,'Test Connection uses the current-session key');
 const groqPreset=ctx.VectorComposerAI.PRESETS.find(p=>p.id==='groq');
 const malformedGroq={...groqPreset,name:'Wrong name',baseUrl:'not a URL',model:'openai/gpt-oss-20b',format:'gemini',authType:'header',authHeaderName:'wrong'};
 const groqKey='groq-session-secret';
 await figma.ui.onmessage({type:'ai-save',profile:malformedGroq,apiKey:groqKey});
 const savedGroq=storage.get('vc-ai-profiles').find(p=>p.id==='groq');
 assert.equal(savedGroq.name,'Groq');assert.equal(savedGroq.baseUrl,'https://api.groq.com/openai/v1');
 assert.equal(savedGroq.format,'openai');assert.equal(savedGroq.authType,'bearer');
 assert.equal(savedGroq.model,'openai/gpt-oss-20b');
 assert.ok(!JSON.stringify([...storage.entries()]).includes(groqKey),'built-in API key is not persisted');
 await figma.ui.onmessage({type:'ai-test',profile:malformedGroq});
 assert.equal(fetchCalls.at(-1).url,'https://api.groq.com/openai/v1/chat/completions','runtime resolves Groq preset before Test Connection');
 assert.equal(fetchCalls.at(-1).init.headers.Authorization,'Bearer '+groqKey);
 nextFetchResponse={ok:false,status:401,json:async()=>({}),text:async()=>JSON.stringify({error:{message:`Invalid API key ${groqKey}`}})};
 await figma.ui.onmessage({type:'ai-test',profile:malformedGroq});
 const groqFailure=messages.findLast(m=>m.type==='ai-status');
 assert.equal(groqFailure.state,'error');assert.match(groqFailure.message,/Invalid API key \[API Key скрыт\]/);
 assert.ok(!JSON.stringify(messages).includes(groqKey),'provider error never echoes the session key to UI messages');
 modelSelection=[{id:'book',role:'main'},{id:'phone',role:'main'},{id:'puzzle',role:'main'}];
 const remoteOptions={...options,mode:'metaphor',prompt:'произвольная метафора',layout:'cluster',seed:99};
 await figma.ui.onmessage({type:'compose',options:remoteOptions,profile});
 const remoteResult=messages.findLast(m=>m.type==='composed');
 assert.deepEqual(JSON.parse(JSON.stringify(remoteResult.items.map(x=>x.id))),['book','phone','puzzle'],'LLM selection enters the existing composition engine');
 assert.equal(fetchCalls.at(-1).url,'https://mock.example.test/v1/chat/completions');
 assert.equal(fetchCalls.at(-1).init.headers.Authorization,'Bearer '+apiKey);
 assert.ok(!fetchCalls.at(-1).body.messages[1].content.includes(apiKey));
 const reloadMessages=[],reloadFigma={...figma,ui:{postMessage:m=>reloadMessages.push(m),onmessage:null}};
 const reloadCtx={console:pluginConsole,TextEncoder,Map,Set,Date,JSON,Math,setTimeout,clearTimeout,fetch:ctx.fetch,figma:reloadFigma,__html__:'<html></html>'};vm.createContext(reloadCtx);vm.runInContext(js,reloadCtx);
 await new Promise(resolve=>setTimeout(resolve,5));
 const loaded=reloadMessages.findLast(m=>m.type==='ai-settings');
 assert.ok(loaded.profiles.some(p=>p.id==='custom-mock'&&p.model==='mock-model'),'saved profile is loaded in a fresh plugin session');
 assert.deepEqual(JSON.parse(JSON.stringify(loaded.hasKeyIds)),[],'API keys do not survive the plugin session');
 assert.ok(!JSON.stringify(loaded).includes(apiKey));
 await figma.ui.onmessage({type:'library-create',name:'User SVGs'});
 const userLibrary=messages.findLast(m=>m.type==='library-state').activeId;
 const userOptions={mode:'components',prompt:'leaf',size:'L',format:'square',layout:'cluster',palette:'lilac',seed:101,background:true};
 await figma.ui.onmessage({type:'compose',options:userOptions});
 assert.ok(messages.findLast(m=>m.type==='error').message.includes('нет доступных компонентов'),'empty custom library does not silently fall back to the base library');
 const selectedGroup=new Node('GROUP',null,'Marker');selectedGroup.width=18;selectedGroup.height=14;const selectedVector=new Node('VECTOR');selectedVector.fills=[{type:'SOLID',color:{r:0,g:0,b:0}}];selectedGroup.appendChild(selectedVector);sourcePage.appendChild(selectedGroup);sourcePage.selection=[selectedGroup];figma.currentPage=sourcePage;
 await figma.ui.onmessage({type:'figma-import-selection',size:'S',role:'main'});
 assert.equal(messages.findLast(m=>m.type==='import-result').successes.length,1,'selected Figma group imports as a copy');
 assert.equal(selectedGroup.parent,sourcePage,'selected source group stays in its original place');
 await figma.ui.onmessage({type:'svg-import',files:[{name:'unsafe.svg',svg:'<svg viewBox="0 0 20 20"><script>alert(1)</script></svg>',meta:{name:'Unsafe',semanticId:'unsafe',size:'L',role:'main'}},{name:'external.svg',svg:'<svg viewBox="0 0 20 20"><use href="https&#x3A;//example.test/a.svg#x"/></svg>',meta:{name:'External',semanticId:'external',size:'L',role:'main'}}]});
 assert.equal(messages.findLast(m=>m.type==='import-result').successes.length,0,'unsafe SVG is rejected');
 assert.equal(messages.findLast(m=>m.type==='import-result').failures.length,2,'script and entity-encoded external references are reported');
 const svg=(w,h,color)=>`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><path fill="${color}" d="M0 0L${w} 0L${w} ${h}Z"/></svg>`;
 const variants=[
  {name:'leaf-L.svg',svg:svg(40,30,'#336699'),meta:{name:'Leaf',semanticId:'leaf',size:'L',role:'main',tags:['reading'],synonyms:['paper']}},
  {name:'leaf-S.svg',svg:svg(12,9,'#336699'),meta:{name:'Leaf compact',semanticId:'leaf',size:'S',role:'main',tags:['reading'],synonyms:['paper']}},
  {name:'leaf-bg.svg',svg:svg(38,28,'#AABBCC'),meta:{name:'Leaf backdrop',semanticId:'leaf',size:'L',role:'background',tags:['reading']}},
  {name:'orbit.svg',svg:svg(22,18,'#663399'),meta:{name:'Orbit',semanticId:'orbit',size:'L',role:'main',tags:['ideas']}}
 ];
 await figma.ui.onmessage({type:'svg-import',files:variants});
 const imported=messages.findLast(m=>m.type==='import-result');
 assert.equal(imported.successes.length,4,'multiple SVG files import as real nodes');
 assert.equal(imported.failures.length,0);
 const leafL=imported.successes.find(x=>x.semanticId==='leaf'&&x.size==='L'&&x.role==='main');
 const leafS=imported.successes.find(x=>x.semanticId==='leaf'&&x.size==='S'&&x.role==='main');
 assert.notEqual(leafL.sourceNodeId,leafS.sourceNodeId,'L/S detail variants have distinct source nodes');
 assert.equal(leafL.vectorOnly,true);assert.equal(leafL.width,40);assert.equal(leafL.height,30);
 assert.equal(assets.get(leafL.sourceNodeId).getSharedPluginData('vector_composer','vc.asset').includes('leaf'),true,'document metadata is stored on the source node');
 assert.ok(assets.get(leafL.sourceNodeId).getSharedPluginData('vector_composer','vc.asset'),'asset metadata is readable without a manifest ID');
 const rootCatalog=JSON.parse(root.getSharedPluginData('vector_composer','vc.catalog'));
 assert.equal(rootCatalog.assets,undefined,'document catalog stores metadata references, never SVG payloads');
 await figma.ui.onmessage({type:'asset-update',asset:{id:leafL.id,name:'Leaf Object',semanticId:'leaf',size:'L',role:'main',tags:['reading','knowledge'],synonyms:['paper','book leaf']}});
 assert.ok(messages.findLast(m=>m.type==='library-state').assets.find(x=>x.id===leafL.id).tags.includes('knowledge'));
 await figma.ui.onmessage({type:'palette-save',palette:{name:'User colors',backgroundColors:['#112233'],objectColors:['#FF0000'],sourceColorMapping:{'#336699':'objects.0'}}});
 const paletteState=messages.findLast(m=>m.type==='palette-state'),userPalette=paletteState.palettes.find(x=>x.name==='User colors');
 assert.ok(userPalette,'valid user palette is persisted');
 await figma.ui.onmessage({type:'palette-save',palette:{name:'Broken',backgroundColors:[],objectColors:['oops']}});
 assert.ok(messages.findLast(m=>m.type==='error').message.includes('цветов'));
 modelSelection=[{id:'leaf',role:'main'}];
 await figma.ui.onmessage({type:'compose',options:{...userOptions,palette:userPalette.id}});
 const userFrame=figma.currentPage.children.find(n=>n.name.startsWith('VC · leaf'));
 assert.ok(userFrame&&userFrame.children.length===1,'composition engine uses the active imported catalog');
 assert.equal(userFrame.children[0].children[0].fills[0].color.r,1,'explicit semantic slot mapping recolors the copied node');
 assert.equal(assets.get(leafL.sourceNodeId).children[0].fills[0].color.b,0.6,'source SVG node remains unchanged');
 await figma.ui.onmessage({type:'palette',key:'lilac'});
 await figma.ui.onmessage({type:'restore-colors'});
 assert.equal(userFrame.children[0].children[0].fills[0].color.b,0.6,'recolor reset restores original copy colors');
 modelSelection=[{id:'leaf',role:'main'},{id:'orbit',role:'main'}];
 const localOptions={...userOptions,mode:'metaphor',prompt:'reading and paper',palette:'lilac'};
 await figma.ui.onmessage({type:'compose',options:localOptions,profile});
 assert.equal(messages.findLast(m=>m.type==='composed').items[0].id,'leaf','LLM selects assets from the active custom library');
 const countBeforeFailure=figma.currentPage.children.filter(n=>n.name.startsWith('VC · ')).length;
 nextFetchResponse={ok:false,status:503,text:async()=>''};
 await figma.ui.onmessage({type:'compose',options:localOptions,profile});
 assert.equal(figma.currentPage.children.filter(n=>n.name.startsWith('VC · ')).length,countBeforeFailure,'LLM failure creates no fallback composition');
 assert.match(messages.findLast(m=>m.type==='error').message,/недоступен/);
 const importReloadMessages=[],importReloadFigma={...figma,ui:{postMessage:m=>importReloadMessages.push(m),onmessage:null}};
 const importReloadCtx={console:pluginConsole,TextEncoder,Map,Set,Date,JSON,Math,setTimeout,clearTimeout,fetch:ctx.fetch,figma:importReloadFigma,__html__:'<html></html>'};vm.createContext(importReloadCtx);vm.runInContext(js,importReloadCtx);
 await new Promise(resolve=>setTimeout(resolve,5));
 const restored=importReloadMessages.findLast(m=>m.type==='library-state');
 assert.equal(restored.activeId,userLibrary,'active library survives a plugin restart');
 assert.equal(restored.assets.length,5,'catalog restores metadata from Figma nodes after restart');
 assert.ok(importReloadMessages.some(m=>m.type==='composed'),'last editable composition can be restored after plugin restart');
 const deniedMessages=[],deniedFigma={...figma,ui:{postMessage:m=>deniedMessages.push(m),onmessage:null},clientStorage:{async getAsync(){throw Error('Cannot access client storage without a plugin ID');},async setAsync(){throw Error('Failed to set client storage key: Cannot access client storage without a plugin ID');}}};
 const deniedCtx={console:pluginConsole,TextEncoder,Map,Set,Date,JSON,Math,setTimeout,clearTimeout,fetch:ctx.fetch,figma:deniedFigma,__html__:'<html></html>'};vm.createContext(deniedCtx);vm.runInContext(js,deniedCtx);
 await new Promise(resolve=>setTimeout(resolve,5));
 for(const preset of deniedCtx.VectorComposerAI.PRESETS){
  const before=deniedMessages.length;
  await deniedFigma.ui.onmessage({type:'ai-select',profile:preset});
  assert.ok(!deniedMessages.slice(before).some(m=>m.type==='error'||m.type==='ai-status'&&m.state==='error'),'provider selection works without a plugin ID');
 }
 await deniedFigma.ui.onmessage({type:'ai-save',profile,apiKey});
 assert.match(deniedMessages.findLast(m=>m.type==='ai-status').message,/до закрытия/,'save reports session-only settings when storage is unavailable');
 modelSelection=[{id:'book',role:'main'}];
 await deniedFigma.ui.onmessage({type:'ai-test',profile});
 assert.equal(deniedMessages.findLast(m=>m.type==='ai-status').state,'success','session API key works without clientStorage');
 await deniedFigma.ui.onmessage({type:'ai-delete',id:profile.id});
 assert.ok(deniedMessages.some(m=>m.type==='error'&&m.code==='CLIENT_STORAGE_READ_FAILED'),'clientStorage failure is reported while the plugin continues to run');

 const blankMessages=[],blankNodes=new Map(),blankRoot=new Node('DOCUMENT','blank-root','Blank document'),blankPage=new Node('PAGE','blank-page','Page 1');blankRoot.appendChild(blankPage);
 let blankCurrentPage=blankPage,blankSvgCreates=0;
 const blankFigma={root:blankRoot,currentPage:blankCurrentPage,ui:{postMessage:m=>blankMessages.push(m),onmessage:null},clientStorage:{async getAsync(){return undefined;},async setAsync(){}},notify:()=>{},viewport:{scrollAndZoomIntoView:()=>{}},showUI:()=>{},async loadAllPagesAsync(){},async getNodeByIdAsync(id){return blankNodes.get(id)||null;},async setCurrentPageAsync(p){this.currentPage=p;blankCurrentPage=p;},createPage(){const p=new Node('PAGE',null,'New Page');blankRoot.appendChild(p);return p;},createFrame(){const f=new Node('FRAME');this.currentPage.appendChild(f);return f;},createNodeFromSvg(source){blankSvgCreates++;const n=new Node('GROUP',null,'Bundled SVG');const vb=/viewBox=["']([^"']+)/i.exec(source)?.[1]?.split(/[ ,]+/).map(Number);n.width=vb?.[2]||24;n.height=vb?.[3]||24;const child=new Node('VECTOR');child.fills=[{type:'SOLID',color:{r:.2,g:.3,b:.4}}];n.appendChild(child);blankNodes.set(n.id,n);return n;}};
 const blankCtx={console:pluginConsole,TextEncoder,Map,Set,Date,JSON,Math,setTimeout,clearTimeout,fetch:ctx.fetch,figma:blankFigma,__uiFiles__:bundledFiles,__html__:'<html></html>'};vm.createContext(blankCtx);vm.runInContext(js,blankCtx);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(blankMessages.findLast(m=>m.type==='library-state').activeId,'base','an empty document starts in the base library');
 assert.equal(blankMessages.findLast(m=>m.type==='scan-result').count,40,'bundled vectors install and scan in an empty document');
 assert.equal(blankSvgCreates,40,'the first startup imports each bundled vector exactly once');
 const blankLibraryPage=blankRoot.children.find(p=>p.name==='Vector Composer · Library');
 assert.equal(blankLibraryPage.children.length,40,'all bundled vectors are stored on the library page');
 const blankReloadMessages=[],blankReloadFigma={...blankFigma,ui:{postMessage:m=>blankReloadMessages.push(m),onmessage:null}};
 const blankReloadCtx={console:pluginConsole,TextEncoder,Map,Set,Date,JSON,Math,setTimeout,clearTimeout,fetch:ctx.fetch,figma:blankReloadFigma,__uiFiles__:bundledFiles,__html__:'<html></html>'};vm.createContext(blankReloadCtx);vm.runInContext(js,blankReloadCtx);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(blankReloadMessages.findLast(m=>m.type==='scan-result').count,40,'bundled source references restore after a plugin restart');
 assert.equal(blankSvgCreates,40,'restarting does not create duplicate base vectors');

 const migrationRoot=new Node('DOCUMENT','migration-root','Legacy document'),migrationPage=new Node('PAGE','migration-page','Vector Composer · Library'),legacyNode=new Node('GROUP','legacy-source','Legacy Leaf');legacyNode.width=20;legacyNode.height=20;const legacyVector=new Node('VECTOR');legacyVector.fills=[{type:'SOLID',color:{r:.2,g:.4,b:.6}}];legacyNode.appendChild(legacyVector);migrationRoot.appendChild(migrationPage);migrationPage.appendChild(legacyNode);
 const legacyAsset={id:'legacy-asset',semanticId:'leaf',name:'Leaf',sourceNodeId:legacyNode.id,libraryId:'legacy-library',size:'L',role:'main',tags:['legacy'],synonyms:['old'],width:20,height:20,vectorOnly:true};
 legacyNode.setSharedPluginData('vector_composer','asset',JSON.stringify(legacyAsset));
 migrationRoot.setSharedPluginData('vector_composer','project-catalog',JSON.stringify({libraries:[{id:'legacy-library',name:'Legacy Library'}],assets:[legacyAsset],activeLibraryId:'demo'}));
 const migrationMessages=[],migrationFigma={...blankFigma,root:migrationRoot,currentPage:migrationPage,ui:{postMessage:m=>migrationMessages.push(m),onmessage:null},async getNodeByIdAsync(id){return id===legacyNode.id?legacyNode:blankNodes.get(id)||null;},createPage(){const p=new Node('PAGE',null,'New Page');migrationRoot.appendChild(p);return p;}};
 const migrationCtx={console:pluginConsole,TextEncoder,Map,Set,Date,JSON,Math,setTimeout,clearTimeout,fetch:ctx.fetch,figma:migrationFigma,__uiFiles__:bundledFiles,__html__:'<html></html>'};vm.createContext(migrationCtx);vm.runInContext(js,migrationCtx);
 await new Promise(resolve=>setTimeout(resolve,10));
 const migratedState=migrationMessages.findLast(m=>m.type==='library-state');
 assert.equal(migratedState.activeId,'base','legacy Demo selection migrates to the base library');
 assert.ok(migratedState.libraries.some(x=>x.id==='legacy-library'&&x.name==='Legacy Library'),'legacy user library is preserved during catalog migration');
 assert.equal(migratedState.assets.find(x=>x.id==='legacy-asset').semanticId,'leaf','legacy asset metadata migrates from a valid namespace');
 assert.ok(JSON.parse(migrationRoot.getSharedPluginData('vector_composer','vc.catalog')).libraries.some(x=>x.id==='legacy-library'),'normalized catalog is written to document data');
 assert.ok(JSON.parse(legacyNode.getSharedPluginData('vector_composer','vc.asset')).id==='legacy-asset','legacy node metadata is copied to current document keys');
 assert.ok(!JSON.stringify(diagnostics).includes(apiKey),'technical logs redact current-session API keys');
 console.log('plugin mock: base installation, safe storage migration, SVG validation/import, palettes, active-library generation and reload passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
