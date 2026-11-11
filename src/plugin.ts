/// <reference path="engine.ts" />
/// <reference path="llm.ts" />
declare const figma: any;
declare const __html__: string;
declare const __uiFiles__: Record<string,string>;

// Figma is the source of truth for native vectors; bundled SVGs install the base library once per document.
// Compositions clone imported vectors and never author new paths.
const bundledFiles:Record<string,string>=typeof __uiFiles__==='undefined'?{}:__uiFiles__;
figma.showUI(bundledFiles['ui.html']||__html__, {width: 486, height: 740, themeColors: true});
const Core = VectorComposerCore;
const AI = VectorComposerAI;
let available = new Map<string, any>();
type LibraryAsset = {id:string;semanticId:string;name:string;sourceNodeId:string;libraryId:string;size:VectorComposerCore.Size;role:VectorComposerCore.Role;tags:string[];synonyms:string[];width:number;height:number;vectorOnly:boolean};
type UserLibrary = {id:string;name:string};
type ProjectCatalog = {libraries:UserLibrary[];assets:LibraryAsset[];activeLibraryId:string};
type SavedPalette = {id:string;name:string;backgroundColors:string[];objectColors:string[];sourceColorMapping?:Record<string,string>};
const BASE_LIBRARY={id:'base',name:'Базовая библиотека'};
const STORAGE={
  migrationNamespace:'vector_composer',
  document:{catalog:'vc.catalog',asset:'vc.asset',output:'vc.output',lastOutput:'vc.lastOutput',baseSourceId:'vc.baseSourceId',semantic:'vc.semantic',role:'vc.role',source:'vc.source',size:'vc.size',scale:'vc.scale',originalFills:'vc.originalFills',originalStrokes:'vc.originalStrokes',originalBackground:'vc.originalBackground'},
  legacy:{catalog:'project-catalog',asset:'asset',output:'output',lastOutput:'last-output',baseSourceId:'demo-source-id',semantic:'vc-semantic',role:'vc-role',source:'vc-source',size:'vc-size',scale:'vc-scale',originalFills:'vc-original-fills',originalStrokes:'vc-original-strokes',originalBackground:'vc-original-background'},
  settings:{aiProfiles:'vc-ai-profiles',aiActive:'vc-ai-active',palettes:'vc-palettes',paletteActive:'vc-palette-active'}
} as const;
type StorageContext={module:string;operation:string;code:string;message:string;context:Record<string,string>};
class PluginOperationError extends Error {
  readonly diagnostic:StorageContext;
  constructor(diagnostic:StorageContext,cause:unknown){super(diagnostic.message);this.name='PluginOperationError';this.diagnostic=diagnostic;(this as any).cause=cause;}
}
let projectCatalog:ProjectCatalog={libraries:[BASE_LIBRARY],assets:[],activeLibraryId:BASE_LIBRARY.id};
let savedPalettes:SavedPalette[]=[];
let activePaletteId='lilac';
let currentFrame: any = null;
let currentScene: VectorComposerCore.Scene | null = null;
let selectedPalette: VectorComposerCore.Palette = Core.PALETTES.lilac as unknown as VectorComposerCore.Palette;
let initialized = false;
let savedAIProfiles: VectorComposerAI.Profile[] = [];
let activeAIProfileId = 'gemini';
const sessionKeys = new Map<string,string>();
let storageReadWarningShown=false;
let settingsReadWarningShown=false;
let currentRequestId:string|undefined;

