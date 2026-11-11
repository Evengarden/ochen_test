/// <reference path="catalog.ts" />
namespace VectorComposerCore {
  export type Role = 'main' | 'background';
  export type Size = 'L' | 'S';
  export type Format = 'square' | 'landscape' | 'portrait';
  export type Layout = 'cluster' | 'offset' | 'headline';
  export type Mode = 'metaphor' | 'components';
  export type SelectedObject = { id: string; role: Role };
  export type AvailableAsset = { id: string; name: string; tags: string[]; synonyms?: string[]; roles: Role[] };
  export type InterpretationResult = { selectedObjects: SelectedObject[]; reasoning?: string };
  export type Palette = { name: string; background: string[]; objects: string[]; sourceColorMapping?: Record<string,string>; builtin?: boolean };
  export type CatalogAsset = {
    id: string;
    name: string;
    tags: readonly string[];
    synonyms?: readonly string[];
    sources: Partial<Record<Size,Partial<Record<Role,string|{id:string;width:number;height:number}>>>>;
    dims?: Partial<Record<Size,Partial<Record<Role,{width:number;height:number}>>>>;
  };
  export type SceneItem = { id: string; role: Role; x: number; y: number; scale: number; rotation: number; z: number };
  export type Scene = { width: number; height: number; size: Size; palette: string; layout: Layout; seed: number; background: boolean; items: SceneItem[] };
  export type ComposeOptions = { mode: Mode; prompt: string; size: Size; format: Format; layout: Layout; palette: string; seed: number; background: boolean };

