'use strict';
// Render the production planner with the original SVG paths. No provider calls.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'code.js'),'utf8').split('// Figma is the source of truth')[0],ctx);
const C=ctx.VectorComposerCore,layouts=['cluster','offset','headline'];
const cases=[
 {name:'S · phone / headphones / lamp',size:'S',palette:'mint',ids:['phone','headphones','lamp']},
 {name:'L · book / phone / headphones / lamp / pen',size:'L',palette:'peach',ids:['book','phone','headphones','lamp','pen']},
 {name:'L · study',size:'L',palette:'lilac',ids:['book','lamp','pen']},
];
const frames=[];
for(let row=0;row<cases.length;row++)for(let col=0;col<layouts.length;col++){
 const sample=cases[row],layout=layouts[col];
 const scene=C.plan({mode:'components',prompt:sample.ids.join(', '),size:sample.size,format:'landscape',layout,palette:sample.palette,seed:42,background:true},{selectedObjects:sample.ids.map(id=>({id,role:sample.size==='S'&&id==='headphones'?'background':'main'}))});
 const palette=C.paletteByKey(sample.palette,null);
 const objects=scene.items.map(item=>{
  const src=fs.readFileSync(path.join(root,'assets','svg',sample.size,item.role,item.id+'.svg'),'utf8').replace(/<\?xml[^>]*>/,'').replace(/#[0-9a-f]{6}\b/gi,hex=>C.mapColor(hex,item.role,palette));
  return `<g transform="translate(${item.x} ${item.y}) scale(${item.scale})">${src}</g>`;
 }).join('');
 frames.push(`<g transform="translate(${col*1230+15} ${row*700+40})"><text y="-12" font-family="Arial" font-size="22" fill="#444">${sample.name} · ${layout}</text><svg width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${palette.background[0]}"/>${objects}</svg></g>`);
}
const out=path.join(root,'docs','previews');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'layout-review.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="3690" height="3690" viewBox="0 0 3690 3690"><rect width="3690" height="3690" fill="#f5f5f5"/>${frames.join('')}</svg>`);
console.log('docs/previews/layout-review.svg');