function post(type: string, payload: Record<string,unknown> = {}): void {try{figma.ui.postMessage({type,...(currentRequestId?{requestId:currentRequestId}:{}),...payload});}catch{}}
function storageFailure(operation:string,key:string,node:any,error:unknown):PluginOperationError {
  const message=operation==='read'?'Не удалось прочитать сохранённые данные. Проверьте доступность документа и повторите попытку.':'Не удалось сохранить данные библиотеки. Проверьте доступность документа и повторите попытку.';
  return new PluginOperationError({module:'storage',operation,code:`STORAGE_${operation.toUpperCase()}_FAILED`,message,context:{key,nodeType:String(node?.type||'unknown')}},error);
}
function redactDiagnostic(value:unknown):string {
  let result=value instanceof Error?`${value.name}: ${value.message}${value.stack?`\n${value.stack}`:''}`:String(value);
  for(const key of sessionKeys.values())if(key)result=result.split(key).join('[REDACTED]');
  return result;
}
function report(err: unknown, operation='plugin'): void {
  const diagnostic=err instanceof PluginOperationError?err.diagnostic:null;
  const technical=diagnostic?(err as any).cause:err;
  const raw=err instanceof Error?err.message:String(err);
  const apiFailure=/namespace can only consist|in (?:set|get)(?:Shared)?PluginData|clientStorage|plugin id|pluginid/i.test(raw);
  const generic={
    'svg-import':'Не удалось импортировать SVG. Проверьте файл и доступность документа.',
    'figma-import-selection':'Не удалось импортировать выделенные объекты. Проверьте, что выбран векторный объект.',
    'compose':'Не удалось создать композицию. Проверьте библиотеку и повторите попытку.',
    'export':'Не удалось экспортировать SVG композиции.',
    'export-library':'Не удалось экспортировать SVG библиотеки.',
    'palette':'Не удалось применить палитру к композиции.',
    'palette-save':'Не удалось сохранить палитру.',
    'library-create':'Не удалось создать библиотеку.',
    'library-select':'Не удалось переключить библиотеку.',
    'library-delete':'Не удалось удалить библиотеку.'
  } as Record<string,string>;
  const message=diagnostic?.message||(apiFailure?(generic[operation]||'Не удалось выполнить операцию Figma. Проверьте документ и повторите попытку.'):raw);
  const code=diagnostic?.code||(apiFailure?'FIGMA_API_ERROR':'PLUGIN_OPERATION_FAILED');
  const module=diagnostic?.module||(operation.startsWith('ai-')?'llm':operation.startsWith('palette')?'palette':operation.startsWith('library')||operation.includes('import')?'library':'plugin');
  const detail={code,module,operation,context:diagnostic?.context||{command:operation},technicalReason:redactDiagnostic(technical)};
  try{console.error('[Vector Composer diagnostic]',detail);}catch{}
  post('error',{code,module,operation,message});
  try{figma.notify(message,{error:true,timeout:6000});}catch{}
}
function readDocumentData(node:any,key:string,legacyKey?:string):string {
  try{
    const value=figma.pluginId?node.getPluginData(key):node.getSharedPluginData(STORAGE.migrationNamespace,key);
    if(value)return value;
  }
  catch(error){
    if(!storageReadWarningShown){storageReadWarningShown=true;const e=storageFailure('read',key,node,error);report(e,'storage-read');}
  }
  try {
    const legacy=node.getSharedPluginData(STORAGE.migrationNamespace,legacyKey||key);
    if(legacy){try{writeDocumentData(node,key,legacy);}catch(error){if(!storageReadWarningShown){storageReadWarningShown=true;report(error,'storage-write');}}return legacy;}
  }catch{/* Legacy data is optional; the previous invalid namespace could never persist in Figma. */}
  return '';
}
function writeDocumentData(node:any,key:string,value:string):void {
  if(typeof key!=='string'||!key||!/^[A-Za-z0-9_.-]+$/.test(key))throw new PluginOperationError({module:'storage',operation:'validate-key',code:'DOCUMENT_DATA_KEY_INVALID',message:'Не удалось сохранить данные библиотеки. Проверьте настройки плагина и повторите попытку.',context:{key:String(key)}},'Invalid Figma plugin data key');
  const storageScope=figma.pluginId||STORAGE.migrationNamespace;
  const byteLength=typeof value==='string'&&typeof TextEncoder!=='undefined'?new TextEncoder().encode(`${storageScope}${key}${value}`).length:key.length+String(value).length+storageScope.length;
  if(typeof value!=='string'||byteLength>100_000)throw new PluginOperationError({module:'storage',operation:'validate-value',code:'DOCUMENT_DATA_VALUE_TOO_LARGE',message:'Данные библиотеки слишком велики для сохранения в документе.',context:{key,nodeType:String(node?.type||'unknown')}},'Figma document plugin data entries are limited to 100 kB');
  try{if(figma.pluginId)node.setPluginData(key,value);else node.setSharedPluginData(STORAGE.migrationNamespace,key,value);}
  catch(error){throw storageFailure('write',key,node,error);}
}
async function persistSetting(key:string,value:unknown):Promise<boolean> {
  try{await figma.clientStorage.setAsync(key,value);return true;}
  catch(error){
    if(/cannot access client storage without a plugin id/i.test(String(error)))return false;
    throw new PluginOperationError({module:'storage',operation:'clientStorage.setAsync',code:'CLIENT_STORAGE_WRITE_FAILED',message:'Не удалось сохранить настройки плагина. Настройки применены только до закрытия окна.',context:{key}},error);
  }
}
function allAIProfiles():VectorComposerAI.Profile[] {
  return AI.PRESETS.map(p=>savedAIProfiles.find(x=>x.id===p.id)||p).concat(savedAIProfiles.filter(x=>!AI.PRESETS.some(p=>p.id===x.id)));
}
function postAISettings():void {post('ai-settings',{profiles:allAIProfiles(),activeId:activeAIProfileId,hasKeyIds:[...sessionKeys.keys()]});}
function reportSettingsReadFailure(key:string,error:unknown):void {
  if(settingsReadWarningShown)return;settingsReadWarningShown=true;
  const message='Не удалось загрузить сохранённые настройки. Плагин продолжит работу с настройками этого сеанса.';
  report(new PluginOperationError({module:'storage',operation:'clientStorage.getAsync',code:'CLIENT_STORAGE_READ_FAILED',message,context:{key}},error),'storage-read');
}
async function initializeAI():Promise<void> {
  try {
    const profiles=await figma.clientStorage.getAsync(STORAGE.settings.aiProfiles);
    if(Array.isArray(profiles))savedAIProfiles=profiles.flatMap((x:any)=>{try{return [AI.validateProfile(x)];}catch{return[];}});
    const active=await figma.clientStorage.getAsync(STORAGE.settings.aiActive);
    if(typeof active==='string'&&allAIProfiles().some(p=>p.id===active))activeAIProfileId=active;
  }catch(error){reportSettingsReadFailure(STORAGE.settings.aiProfiles,error);}
  postAISettings();
}
function validCatalog(raw:any):ProjectCatalog {
  if(raw===null||raw===undefined)return {libraries:[BASE_LIBRARY],assets:[],activeLibraryId:BASE_LIBRARY.id};
  if(!raw||!Array.isArray(raw.libraries))throw new Error('Сохранённый список библиотек имеет неверный формат.');
  const libraries:ProjectCatalog['libraries']=[BASE_LIBRARY,...raw.libraries.flatMap((x:any)=>typeof x?.id==='string'&&typeof x?.name==='string'&&x.id!=='base'&&x.id!=='demo'?[{id:x.id,name:x.name}]:[])];
  const ids=new Set(libraries.map(x=>x.id));
  const activeLibraryId=raw.activeLibraryId==='demo'?BASE_LIBRARY.id:(ids.has(raw.activeLibraryId)?raw.activeLibraryId:BASE_LIBRARY.id);
  return {libraries,assets:[],activeLibraryId};
}
function persistCatalog(catalog:ProjectCatalog=projectCatalog):void {writeDocumentData(figma.root,STORAGE.document.catalog,JSON.stringify({libraries:catalog.libraries,activeLibraryId:catalog.activeLibraryId}));}
function userLibraryPage():any {
  let page=figma.root.children.find((p:any)=>p.name==='Vector Composer · Library');
  if(!page){page=figma.createPage();page.name='Vector Composer · Library';}
  return page;
}
function activeLibrary():UserLibrary|null {return projectCatalog.libraries.find(x=>x.id===projectCatalog.activeLibraryId)||null;}
function runtimeCatalog():VectorComposerCore.CatalogAsset[] {
  if(projectCatalog.activeLibraryId===BASE_LIBRARY.id)return Core.CATALOG.map(a=>({id:a.id,name:a.name,tags:[...a.tags],sources:{L:{main:{id:a.sources.L.main,...a.dims.L.main},background:{id:a.sources.L.background,...a.dims.L.background}},S:{main:{id:a.sources.S.main,...a.dims.S.main},background:{id:a.sources.S.background,...a.dims.S.background}}}}));
  type MutableCatalogAsset=Omit<VectorComposerCore.CatalogAsset,'tags'|'synonyms'>&{tags:string[];synonyms:string[]};
  const grouped=new Map<string,MutableCatalogAsset>();
  for(const a of projectCatalog.assets.filter(x=>x.libraryId===projectCatalog.activeLibraryId&&available.has(x.sourceNodeId))) {
    let entry=grouped.get(a.semanticId);
    if(!entry){entry={id:a.semanticId,name:a.name,tags:[...a.tags],synonyms:[...a.synonyms],sources:{}};grouped.set(a.semanticId,entry);}
    const byRole=entry.sources[a.size]||(entry.sources[a.size]={});
    byRole[a.role]={id:a.sourceNodeId,width:a.width,height:a.height};
    for(const tag of a.tags)if(!entry.tags.includes(tag))entry.tags.push(tag);
    for(const synonym of a.synonyms)if(!entry.synonyms!.includes(synonym))entry.synonyms!.push(synonym);
  }
  return [...grouped.values()];
}
function userPalette(raw:SavedPalette):VectorComposerCore.Palette {
  return Core.validatePalette({name:raw.name,backgroundColors:raw.backgroundColors,objectColors:raw.objectColors,sourceColorMapping:raw.sourceColorMapping});
}
function resolvePalette(id:string):VectorComposerCore.Palette {
  if(id==='lilac'||id==='peach'||id==='mint')return Core.paletteByKey(id,null);
  const saved=savedPalettes.find(x=>x.id===id);
  if(!saved)throw Error('Цветовая палитра не найдена. Выберите её во вкладке «Палитры».');
  return userPalette(saved);
}
function postLibraryState():void {
  post('library-state',{libraries:projectCatalog.libraries,assets:projectCatalog.assets,activeId:projectCatalog.activeLibraryId});
  postPaletteContext();
}
function postPaletteState():void {post('palette-state',{palettes:[...Object.entries(Core.PALETTES).map(([id,p])=>({id,name:p.name,backgroundColors:p.background,objectColors:p.objects})),...savedPalettes],activeId:activePaletteId});}
function postPaletteContext():void {
  const colors=new Map<string,Set<string>>();
  for(const asset of runtimeCatalog())for(const size of ['L','S'] as const)for(const role of ['main','background'] as const) {
    const source=asset.sources[size]?.[role];if(!source)continue;const id=typeof source==='string'?source:source.id,root=available.get(id);if(!root)continue;
    const nodes=[root,...(typeof root.findAll==='function'?root.findAll(()=>true):[])];
    for(const node of nodes)for(const kind of ['fills','strokes'] as const)for(const paint of safePaints(node,kind)||[]) {
      const list=paint.type==='SOLID'&&paint.color?[rgbHex(paint.color)]:paint.type?.startsWith('GRADIENT_')&&Array.isArray(paint.gradientStops)?paint.gradientStops.map((s:any)=>rgbHex(s.color)):[];
      for(const hex of list){if(!colors.has(hex))colors.set(hex,new Set());colors.get(hex)!.add(role);}
    }
  }
  post('palette-context',{colors:[...colors].map(([hex,roles])=>({hex,roles:[...roles]}))});
}
async function initializeLibrary():Promise<void> {
  const raw=readDocumentData(figma.root,STORAGE.document.catalog,STORAGE.legacy.catalog);
  let catalogNeedsWrite=!raw;
  if(raw)try{projectCatalog=validCatalog(JSON.parse(raw));catalogNeedsWrite=true;}catch(error){
    report(new PluginOperationError({module:'storage',operation:'catalog.parse',code:'CATALOG_DATA_INVALID',message:'Не удалось восстановить каталог библиотек. Исходные узлы оставлены в документе; проверьте сохранённые данные.',context:{key:STORAGE.document.catalog}},error),'storage-read');
  }else projectCatalog=validCatalog(null);
  await figma.loadAllPagesAsync();
  const valid:LibraryAsset[]=[];let invalidAssetCount=0;available.clear();
  const page=figma.root.children.find((p:any)=>p.name==='Vector Composer · Library');
  const nodes=page?[page,...(typeof page.findAll==='function'?page.findAll(()=>true):[])]:[];
  for(const node of nodes){
    try {
      const raw=readDocumentData(node,STORAGE.document.asset,STORAGE.legacy.asset);if(!raw)continue;
      const x=JSON.parse(raw);if(!x||typeof x.id!=='string'||typeof x.semanticId!=='string'||!projectCatalog.libraries.some(l=>l.id===x.libraryId)||!['L','S'].includes(x.size)||!['main','background'].includes(x.role)){invalidAssetCount++;continue;}
      if(isUsableSourceNode(node)&&isVectorOnly(node)){const asset={...x,sourceNodeId:node.id,width:node.width,height:node.height,vectorOnly:true} as LibraryAsset;valid.push(asset);available.set(asset.sourceNodeId,node);}
    }catch(error){invalidAssetCount++;try{console.error('[Vector Composer diagnostic]',{code:'ASSET_METADATA_INVALID',module:'library',operation:'read-asset-metadata',context:{nodeId:String(node.id)},technicalReason:redactDiagnostic(error)});}catch{}}
  }
  projectCatalog.assets=valid;
  if(invalidAssetCount)report(new PluginOperationError({module:'library',operation:'read-asset-metadata',code:'ASSET_METADATA_INVALID',message:`Обнаружено ${invalidAssetCount} повреждённых или устаревших записей компонентов. Эти узлы не включены в генерацию.`,context:{count:String(invalidAssetCount)}},'Invalid or stale asset metadata'),'startup');
  if(!projectCatalog.libraries.some(x=>x.id===projectCatalog.activeLibraryId))projectCatalog.activeLibraryId=BASE_LIBRARY.id;
  if(catalogNeedsWrite)try{persistCatalog();}catch(error){report(error,'storage-write');}
  postLibraryState();
  await restoreLastOutput();
  await scan();
}
function profileFor(message:any):VectorComposerAI.Profile {
  return AI.validateProfile(message.profile||allAIProfiles().find(p=>p.id===activeAIProfileId)||AI.PRESETS[0]);
}
function acceptSessionKey(id:string,value:unknown):string {
  if(typeof value==='string'&&value.trim())sessionKeys.set(id,value.trim());
  return sessionKeys.get(id)||'';
}
async function saveAIProfile(profile:VectorComposerAI.Profile,key:unknown):Promise<void> {
  if(key!==undefined&&key!==null&&typeof key!=='string')throw Error('API-ключ должен быть текстом.');
  acceptSessionKey(profile.id,key);
  savedAIProfiles=savedAIProfiles.filter(p=>p.id!==profile.id).concat(profile);
  activeAIProfileId=profile.id;
  const profilesSaved=await persistSetting(STORAGE.settings.aiProfiles,savedAIProfiles);
  const activeSaved=await persistSetting(STORAGE.settings.aiActive,activeAIProfileId);
  postAISettings();post('ai-status',{profileId:profile.id,message:profilesSaved&&activeSaved?'Настройки сохранены. API-ключ действует до закрытия плагина.':'Настройки действуют до закрытия плагина: Figma не разрешила их сохранить.',state:profilesSaved&&activeSaved?'success':'warning'});
}
function assetsFor(size:VectorComposerCore.Size,background:boolean):VectorComposerCore.AvailableAsset[] {
  const catalog=runtimeCatalog();
  return catalog.map(a=>({id:a.id,name:a.name,tags:[...a.tags],synonyms:[...(a.synonyms||[])],roles:(['main','background'] as const).filter(role=>{
    const source=a.sources[size]?.[role];
    const sourceId=typeof source==='string'?source:source?.id;
    return (role==='main'||background)&&!!sourceId&&available.has(sourceId);
  })})).filter(a=>a.roles.length>0);
}
function hexRgb(hex: string): {r:number;g:number;b:number} {
  return {r:parseInt(hex.slice(1,3),16)/255,g:parseInt(hex.slice(3,5),16)/255,b:parseInt(hex.slice(5,7),16)/255};
}
function rgbHex(rgb: {r:number;g:number;b:number}): string {
  return '#'+[rgb.r,rgb.g,rgb.b].map(x=>Math.max(0,Math.min(255,Math.round(x*255))).toString(16).padStart(2,'0')).join('').toUpperCase();
}
function safePaints(n: any, prop: 'fills' | 'strokes'): any[] | null {
  try {return Array.isArray(n[prop])?n[prop]:null;} catch{return null;}
}
function isVectorOnly(root:any):boolean {
  const nodes=[root,...(typeof root.findAll==='function'?root.findAll(()=>true):[])];
  return !nodes.some(n=>n.type==='IMAGE'||n.type==='TEXT'||(['fills','strokes'] as const).some(k=>(safePaints(n,k)||[]).some((p:any)=>p.type==='IMAGE'||p.type==='VIDEO')));
}
const localNodeData=new WeakMap<object,Map<string,string>>();
const LEGACY_KEY_BY_DATA_KEY:Record<string,string>={
  [STORAGE.document.asset]:STORAGE.legacy.asset,[STORAGE.document.baseSourceId]:STORAGE.legacy.baseSourceId,
  [STORAGE.document.semantic]:STORAGE.legacy.semantic,[STORAGE.document.role]:STORAGE.legacy.role,[STORAGE.document.source]:STORAGE.legacy.source,
  [STORAGE.document.size]:STORAGE.legacy.size,[STORAGE.document.scale]:STORAGE.legacy.scale,
  [STORAGE.document.originalFills]:STORAGE.legacy.originalFills,[STORAGE.document.originalStrokes]:STORAGE.legacy.originalStrokes,
  [STORAGE.document.originalBackground]:STORAGE.legacy.originalBackground,[STORAGE.document.output]:STORAGE.legacy.output,[STORAGE.document.lastOutput]:STORAGE.legacy.lastOutput
};
function setLocalNodeData(node:any,key:string,value:string):void {
  let data=localNodeData.get(node);
  if(!data){data=new Map();localNodeData.set(node,data);}
  data.set(key,value);
  try{writeDocumentData(node,key,value);}catch(error){data.delete(key);throw error;}
}
function getLocalNodeData(node:any,key:string):string {
  const local=localNodeData.get(node)?.get(key);if(local)return local;
  return readDocumentData(node,key,LEGACY_KEY_BY_DATA_KEY[key]);
}
type RecolorStats={unmapped:number;restricted:number;unsupported:number;failed:number};
function mapPaint(p:any,role:VectorComposerCore.Role,palette:VectorComposerCore.Palette,stats:RecolorStats):any {
  if(p.type==='SOLID' && p.color) {
    const result=Core.mapColorResult(rgbHex(p.color),role,palette);
    if(result.restricted)stats.restricted++;else if(!result.mapped)stats.unmapped++;
    return result.mapped?{...p,color:hexRgb(result.color)}:p;
  }
  if(p.type && p.type.startsWith('GRADIENT_') && Array.isArray(p.gradientStops)) {
    return {...p,gradientStops:p.gradientStops.map((stop:any)=>{const result=Core.mapColorResult(rgbHex(stop.color),role,palette);if(result.restricted)stats.restricted++;else if(!result.mapped)stats.unmapped++;return result.mapped?{...stop,color:{...stop.color,...hexRgb(result.color)}}:stop;})};
  }
  if(p.type)stats.unsupported++;
  return p; // Advanced paints stay unmodified, never rasterized.
}
function recolorBranch(root:any,role:VectorComposerCore.Role,palette:VectorComposerCore.Palette,stats:RecolorStats={unmapped:0,restricted:0,unsupported:0,failed:0}):RecolorStats {
  const nodes=[root,...(typeof root.findAll==='function'?root.findAll(()=>true):[])];
  for(const node of nodes) for(const kind of ['fills','strokes'] as const) {
    if(!(kind in node))continue;
    const original=safePaints(node,kind);
    if(!original){stats.failed++;continue;}
    const key=kind==='fills'?STORAGE.document.originalFills:STORAGE.document.originalStrokes;
      let raw=getLocalNodeData(node,key);
      if(!raw){raw=JSON.stringify(original);setLocalNodeData(node,key,raw);}
      let snapshot:any[];
      try{const parsed=JSON.parse(raw);if(!Array.isArray(parsed))throw new Error('Color snapshot is not an array');snapshot=parsed;}
      catch(error){throw new PluginOperationError({module:'palette',operation:'read-color-snapshot',code:'COLOR_SNAPSHOT_INVALID',message:'Не удалось прочитать исходные цвета объекта. Палитра не применена полностью.',context:{nodeId:String(node.id),property:kind}},error);}
      try {
      node[kind]=snapshot.map((p:any)=>mapPaint(p,role,palette,stats));
    }catch(error){
      stats.failed++;
      try{console.error('[Vector Composer diagnostic]',{code:'RECOLOR_NODE_PROPERTY_FAILED',module:'palette',operation:'apply-color',context:{nodeId:String(node.id),property:kind},technicalReason:redactDiagnostic(error)});}catch{}
    }
  }
  return stats;
}
function sourceKey(id:string,size:VectorComposerCore.Size,role:VectorComposerCore.Role,catalog:VectorComposerCore.CatalogAsset[]=runtimeCatalog()):string {
  const entry=Core.source(id,size,role,catalog);
  if(!entry)throw Error('Неизвестный компонент '+id);
  return entry.id;
}
function isUsableSourceNode(node:any):boolean {
  return !!node && !node.removed && typeof node.clone==='function' && typeof node.rescale==='function' && typeof node.exportAsync==='function'
    && Number.isFinite(node.width) && node.width>0 && Number.isFinite(node.height) && node.height>0;
}
function bundledBaseSvg(size:VectorComposerCore.Size,role:VectorComposerCore.Role,id:string):string {
  const path=`assets/svg/${size}/${role}/${id}.svg`,svg=bundledFiles[path];
  if(typeof svg!=='string')throw Error(`В базовой библиотеке отсутствует SVG: ${path}`);
  return validateSvgInput(svg);
}
async function scan():Promise<void> {
  post('status',{message:'Обновляю активную библиотеку…'});
  await figma.loadAllPagesAsync();available.clear();
  if(projectCatalog.activeLibraryId===BASE_LIBRARY.id) {
    const previous=figma.currentPage;let page=figma.root.children.find((p:any)=>p.name==='Vector Composer · Library');let switched=false;
    const bundled=new Map<string,any>();
    if(page)for(const node of [page,...(typeof page.findAll==='function'?page.findAll(()=>true):[])]){const id=getLocalNodeData(node,STORAGE.document.baseSourceId);if(id)bundled.set(id,node);}
    const failures:string[]=[];
    try {
      for(const a of Core.CATALOG)for(const size of ['L','S'] as const)for(const role of ['main','background'] as const) {
        const id=a.sources[size][role];let node=await figma.getNodeByIdAsync(id);
        if(!isUsableSourceNode(node)||!isVectorOnly(node))node=bundled.get(id);
        if(!isUsableSourceNode(node)||!isVectorOnly(node))try {
          if(!page){page=figma.createPage();page.name='Vector Composer · Library';}
          if(!switched){await figma.setCurrentPageAsync(page);switched=true;}
          node=figma.createNodeFromSvg(bundledBaseSvg(size,role,a.id));
          appendImportedNode(page,node,0);node.name=`Базовая · ${a.name} · ${size} · ${role}`;setLocalNodeData(node,STORAGE.document.baseSourceId,id);
        } catch(error) {failures.push(`${a.id}/${size}/${role}: ${error instanceof Error?error.message:String(error)}`);node=null;}
        if(isUsableSourceNode(node)&&isVectorOnly(node))available.set(id,node);
      }
    } finally {if(switched&&previous)await figma.setCurrentPageAsync(previous);}
    if(failures.length)post('status',{message:`Базовая библиотека загружена частично: ${available.size}/40 вариантов. Не удалось подключить ${failures.length}; проверьте SVG или документ.`});
    else if(available.size!==40)post('status',{message:`Базовая библиотека доступна частично: ${available.size}/40 векторных вариантов.`});
    else post('status',{message:'Базовая библиотека готова: 40/40 векторных вариантов.'});
  } else if(activeLibrary()) {
    const old=projectCatalog.assets.filter(x=>x.libraryId===projectCatalog.activeLibraryId),valid:LibraryAsset[]=[];
    for(const asset of old) {
      const node=await figma.getNodeByIdAsync(asset.sourceNodeId);
      if(isUsableSourceNode(node)&&isVectorOnly(node)){available.set(asset.sourceNodeId,node);valid.push({...asset,width:node.width,height:node.height});}
    }
    if(valid.length!==old.length){projectCatalog.assets=projectCatalog.assets.filter(x=>x.libraryId!==projectCatalog.activeLibraryId).concat(valid);persistCatalog();}
  }
  initialized=true;
  const catalog=runtimeCatalog();
  const total=catalog.reduce((n,a)=>n+Object.values(a.sources).reduce((m,v)=>m+Object.keys(v||{}).length,0),0);
  post('scan-result',{count:available.size,total,missing:0,items:catalog.map(a=>({id:a.id,name:a.name,L:!!a.sources.L,S:!!a.sources.S}))});
  postLibraryState();
  if(projectCatalog.activeLibraryId!==BASE_LIBRARY.id)post('status',{message:`Найдено ${available.size} векторных вариантов в активной библиотеке.`});
}
async function outputPage():Promise<any> {
  let page=figma.root.children.find((p:any)=>p.name==='Vector Composer · Outputs');
  if(!page){page=figma.createPage();page.name='Vector Composer · Outputs';}
  await figma.setCurrentPageAsync(page);
  return page;
}
function confirmReady(scene:VectorComposerCore.Scene):void {
  const missing=scene.items.filter(item=>!available.has(sourceKey(item.id,scene.size,item.role)));
  if(missing.length)throw Error('В файле отсутствуют исходные векторы: '+missing.map(x=>x.id+'/'+x.role+'/'+scene.size).join(', '));
}
function buildClone(item:VectorComposerCore.SceneItem,size:VectorComposerCore.Size,palette:VectorComposerCore.Palette,parent:any):any {
  const id=sourceKey(item.id,size,item.role);const src=available.get(id);
  if(!src||typeof src.clone!=='function')throw Error('Оригинал не найден: '+id);
  const clone=src.clone();
  try{
    // Reparent before assigning local coordinates: Figma may preserve global
    // coordinates when a node is moved between parents/pages.
    parent.appendChild(clone);
    clone.name=`${runtimeCatalog().find(x=>x.id===item.id)?.name||item.id} · ${item.role==='main'?'цветной':'фоновый'} · ${size}`;
    setLocalNodeData(clone,STORAGE.document.semantic,item.id);
    setLocalNodeData(clone,STORAGE.document.role,item.role);
    setLocalNodeData(clone,STORAGE.document.source,id);
    setLocalNodeData(clone,STORAGE.document.size,size);
    setLocalNodeData(clone,STORAGE.document.scale,String(item.scale));
    clone.rescale(item.scale); // Uniform scale on the entire original subtree.
    clone.x=item.x;clone.y=item.y;
    clone.rotation=item.rotation;
    recolorBranch(clone,item.role,palette);
    return clone;
  }catch(error){try{clone.remove();}catch{}throw error;}
}
async function compose(options:VectorComposerCore.ComposeOptions,custom:VectorComposerCore.Palette|null,profileInput:unknown,keyValue:unknown):Promise<void> {
  if(!projectCatalog.activeLibraryId)throw Error('Выберите библиотеку во вкладке «Создать» или «Библиотеки».');
  if(!initialized)await scan();
  const catalog=runtimeCatalog();
  if(!catalog.length)throw Error('В активной библиотеке нет доступных компонентов. Импортируйте SVG или выберите другую библиотеку.');
  const profile=AI.validateProfile(profileInput||allAIProfiles().find(p=>p.id===activeAIProfileId)||AI.PRESETS[0]);
  const key=acceptSessionKey(profile.id,keyValue);const provider=AI.createProvider(profile,key);
  const interpretation=await provider.interpret(options.prompt,assetsFor(options.size,options.background),{mode:options.mode,background:options.background});
  const scene=Core.plan(options,interpretation,catalog);confirmReady(scene);
  const previousPalette=selectedPalette;
  selectedPalette=options.palette==='custom'?Core.validatePalette(custom):resolvePalette(options.palette);
  await outputPage();
  // Count only existing output frames before createFrame attaches the new one.
  const index=figma.currentPage.children.filter((n:any)=>n.type==='FRAME'&&typeof n.name==='string'&&n.name.startsWith('VC · ')).length;
  const frame=figma.createFrame();
  const previousFrame=currentFrame,previousScene=currentScene;
  try {
    frame.name=`VC · ${options.prompt.trim().slice(0,45)} · ${scene.size} · ${options.format}`;
    frame.resize(scene.width,scene.height);frame.clipsContent=true;
    frame.fills=[{type:'SOLID',color:hexRgb(selectedPalette.background[0])}];
    setLocalNodeData(frame,STORAGE.document.originalBackground,selectedPalette.background[0]);
    // Fixed cells keep frames of different formats from overlapping.
    const formats=Object.values(Core.FORMATS);
    const cellWidth=Math.max(...formats.map(f=>f.width))+120;
    const cellHeight=Math.max(...formats.map(f=>f.height))+120;
    frame.x=(index%3)*cellWidth;
    frame.y=Math.floor(index/3)*cellHeight;
    for(const item of scene.items)buildClone(item,scene.size,selectedPalette,frame);
    if(frame.children.length!==scene.items.length)throw Error(`Композиция собрана не полностью: ${frame.children.length}/${scene.items.length} объектов.`);
    currentFrame=frame;currentScene=scene;persistOutputState();
  } catch(error) {
    try {frame.remove();} catch {}
    currentFrame=previousFrame;currentScene=previousScene;selectedPalette=previousPalette;
    throw error;
  }
  figma.currentPage.selection=[frame];figma.viewport.scrollAndZoomIntoView([frame]);
  post('composed',{frameId:frame.id,items:scene.items.map(item=>({id:item.id,role:item.role,name:catalog.find(x=>x.id===item.id)?.name}))});
  post('status',{message:'Композиция создана в Figma. Все объекты — клоны оригиналов.'});
}
function assertFrame():void {if(!currentFrame||!currentScene||currentFrame.removed)throw Error('Сначала создайте композицию.');}
function validateVectorSvg(svg:unknown,label:string):asserts svg is string {
  if(typeof svg!=='string'||!/<svg\b/i.test(svg))throw Error(`Figma не вернула корректный SVG: ${label}`);
  if(/<(?:[\w.-]+:)?image\b/i.test(svg))throw Error(`Экспорт отклонён: SVG ${label} содержит <image> вместо векторной иллюстрации.`);
}
function listSceneItems():Array<{id:string;role:string;name:string}> {
  assertFrame();return currentFrame.children.filter((n:any)=>getLocalNodeData(n,STORAGE.document.semantic)).map((n:any)=>({id:getLocalNodeData(n,STORAGE.document.semantic),role:getLocalNodeData(n,STORAGE.document.role),name:n.name}));
}
function persistOutputState():void {
  if(!currentFrame||!currentScene)return;
  currentScene.items=currentFrame.children.filter((n:any)=>getLocalNodeData(n,STORAGE.document.semantic)).map((n:any,z:number)=>({id:getLocalNodeData(n,STORAGE.document.semantic),role:getLocalNodeData(n,STORAGE.document.role) as VectorComposerCore.Role,x:n.x,y:n.y,scale:Number(getLocalNodeData(n,STORAGE.document.scale))||1,rotation:n.rotation||0,z}));
  writeDocumentData(currentFrame,STORAGE.document.output,JSON.stringify(currentScene));
  writeDocumentData(figma.root,STORAGE.document.lastOutput,currentFrame.id);
}
async function restoreLastOutput():Promise<void> {
  try {
    const id=readDocumentData(figma.root,STORAGE.document.lastOutput,STORAGE.legacy.lastOutput);if(!id)return;
    const frame=await figma.getNodeByIdAsync(id);if(!frame||frame.removed||frame.type!=='FRAME')return;
    const raw=readDocumentData(frame,STORAGE.document.output,STORAGE.legacy.output);const saved=JSON.parse(raw);
    if(!['L','S'].includes(saved.size)||!Array.isArray(saved.items))return;
    const items=frame.children.filter((n:any)=>getLocalNodeData(n,STORAGE.document.semantic)).map((n:any,z:number)=>({id:getLocalNodeData(n,STORAGE.document.semantic),role:getLocalNodeData(n,STORAGE.document.role) as VectorComposerCore.Role,x:n.x,y:n.y,scale:Number(getLocalNodeData(n,STORAGE.document.scale))||1,rotation:n.rotation||0,z}));
    let paletteMissing=false;try{selectedPalette=resolvePalette(saved.palette);}catch{selectedPalette=resolvePalette(activePaletteId);paletteMissing=true;}
    currentFrame=frame;currentScene={...saved,width:frame.width,height:frame.height,items};
    post('composed',{frameId:frame.id,items:listSceneItems()});
    if(paletteMissing)post('status',{message:'Последняя композиция восстановлена, но её пользовательская палитра недоступна. Выберите доступную палитру перед следующим применением.'});
  }catch(error){
    report(new PluginOperationError({module:'storage',operation:'restore-output',code:'LAST_OUTPUT_RESTORE_FAILED',message:'Не удалось восстановить последнюю композицию. Фрейм остался в документе.',context:{key:STORAGE.document.lastOutput}},error),'startup');
  }
}
function recolor(palette:VectorComposerCore.Palette,paletteId:string):void {
  assertFrame();selectedPalette=palette;currentScene!.palette=paletteId;
  currentFrame.fills=[{type:'SOLID',color:hexRgb(palette.background[0])}];
  let stats:RecolorStats={unmapped:0,restricted:0,unsupported:0,failed:0};
  for(const child of currentFrame.children){const role=getLocalNodeData(child,STORAGE.document.role);if(role==='main'||role==='background')stats=recolorBranch(child,role,selectedPalette,stats);}
  persistOutputState();
  const notes:string[]=[];if(stats.unmapped)notes.push( `Исходных цветов без замены: ${stats.unmapped}. Настройте замену во вкладке «Палитры».`);if(stats.restricted)notes.push(`Отклонено цветовых замен: ${stats.restricted}. Эти цвета недоступны для выбранных вариантов.`);if(stats.unsupported)notes.push(`Заливок и обводок без поддержки перекраски: ${stats.unsupported}.`);if(stats.failed)notes.push(`Не удалось перекрасить заливки и обводки: ${stats.failed}.`);
  post('status',{message:notes.length?'Палитра применена к копиям. '+notes.join(' '):'Палитра применена к композиции.'});
}
function restoreOriginalColors():void {
  assertFrame();
  const bg=getLocalNodeData(currentFrame,STORAGE.document.originalBackground);
  if(!bg)throw new PluginOperationError({module:'palette',operation:'restore-colors',code:'COLOR_BACKGROUND_SNAPSHOT_MISSING',message:'Не найдены сохранённые исходные цвета композиции.',context:{frameId:String(currentFrame.id)}},'Missing original frame background');
  const snapshots:Array<{node:any;property:'fills'|'strokes';value:any[]}>=[];
  for(const child of currentFrame.children)for(const node of [child,...(typeof child.findAll==='function'?child.findAll(()=>true):[])])for(const kind of ['fills','strokes'] as const){
    if(!(kind in node))continue;
    const paints=safePaints(node,kind);if(!paints)continue;
    const key=kind==='fills'?STORAGE.document.originalFills:STORAGE.document.originalStrokes,raw=getLocalNodeData(node,key);
    if(!raw&&paints.length)throw new PluginOperationError({module:'palette',operation:'restore-colors',code:'COLOR_SNAPSHOT_MISSING',message:'Не удалось восстановить исходные цвета: у одного из объектов нет сохранённого снимка.',context:{frameId:String(currentFrame.id),nodeId:String(node.id),property:kind}},'Missing original color snapshot');
    if(!raw)continue;
    try{const value=JSON.parse(raw);if(!Array.isArray(value))throw new Error('Color snapshot is not an array');snapshots.push({node,property:kind,value});}
    catch(error){throw new PluginOperationError({module:'palette',operation:'restore-colors',code:'COLOR_SNAPSHOT_INVALID',message:'Не удалось восстановить исходные цвета: снимок одного из объектов повреждён.',context:{frameId:String(currentFrame.id),nodeId:String(node.id),property:kind}},error);}
  }
  currentFrame.fills=[{type:'SOLID',color:hexRgb(bg)}];
  for(const snapshot of snapshots)snapshot.node[snapshot.property]=snapshot.value;
  persistOutputState();
  post('status',{message:'Исходные цвета композиции восстановлены.'});
}
function addComponent(id:string,role:VectorComposerCore.Role='main'):void {
  assertFrame();const catalog=runtimeCatalog();const asset=catalog.find(a=>a.id===id);
  if(!asset)throw Error('Компонент отсутствует в активной библиотеке.');
  if(!Core.source(id,currentScene!.size,role,catalog))throw Error(`Вариант ${id} / ${currentScene!.size} / ${role} отсутствует. Масштабирование другой детализации не используется.`);
  const scale=currentScene!.items[0]?.scale||.5,d=Core.source(id,currentScene!.size,role,catalog)!;
  const item:VectorComposerCore.SceneItem={id,role,x:(currentScene!.width-d.width*scale)/2,y:(currentScene!.height-d.height*scale)/2,scale,rotation:0,z:currentScene!.items.length};
  buildClone(item,currentScene!.size,selectedPalette,currentFrame);currentScene!.items.push(item);post('role-changed',{items:listSceneItems()});
  persistOutputState();
  post('status',{message:`Объект «${asset.name}» добавлен в композицию.`});
}
function toggleRole(semanticId:string):void {
  assertFrame();
  const old=currentFrame.children.find((n:any)=>getLocalNodeData(n,STORAGE.document.semantic)===semanticId);
  if(!old)throw Error('Объект не найден в текущей композиции');
  const role:VectorComposerCore.Role=getLocalNodeData(old,STORAGE.document.role)==='main'?'background':'main';
  const idx=currentFrame.children.indexOf(old);const scale=Number(getLocalNodeData(old,STORAGE.document.scale))||1;
  const next=buildClone({id:semanticId,role,x:old.x,y:old.y,scale,rotation:old.rotation,z:idx},currentScene!.size,selectedPalette,currentFrame);
  currentFrame.insertChild(idx,next);old.remove();
  currentScene!.items=currentScene!.items.map(x=>x.id===semanticId?{...x,role}:x);
  persistOutputState();
  post('role-changed',{items:listSceneItems()});
}
function validateSvgInput(raw:unknown):string {
  if(typeof raw!=='string'||!raw.trim()||raw.length>2_000_000)throw Error('SVG пустой или превышает ограничение 2 МБ.');
  const svg=raw.trim();
  if(!/^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(svg)||!/<\/svg\s*>(?:<!--[\s\S]*?-->\s*)*$/i.test(svg))throw Error('Файл должен содержать один корректный корневой элемент <svg>.');
  const inspect=svg.replace(/&#(x[\da-f]{1,6}|\d{1,7});/gi,(_,value:string)=>{const n=value[0].toLowerCase()==='x'?parseInt(value.slice(1),16):parseInt(value,10);try{return n<=0x10FFFF?String.fromCodePoint(n):'';}catch{return'';}});
  if(/<!DOCTYPE|<!ENTITY|<\s*(script|image|foreignObject|iframe|object|embed|audio|video|link)\b/i.test(inspect))throw Error('Импорт отклонён: SVG содержит небезопасный или растровый элемент.');
  if(/\son[a-z0-9_-]+\s*=/i.test(inspect)||/javascript\s*:|@import|expression\s*\(/i.test(inspect))throw Error('Импорт отклонён: обработчики, скрипты и CSS-вызовы запрещены.');
  if(/\b(?:href|xlink:href)\s*=\s*(["'])(?!#)/i.test(inspect)||/url\(\s*(["']?)(?!#)/i.test(inspect))throw Error('Импорт отклонён: разрешены только локальные ссылки внутри SVG.');
  if(/<(?:style|filter|text|textPath|mask|pattern|meshgradient|fe[A-Z][\w-]*)\b/i.test(inspect))throw Error('В SVG есть неподдерживаемая конструкция (style, filter, mask, text или pattern).');
  const root=/<svg\b([^>]*)>/i.exec(svg)?.[1]||'';
  const viewBox=/\bviewBox\s*=\s*(["'])(.*?)\1/i.exec(root)?.[2];
  const width=/\bwidth\s*=\s*(["'])(.*?)\1/i.exec(root)?.[2];
  const height=/\bheight\s*=\s*(["'])(.*?)\1/i.exec(root)?.[2];
  const nums=(viewBox||'').trim().split(/[\s,]+/).map(Number);
  const hasViewBox=nums.length===4&&nums.every(Number.isFinite)&&nums[2]>0&&nums[3]>0;
  const dimension=(s:string|undefined)=>s?Number.parseFloat(s):NaN;
  if(!hasViewBox&&!(dimension(width)>0&&dimension(height)>0))throw Error('У SVG должны быть положительные width/height или корректный viewBox.');
  return svg;
}
function normalizeAssetMeta(raw:any,libraryId:string,node:any,filename:string):LibraryAsset {
  const semanticId=String(raw?.semanticId||'').trim().slice(0,100);
  const name=String(raw?.name||filename||'SVG component').trim().slice(0,120);
  const size=raw?.size==='S'?'S':raw?.size==='L'?'L':null;
  const role=raw?.role==='background'?'background':raw?.role==='main'?'main':null;
  if(!semanticId||!name||!size||!role)throw Error('Для каждого SVG укажите общий ID, название, детализацию L/S и цветной или фоновый вариант.');
  const list=(v:unknown)=>Array.isArray(v)?v.filter((x:any)=>typeof x==='string').map((x:string)=>x.trim().slice(0,80)).filter(Boolean).slice(0,40):[];
  return {id:String(raw?.id||makeId('asset')),semanticId,name,sourceNodeId:node.id,libraryId,size,role,tags:list(raw?.tags),synonyms:list(raw?.synonyms),width:node.width,height:node.height,vectorOnly:true};
}
function makeId(prefix:string):string {return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;}
function saveAssetMeta(node:any,asset:LibraryAsset):void {setLocalNodeData(node,STORAGE.document.asset,JSON.stringify(asset));}
function appendImportedNode(page:any,node:any,_index:number):void {
  if(node.parent!==page)page.appendChild(node);
  const bottom=page.children.filter((x:any)=>x!==node).reduce((max:number,x:any)=>Math.max(max,(Number(x.y)||0)+(Number(x.height)||0)+80),0);
  node.x=0;node.y=bottom;
}
async function importSvgBatch(files:any[]):Promise<void> {
  if(!activeLibrary()||projectCatalog.activeLibraryId===BASE_LIBRARY.id)throw Error('Создайте или выберите пользовательскую библиотеку перед импортом.');
  if(!Array.isArray(files)||!files.length||files.length>20)throw Error('Выберите от 1 до 20 SVG-файлов за один импорт.');
  const page=userLibraryPage(),previous=figma.currentPage,successes:any[]=[],failures:any[]=[];
  await figma.setCurrentPageAsync(page);
  try {
    for(let i=0;i<files.length;i++) {
      const entry=files[i];let node:any=null;
      try {
        const svg=validateSvgInput(entry?.svg);if(!entry?.meta||typeof entry.meta!=='object')throw Error('Метаданные компонента не заполнены.');
        try{node=figma.createNodeFromSvg(svg);}catch(error){throw new PluginOperationError({module:'svg',operation:'createNodeFromSvg',code:'SVG_FIGMA_IMPORT_FAILED',message:'Figma не смогла создать векторный объект из этого SVG. Проверьте файл и повторите импорт.',context:{index:String(i+1)}},error);}
        if(!isUsableSourceNode(node))throw Error('Figma не создала редактируемый векторный узел.');
        if(!isVectorOnly(node)){node.remove();node=null;throw Error('После импорта Figma обнаружила не-векторный узел или растровую заливку.');}
        const asset=normalizeAssetMeta(entry.meta,projectCatalog.activeLibraryId,node,String(entry.name||'').replace(/\.svg$/i,''));
        const conflict=projectCatalog.assets.find(x=>x.libraryId===asset.libraryId&&x.semanticId===asset.semanticId&&x.size===asset.size&&x.role===asset.role);
        if(conflict)asset.id=conflict.id;
        node.name=asset.name;appendImportedNode(page,node,projectCatalog.assets.length);saveAssetMeta(node,asset);
        if(conflict){const old=await figma.getNodeByIdAsync(conflict.sourceNodeId);if(old&&!old.removed)old.remove();available.delete(conflict.sourceNodeId);projectCatalog.assets=projectCatalog.assets.filter(x=>x.id!==conflict.id);}
        projectCatalog.assets.push(asset);available.set(asset.sourceNodeId,node);successes.push(asset);
      } catch(e) {if(node&&!node.removed)try{node.remove();}catch{}if(e instanceof PluginOperationError)try{console.error('[Vector Composer diagnostic]',{...e.diagnostic,technicalReason:redactDiagnostic((e as any).cause)});}catch{}failures.push({name:String(entry?.name||`SVG ${i+1}`),message:e instanceof PluginOperationError?e.message:e instanceof Error?e.message:String(e)});}
    }
  } finally {if(previous)await figma.setCurrentPageAsync(previous);}
  initialized=true;postLibraryState();post('import-result',{successes,failures});
  if(successes.length)post('status',{message:`Импортировано ${successes.length} векторных компонентов${failures.length?`; ошибок: ${failures.length}`:''}.`});
  if(!successes.length&&!failures.length)post('status',{message:'Импорт не выполнен.'});
}
async function importFigmaSelection(size:unknown,role:unknown):Promise<void> {
  if(!activeLibrary()||projectCatalog.activeLibraryId===BASE_LIBRARY.id)throw Error('Выберите пользовательскую библиотеку перед импортом из Figma.');
  const selected=(figma.currentPage.selection||[]).filter((n:any)=>isUsableSourceNode(n)&&isVectorOnly(n));
  if(!selected.length)throw Error('Выберите одну или несколько векторных групп на холсте Figma.');
  const page=userLibraryPage(),previous=figma.currentPage,successes:any[]=[],failures:any[]=[];
  await figma.setCurrentPageAsync(page);
  try {
    for(const original of selected) {
      let clone:any=null;
      try {
        clone=original.clone();appendImportedNode(page,clone,projectCatalog.assets.length);
        const name=String(original.name||'Figma component').slice(0,120);
        const semanticId=name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9а-яё]+/gi,'-').replace(/^-|-$/g,'').slice(0,100)||makeId('component');
        const asset=normalizeAssetMeta({semanticId,name,size,role},projectCatalog.activeLibraryId,clone,name);
        if(!isVectorOnly(clone))throw Error('Выбранный объект содержит текстовые или растровые элементы.');
        const conflict=projectCatalog.assets.find(x=>x.libraryId===asset.libraryId&&x.semanticId===asset.semanticId&&x.size===asset.size&&x.role===asset.role);if(conflict)asset.id=conflict.id;
        clone.name=asset.name;saveAssetMeta(clone,asset);
        if(conflict){const old=await figma.getNodeByIdAsync(conflict.sourceNodeId);if(old&&!old.removed)old.remove();available.delete(conflict.sourceNodeId);projectCatalog.assets=projectCatalog.assets.filter(x=>x.id!==conflict.id);}
        projectCatalog.assets.push(asset);available.set(asset.sourceNodeId,clone);successes.push(asset);
      } catch(e) {if(clone&&!clone.removed)try{clone.remove();}catch{}failures.push({name:original.name,message:e instanceof Error?e.message:String(e)});}
    }
  } finally {if(previous)await figma.setCurrentPageAsync(previous);}
  initialized=true;postLibraryState();post('import-result',{successes,failures});
}
function updateAsset(raw:any):void {
  const old=projectCatalog.assets.find(x=>x.id===raw?.id);if(!old)throw Error('Компонент не найден в каталоге.');
  const node=available.get(old.sourceNodeId);if(!node||node.removed)throw Error('Исходный узел удалён. Удалите устаревшую запись и импортируйте компонент заново.');
  const next=normalizeAssetMeta({...raw,id:old.id},old.libraryId,node,old.name);
  if(projectCatalog.assets.some(x=>x.id!==old.id&&x.libraryId===old.libraryId&&x.semanticId===next.semanticId&&x.size===next.size&&x.role===next.role))throw Error('В библиотеке уже есть объект с этим общим ID, детализацией и вариантом.');
  node.name=next.name;saveAssetMeta(node,next);projectCatalog.assets=projectCatalog.assets.map(x=>x.id===old.id?next:x);postLibraryState();post('status',{message:`Изменения объекта «${next.name}» сохранены.`});
}
async function createLibrary(name:string):Promise<void> {
  name=name.trim().slice(0,80);if(!name)throw Error('Введите название библиотеки.');
  if(projectCatalog.libraries.some(x=>x.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw Error('Библиотека с таким названием уже существует.');
  const lib={id:makeId('library'),name},next={...projectCatalog,libraries:[...projectCatalog.libraries,lib],activeLibraryId:lib.id};persistCatalog(next);projectCatalog=next;available.clear();await scan();post('status',{message:`Библиотека «${name}» создана.`});
}
async function deleteLibrary(id:string):Promise<void> {
  if(id===BASE_LIBRARY.id)throw Error('Базовую библиотеку нельзя удалить.');
  const lib=projectCatalog.libraries.find(x=>x.id===id);if(!lib)throw Error('Библиотека не найдена.');
  const removedAssets=projectCatalog.assets.filter(x=>x.libraryId===id);
  const next:ProjectCatalog={libraries:projectCatalog.libraries.filter(x=>x.id!==id),assets:projectCatalog.assets.filter(x=>x.libraryId!==id),activeLibraryId:projectCatalog.activeLibraryId===id?BASE_LIBRARY.id:projectCatalog.activeLibraryId};
  persistCatalog(next);projectCatalog=next;
  let orphaned=0;for(const asset of removedAssets){try{const node=await figma.getNodeByIdAsync(asset.sourceNodeId);if(node&&!node.removed)node.remove();}catch(error){orphaned++;try{console.error('[Vector Composer diagnostic]',{code:'LIBRARY_SOURCE_DELETE_FAILED',module:'library',operation:'delete-source',context:{libraryId:id,nodeId:asset.sourceNodeId},technicalReason:redactDiagnostic(error)});}catch{}}available.delete(asset.sourceNodeId);}
  await scan();post('status',{message:`Библиотека «${lib.name}» удалена.${orphaned?` Не удалось удалить ${orphaned} узлов-источников.`:''}`});
}
async function initializePalettes():Promise<void> {
  try {
    const raw=await figma.clientStorage.getAsync(STORAGE.settings.palettes);
    if(Array.isArray(raw))savedPalettes=raw.flatMap((x:any)=>{try{const p=Core.validatePalette(x);return typeof x.id==='string'&&x.id&&!['lilac','peach','mint'].includes(x.id)?[{id:x.id,name:p.name,backgroundColors:p.background,objectColors:p.objects,sourceColorMapping:p.sourceColorMapping}]:[];}catch{return[];}});
    const active=await figma.clientStorage.getAsync(STORAGE.settings.paletteActive);if(typeof active==='string'&&(['lilac','peach','mint'].includes(active)||savedPalettes.some(x=>x.id===active)))activePaletteId=active;
  }catch(error){reportSettingsReadFailure(STORAGE.settings.palettes,error);}
  if(currentScene)try{selectedPalette=resolvePalette(currentScene.palette);}catch{selectedPalette=resolvePalette(activePaletteId);}
  postPaletteState();
}
async function savePalette(raw:any):Promise<void> {
  const validated=Core.validatePalette(raw),id=typeof raw.id==='string'&&raw.id&&!['lilac','peach','mint'].includes(raw.id)?raw.id:makeId('palette');
  const entry:SavedPalette={id,name:validated.name,backgroundColors:validated.background,objectColors:validated.objects,sourceColorMapping:validated.sourceColorMapping};
  savedPalettes=savedPalettes.filter(x=>x.id!==id).concat(entry);activePaletteId=id;selectedPalette=userPalette(entry);
  const listSaved=await persistSetting(STORAGE.settings.palettes,savedPalettes),activeSaved=await persistSetting(STORAGE.settings.paletteActive,activePaletteId);postPaletteState();
  if(!listSaved||!activeSaved)post('status',{message:'Палитра доступна до закрытия плагина. Figma не разрешила сохранить её между запусками.'});
  else post('status',{message:`Палитра «${entry.name}» сохранена.`});
}
async function deletePalette(id:string):Promise<void> {
  if(['lilac','peach','mint'].includes(id))throw Error('Три встроенные палитры нельзя удалить.');
  if(!savedPalettes.some(x=>x.id===id))throw Error('Палитра не найдена.');
  savedPalettes=savedPalettes.filter(x=>x.id!==id);if(activePaletteId===id){activePaletteId='lilac';selectedPalette=resolvePalette('lilac');}
  const listSaved=await persistSetting(STORAGE.settings.palettes,savedPalettes),activeSaved=await persistSetting(STORAGE.settings.paletteActive,activePaletteId);postPaletteState();
  if(!listSaved||!activeSaved)post('status',{message:'Изменение применено до закрытия плагина, но настройки не удалось сохранить.'});
  else post('status',{message:'Пользовательская палитра удалена.'});
}
async function exportFrame():Promise<void> {
  assertFrame();
  const svg=await currentFrame.exportAsync({format:'SVG_STRING'});
  validateVectorSvg(svg,'композиции');
  post('svg-ready',{svg,filename:`vector-composer-${Date.now()}.svg`});
}
async function exportOriginalLibrary():Promise<void> {
  if(projectCatalog.activeLibraryId!==BASE_LIBRARY.id)throw Error('Для экспорта выберите «Базовая библиотека».');
  if(!initialized)await scan();
  if(available.size!==40)throw Error(`Экспорт библиотеки невозможен: найдено ${available.size}/40 элементов.`);
  const items:Array<{filename:string;svg:string}>=[];
  for(const a of Core.CATALOG)for(const size of ['L','S'] as const)for(const role of ['main','background'] as const) {
    const id=a.sources[size][role];const node=available.get(id);
    const svg=await node.exportAsync({format:'SVG_STRING'});
    validateVectorSvg(svg,`источника ${id}`);
    items.push({filename:`${size}/${role}/${a.id}.svg`,svg});
  }
  post('library-svg-ready',{items});
}
async function handleMessage(msg:any):Promise<void> {
  try{
    switch(msg.type){
      case 'scan':await scan();break;
      case 'compose':await compose(msg.options,msg.customPalette||null,msg.profile,msg.apiKey);break;
      case 'library-create':await createLibrary(String(msg.name||''));break;
      case 'library-select':{
        const id=String(msg.id||'');
        if(!projectCatalog.libraries.some(x=>x.id===id))throw Error('Библиотека не найдена.');
        const next={...projectCatalog,activeLibraryId:id};persistCatalog(next);projectCatalog=next;available.clear();initialized=false;await scan();break;
      }
      case 'library-delete':await deleteLibrary(String(msg.id||''));break;
      case 'svg-import':await importSvgBatch(msg.files);break;
      case 'figma-import-selection':await importFigmaSelection(msg.size,msg.role);break;
      case 'asset-update':updateAsset(msg.asset);break;
      case 'asset-delete':{
        const asset=projectCatalog.assets.find(x=>x.id===msg.id);if(!asset)throw Error('Компонент не найден.');
        const node=await figma.getNodeByIdAsync(asset.sourceNodeId);if(node&&!node.removed)node.remove();
        available.delete(asset.sourceNodeId);projectCatalog.assets=projectCatalog.assets.filter(x=>x.id!==asset.id);postLibraryState();post('status',{message:`Компонент «${asset.name}» удалён из библиотеки.`});break;
      }
      case 'add-component':addComponent(String(msg.id||''),msg.role==='background'?'background':'main');break;
      case 'ai-save':await saveAIProfile(profileFor(msg),msg.apiKey);break;
      case 'ai-select':{
        const profile=profileFor(msg);activeAIProfileId=profile.id;
        savedAIProfiles=savedAIProfiles.filter(p=>p.id!==profile.id).concat(profile);
        const persisted=await persistSetting(STORAGE.settings.aiActive,activeAIProfileId);
        postAISettings();if(!persisted)post('status',{message:'Провайдер выбран на текущий сеанс, но выбор не сохранится после закрытия плагина.'});break;
      }
      case 'ai-delete':{
        const id=String(msg.id||'');if(AI.PRESETS.some(p=>p.id===id))throw Error('Предустановленный профиль удалить нельзя.');
        savedAIProfiles=savedAIProfiles.filter(p=>p.id!==id);sessionKeys.delete(id);
        const profilesSaved=await persistSetting(STORAGE.settings.aiProfiles,savedAIProfiles);
        let activeSaved=true;if(activeAIProfileId===id){activeAIProfileId='gemini';activeSaved=await persistSetting(STORAGE.settings.aiActive,'gemini');}
        postAISettings();post('ai-status',{message:profilesSaved&&activeSaved?'Профиль удалён.': 'Профиль удалён только на текущий сеанс; изменения не сохранены.',state:profilesSaved&&activeSaved?'success':'warning'});break;
      }
      case 'ai-test':{
        const profile=profileFor(msg);const key=acceptSessionKey(profile.id,msg.apiKey);
        const provider=AI.createProvider(profile,key);
        await provider.testConnection();
        post('ai-status',{profileId:profile.id,message:'Подключение работает. Модель ответила на запрос.',state:'success'});break;
      }
      case 'palette':{
        const key=String(msg.key||activePaletteId),p=key==='custom'?Core.validatePalette(msg.customPalette):resolvePalette(key);recolor(p,key);break;
      }
      case 'palette-save':await savePalette(msg.palette);break;
      case 'palette-delete':await deletePalette(String(msg.id||''));break;
      case 'palette-select':{
        const id=String(msg.id||'');if(!['lilac','peach','mint'].includes(id)&&!savedPalettes.some(x=>x.id===id))throw Error('Палитра не найдена.');
        activePaletteId=id;selectedPalette=resolvePalette(id);const persisted=await persistSetting(STORAGE.settings.paletteActive,id);postPaletteState();if(!persisted)post('status',{message:'Палитра доступна только до закрытия плагина. Figma не разрешила сохранить настройки между запусками.'});break;
      }
      case 'restore-colors':restoreOriginalColors();break;
      case 'toggle-role':toggleRole(String(msg.id));break;
      case 'export':await exportFrame();break;
      case 'export-library':await exportOriginalLibrary();break;
      default:throw Error('Неизвестная команда: '+msg.type);
    }
  }catch(e){if(typeof msg?.type==='string'&&msg.type.startsWith('ai-'))post('ai-status',{message:e instanceof Error?e.message:String(e),state:'error'});report(e,typeof msg?.type==='string'?msg.type:'plugin');}
  finally{post('request-complete');}
}
const startupPromise=(async()=>{
  try{await initializeAI();await initializePalettes();await initializeLibrary();}
  catch(error){report(error,'startup');}
})();
let messageQueue:Promise<void>=Promise.resolve();
figma.ui.onmessage=(msg:any)=>{
  const task=messageQueue.then(async()=>{
    currentRequestId=typeof msg?.requestId==='string'?msg.requestId:undefined;
    try{await startupPromise;await handleMessage(msg);}
    finally{currentRequestId=undefined;}
  });
  messageQueue=task.catch(error=>{currentRequestId=typeof msg?.requestId==='string'?msg.requestId:undefined;report(error,typeof msg?.type==='string'?msg.type:'plugin');currentRequestId=undefined;});
  return messageQueue;
};
post('ready',{message:'Подключаю базовую библиотеку…'});