  export const FORMATS: Record<Format, { width: number; height: number; label: string }> = {
    square: { width: 1000, height: 1000, label: '1:1 · 1000×1000' },
    landscape: { width: 1200, height: 630, label: '1200×630' },
    portrait: { width: 800, height: 1200, label: '800×1200' },
  };
  export function knownIds(catalog:readonly CatalogAsset[]=CATALOG): string[] { return catalog.map(x=>x.id); }
  export function source(id: string, size: Size, role: Role, catalog:readonly CatalogAsset[]=CATALOG): { id: string; width: number; height: number } | null {
    const asset=catalog.find(x=>x.id===id);
    const entry=asset?.sources[size]?.[role];
    if(typeof entry==='string') {
      const dims=asset?.dims?.[size]?.[role];
      return dims?{id:entry,width:dims.width,height:dims.height}:null;
    }
    return entry?{id:entry.id,width:entry.width,height:entry.height}:null;
  }
  export function plan(opts: ComposeOptions, interpretation: InterpretationResult, catalog:readonly CatalogAsset[]=CATALOG): Scene {
    if(!interpretation?.selectedObjects?.length)throw Error('AI-провайдер не выбрал объекты. Повторите запрос.');
    if(!(['cluster','offset','headline'] as string[]).includes(opts.layout))throw Error('Недопустимый шаблон композиции.');
    const format=FORMATS[opts.format];
    if(!format)throw Error('Недопустимый формат композиции.');
    const {width,height}=format,seen=new Set<string>();
    const objects=interpretation.selectedObjects.filter(p=>{
      if(!catalog.some(a=>a.id===p.id))throw Error('Интерпретация содержит неизвестный asset ID: '+p.id);
      if(p.role!=='main'&&p.role!=='background')throw Error('Недопустимая роль объекта: '+p.role);
      if(p.role==='background'&&!opts.background)throw Error('Фоновые объекты отключены. Повторите запрос.');
      if(seen.has(p.id))return false;seen.add(p.id);return true;
    }).map(p=>{
      const d=source(p.id,opts.size,p.role,catalog);
      if(!d)throw Error(`В активной библиотеке нет варианта ${p.id} / ${opts.size} / ${p.role}. Выберите существующую детализацию и роль.`);
      if(!Number.isFinite(d.width)||!Number.isFinite(d.height)||d.width<=0||d.height<=0)throw Error('Некорректные габариты объекта '+p.id+'.');
      return {...p,width:d.width,height:d.height};
    });
    // Geometry determines packing order; the provider's array order has no effect.
    objects.sort((a,b)=>(a.role==='background'?1:0)-(b.role==='background'?1:0)||b.width*b.height-a.width*a.height||a.id.localeCompare(b.id));
    const region=opts.layout==='headline'
      ?{x:width*.38,y:height*.14,width:width*.56,height:height*.72}
      :{x:width*.06,y:height*.10,width:width*.88,height:height*.80};
    const packed=packObjects(objects,region.width,region.height,opts.seed);
    // Fit the whole group once. No per-object resizing, clipping or deformation.
    const scale=Math.min(region.width/packed.width,region.height/packed.height);
    const originX=region.x+(region.width-packed.width*scale)/2;
    const originY=region.y+(region.height-packed.height*scale)/2;
    const anchor=packed.rects[0];
    const anchorOnRight=anchor.x+anchor.width/2>packed.x+packed.width/2;
    const mirror=opts.layout==='offset'?!anchorOnRight:anchorOnRight;
    const items=packed.rects.map(r=>{
      const object=objects[r.index];
      const localX=mirror?packed.width-(r.x-packed.x)-r.width:r.x-packed.x;
      return {id:object.id,role:object.role,x:originX+localX*scale,y:originY+(r.y-packed.y)*scale,scale,rotation:0,z:object.role==='background'?r.index-objects.length:r.index};
    });
    items.sort((a,b)=>a.z-b.z);
    return {width,height,size:opts.size,palette:opts.palette,layout:opts.layout,seed:opts.seed,background:opts.background,items};
  }
  type PackedRect={x:number;y:number;width:number;height:number;index:number};
  type PackedGroup={x:number;y:number;width:number;height:number;rects:PackedRect[];score:number};
  function packObjects(objects:{width:number;height:number}[],width:number,height:number,seed:number):PackedGroup {
    const random=mulberry32(seed);
    const area=objects.reduce((sum,d)=>sum+d.width*d.height,0),unit=Math.sqrt(area),gap=unit*.022;
    const first:PackedRect={x:0,y:0,width:objects[0].width,height:objects[0].height,index:0};
    let groups:PackedGroup[]=[{...first,rects:[first],score:0}];
    // ponytail: bounded rectangle search for small illustration libraries;
    // retain 16 candidates instead of introducing a general layout solver.
    for(let index=1;index<objects.length;index++){
      const d=objects[index],candidates:PackedGroup[]=[],signatures=new Set<string>();
      for(const group of groups){
        const points:{x:number;y:number}[]=[];
        for(const r of group.rects){
          for(const align of [0,.35+random()*.3,1]){
            const y=r.y+(r.height-d.height)*align,x=r.x+(r.width-d.width)*align;
            points.push({x:r.x+r.width+gap,y},{x:r.x-d.width-gap,y},
              {x,y:r.y+r.height+gap},{x,y:r.y-d.height-gap});
          }
        }
        for(const point of points){
          if(group.rects.some(r=>point.x<r.x+r.width+gap*.95&&point.x+d.width+gap*.95>r.x&&point.y<r.y+r.height+gap*.95&&point.y+d.height+gap*.95>r.y))continue;
          const rect={...point,width:d.width,height:d.height,index};
          const x=Math.min(group.x,rect.x),y=Math.min(group.y,rect.y);
          const w=Math.max(group.x+group.width,rect.x+rect.width)-x;
          const h=Math.max(group.y+group.height,rect.y+rect.height)-y;
          const rects=[...group.rects,rect];
          const signature=rects.map(r=>`${Math.round(r.x-x)},${Math.round(r.y-y)}`).join(';');
          if(signatures.has(signature))continue;signatures.add(signature);
          const fit=Math.max(w/width,h/height);
          const anchor=group.rects[0];
          const dx=Math.max(anchor.x-rect.x-rect.width,rect.x-anchor.x-anchor.width,0);
          const dy=Math.max(anchor.y-rect.y-rect.height,rect.y-anchor.y-anchor.height,0);
          // Compactness keeps accessories connected to the group, with a mild
          // preference for placing small objects near the largest main object.
          const accessory=Math.max(0,1-d.width*d.height/(anchor.width*anchor.height));
          const above=Math.max(0,anchor.y+anchor.height*.65-rect.y-rect.height/2);
          const score=fit*(1+.07*w*h/area+.09*Math.hypot(dx,dy)/unit+.32*accessory*above/unit+.012*random());
          candidates.push({x,y,width:w,height:h,rects,score});
        }
      }
      candidates.sort((a,b)=>a.score-b.score);
      groups=candidates.slice(0,16);
      if(!groups.length)throw Error('Не удалось расположить объекты. Повторите запрос.');
    }
    return groups[0];
  }
  function mulberry32(seed:number):()=>number {let a=seed>>>0;return ()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
  export function isHex(s:string):boolean{return /^#[\da-fA-F]{6}$/.test(s);}
  export function validatePalette(raw:unknown):Palette {
    if(!raw||typeof raw!=='object')throw Error('Палитра должна быть JSON-объектом');
    const p=raw as Record<string,unknown>;
    const background=p.backgroundColors??p.background,objects=p.objectColors??p.objects;
    if(!Array.isArray(background)||!Array.isArray(objects)||!background.length||!objects.length||background.length>32||objects.length>32)throw Error('Нужен хотя бы один и не более 32 цветов каждой роли.');
    if(!background.every(x=>typeof x==='string'&&isHex(x))||!objects.every(x=>typeof x==='string'&&isHex(x)))throw Error('Неверный HEX: ожидается формат #RRGGBB');
    const sourceColorMapping:Record<string,string>={};
    if(p.sourceColorMapping!==undefined) {
      if(!p.sourceColorMapping||typeof p.sourceColorMapping!=='object'||Array.isArray(p.sourceColorMapping))throw Error('sourceColorMapping должен быть объектом.');
      for(const [source,target] of Object.entries(p.sourceColorMapping as Record<string,unknown>)) {
        if(!isHex(source)||typeof target!=='string'||(!/^(background|objects)\.\d+$/.test(target)&&!isHex(target)))throw Error('Проверьте sourceColorMapping: ключи и HEX должны быть #RRGGBB, слоты — background.N или objects.N.');
        const slot=/^(background|objects)\.(\d+)$/.exec(target);
        if(slot&&Number(slot[2])>=(slot[1]==='background'?background.length:objects.length))throw Error('sourceColorMapping указывает на отсутствующий цветовой слот.');
        sourceColorMapping[source.toUpperCase()]=target;
      }
    }
    return {name:typeof p.name==='string'?p.name:'Custom',background:(background as string[]).map(x=>x.toUpperCase()),objects:(objects as string[]).map(x=>x.toUpperCase()),sourceColorMapping,builtin:false};
  }
  export function paletteByKey(k:string,custom:Palette|null):Palette {
    if(k==='custom'){if(!custom)throw Error('Пользовательская палитра не загружена');return custom;}
    if(!(k in PALETTES))throw Error('Неизвестная палитра '+k);
    return { name: PALETTES[k as keyof typeof PALETTES].name, background: [...PALETTES[k as keyof typeof PALETTES].background], objects: [...PALETTES[k as keyof typeof PALETTES].objects], builtin:true };
  }
  function rgb(hex:string):number[]{return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));}
  export function mapColor(sourceHex:string, role:Role, target:Palette):string {
    return mapColorResult(sourceHex,role,target).color;
  }
  export function mapColorResult(sourceHex:string, role:Role, target:Palette):{color:string;mapped:boolean;restricted:boolean} {
    const srcHex=sourceHex.toUpperCase();
    const slot=target.sourceColorMapping?.[srcHex];
    if(slot) {
      const match=/^(background|objects)\.(\d+)$/.exec(slot);
      if(match) {
        const group=match[1] as 'background'|'objects',index=Number(match[2]);
        if(role==='background'&&group==='objects')return {color:srcHex,mapped:false,restricted:true};
        const list=group==='background'?target.background:target.objects;
        return list[index]?{color:list[index].toUpperCase(),mapped:true,restricted:false}:{color:srcHex,mapped:false,restricted:false};
      }
      const direct=slot.toUpperCase();
      if(role==='background'&&!target.background.includes(direct))return {color:srcHex,mapped:false,restricted:true};
      if(role==='main'&&!target.background.includes(direct)&&!target.objects.includes(direct))return {color:srcHex,mapped:false,restricted:true};
      return {color:direct,mapped:true,restricted:false};
    }
    if(!target.builtin) {
      const allowed=role==='background'?target.background:[...target.background,...target.objects];
      return allowed.some(x=>x.toUpperCase()===srcHex)?{color:srcHex,mapped:true,restricted:false}:{color:srcHex,mapped:false,restricted:false};
    }
    const base=PALETTES.lilac;
    const allowed=role==='background'?base.background:[...base.background,...base.objects];
    const to=role==='background'?target.background:[...target.background,...target.objects];
    const src=rgb(sourceHex),diff=(a:string)=>rgb(a).reduce((sum,x,i)=>sum+(src[i]-x)**2,0);
    let nearest=0,best=Infinity;
    allowed.forEach((v,i)=>{const d=diff(v);if(d<best){nearest=i;best=d;}});
    return {color:to[nearest].toUpperCase(),mapped:true,restricted:false};
  }
}
