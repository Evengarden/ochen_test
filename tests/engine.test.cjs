'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'..','code.js'),'utf8');
const context={};vm.createContext(context);
vm.runInContext(code.split('// Figma is the source of truth')[0],context);
const C=context.VectorComposerCore;
const json=x=>JSON.parse(JSON.stringify(x));
assert.equal(C.CATALOG.length,10);
const opts={mode:'components',prompt:'study',size:'S',format:'landscape',layout:'cluster',palette:'lilac',seed:42,background:true};
const selection=ids=>({selectedObjects:ids.map(id=>({id,role:'main'}))});
function checkScene(scene,catalog=C.CATALOG){
 assert.equal(new Set(scene.items.map(x=>x.scale)).size,1,'one shared scale');
 const boxes=scene.items.map(item=>{const d=C.source(item.id,scene.size,item.role,catalog);return {...item,w:d.width*item.scale,h:d.height*item.scale};});
 for(const b of boxes){
  assert.ok([b.x,b.y,b.scale,b.w,b.h].every(Number.isFinite));assert.ok(b.scale>0);
  assert.ok(b.x>=-1e-6&&b.y>=-1e-6&&b.x+b.w<=scene.width+1e-6&&b.y+b.h<=scene.height+1e-6,'every vector fits');
  if(scene.layout==='headline')assert.ok(b.x>=scene.width*.38-1e-6,'left title region stays empty');
 }
 for(let i=0;i<boxes.length;i++)for(let j=0;j<i;j++){
  const a=boxes[i],b=boxes[j];
  assert.ok(a.x+a.w<=b.x+1e-6||b.x+b.w<=a.x+1e-6||a.y+a.h<=b.y+1e-6||b.y+b.h<=a.y+1e-6,'objects remain readable without occlusion');
 }
}
const sets=[['book'],['book','lamp','pen'],['book','phone','headphones','lamp','pen'],C.CATALOG.map(x=>x.id)];
for(const format of ['landscape','square','portrait'])for(const layout of ['cluster','offset','headline'])for(const size of ['S','L'])for(const ids of sets){
 const o={...opts,format,layout,size},scene=json(C.plan(o,selection(ids)));
 checkScene(scene);assert.equal(scene.items.length,ids.length,'no four-object limit');
 assert.deepEqual(scene,json(C.plan(o,selection([...ids].reverse()))),'provider array order does not control positions');
}
const a=json(C.plan(opts,selection(sets[1])));
assert.deepEqual(a,json(C.plan(opts,selection(sets[1]))),'same seed repeats');
assert.notDeepEqual(a.items,json(C.plan({...opts,seed:123},selection(sets[1]))).items,'seed changes layout');
const reversed=json(C.plan({...opts,layout:'offset'},selection(sets[1])));
for(const item of a.items){const other=reversed.items.find(x=>x.id===item.id),d=C.source(item.id,'S',item.role);assert.ok(Math.abs(item.x+other.x+d.width*item.scale-a.width)<1e-6,'offset mirrors positions without reflecting vectors');}
for(const ids of [sets[1],sets[2]])for(const layout of ['cluster','offset','headline']){
 const scene=C.plan({...opts,layout},selection(ids)),book=scene.items.find(x=>x.id==='book'),pen=scene.items.find(x=>x.id==='pen');
 const bd=C.source('book','S','main'),pd=C.source('pen','S','main'),scale=book.scale;
 const dx=Math.max(book.x-pen.x-pd.width*scale,pen.x-book.x-bd.width*scale,0);
 const dy=Math.max(book.y-pen.y-pd.height*scale,pen.y-book.y-bd.height*scale,0);
 assert.ok(Math.hypot(dx,dy)<scene.width*.04,'pen remains beside the book in study/reference sets');
}
const l=json(C.plan({...opts,size:'L'},selection(sets[1])));
for(const item of a.items){const other=l.items.find(x=>x.id===item.id);assert.ok(Math.abs(item.x-other.x)<.01&&Math.abs(item.y-other.y)<.01,'L/S detail variants fit at comparable visual sizes');}
const mixed={selectedObjects:[{id:'book',role:'main'},{id:'lamp',role:'background'},{id:'pen',role:'main'}]};
const mixedScene=C.plan(opts,mixed);checkScene(mixedScene);assert.equal(mixedScene.items[0].role,'background','monochrome role stays behind colored objects');
assert.throws(()=>C.plan({...opts,background:false},mixed),/отключены/);
assert.throws(()=>C.plan(opts,{selectedObjects:[]}),/не выбрал/);
assert.throws(()=>C.plan(opts,selection(['missing'])),/неизвестный/);
assert.equal(C.source('book','L','main').id,'21:29965');
assert.equal(C.source('book','S','background').id,'24:6934');
assert.equal(C.source('unknown','S','main'),null);
for(const p of Object.values(json(C.PALETTES))) {assert.equal(p.background.length,4);assert.equal(p.objects.length,4);}
for(const to of ['lilac','peach','mint']) {
 const p=json(C.paletteByKey(to,null));
 assert.equal(C.mapColor('#D7CDF5','background',p),p.background[0].toUpperCase());
 assert.equal(C.mapColor('#F9A3AA','main',p),p.objects[1].toUpperCase());
 assert.ok(p.background.includes(C.mapColor('#181817','background',p)));
 assert.ok(!p.objects.slice(0,3).includes(C.mapColor('#F9A3AA','background',p)));
}
const good=json(C.validatePalette({name:'Test',background:['#111111','#222222','#333333','#444444'],objects:['#555555','#666666','#777777','#888888']}));
assert.equal(good.name,'Test');
assert.throws(()=>C.validatePalette({background:['#ffffff'],objects:[]}));
assert.throws(()=>C.validatePalette(null));
assert.throws(()=>C.paletteByKey('unknown',null));
const userCatalog=[{id:'reading-kit',name:'Reading Kit',tags:['learning','quiet'],synonyms:['reader','paper'],sources:{L:{main:{id:'user:l:main',width:60,height:40}},S:{main:{id:'user:s:main',width:22,height:15}}}}];
const userScene=json(C.plan({...opts,size:'S'},selection(['reading-kit']),userCatalog));
checkScene(userScene,userCatalog);assert.equal(userScene.items[0].id,'reading-kit');
assert.equal(C.source('reading-kit','S','main',userCatalog).id,'user:s:main');
assert.throws(()=>C.plan(opts,{selectedObjects:[{id:'reading-kit',role:'background'}]},userCatalog),/вариант/);
const invalid=[{...userCatalog[0],sources:{S:{main:{id:'bad',width:0,height:NaN}}}}];
assert.throws(()=>C.plan(opts,selection(['reading-kit']),invalid),/габариты/);
const semanticPalette=json(C.validatePalette({id:'custom',name:'Flexible',backgroundColors:['#112233','#334455'],objectColors:['#FF0000'],sourceColorMapping:{'#123456':'objects.0'}}));
assert.equal(semanticPalette.background.length,2,'custom palette color counts are not fixed at four');
assert.deepEqual(json(C.mapColorResult('#123456','main',semanticPalette)),{color:'#FF0000',mapped:true,restricted:false});
assert.equal(C.mapColorResult('#123456','background',semanticPalette).restricted,true,'object slots are forbidden on background assets');
assert.equal(C.mapColorResult('#ABCDEF','main',semanticPalette).mapped,false,'unmapped custom source colors are left unchanged');
assert.throws(()=>C.validatePalette({backgroundColors:['#112233'],objectColors:['#FF0000'],sourceColorMapping:{'#123456':'objects.2'}}),/отсутствующий/);
console.log('engine: layouts, all formats and sizes, 1–10 objects, no occlusion, shared scale, title space, seed, input ordering, roles and palettes passed');
