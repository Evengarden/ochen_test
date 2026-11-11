#!/usr/bin/env python3
"""Read-only, best-effort asset SVG extraction from decoded original Figma .fig.

Unlike native Figma exportAsync, an offline Kiwi reverse-decoder cannot promise
bit-for-bit visual fidelity (notably gradient coordinates/blends/advanced effects).
Do not use these files as the authority for final production output: for that,
use plugin exportAsync on the original Figma frames.
"""
from __future__ import annotations
import collections, html, json, pickle, math, re, struct, pathlib
from lxml import etree
HERE=pathlib.Path(__file__).resolve().parent.parent
SVGNS='http://www.w3.org/2000/svg'
# Source node IDs verified from the decoded document. Source vectors stay untouched.
ASSETS={
 'L': {
  'main': {'book':'21:29965','phone':'21:25472','puzzle':'21:417','coin':'24:2207','headphones':'23:122','lamp':'23:121','wallet':'23:211','folder':'24:1899','pen':'24:1734','flowers':'28:11628'},
  'background': {'book':'24:6273','phone':'24:6327','puzzle':'24:6214','coin':'24:6795','headphones':'24:6484','lamp':'24:6569','wallet':'24:6660','folder':'24:6772','pen':'24:6747','flowers':'30:11902'},
 },
 'S': {
  'main': {'book':'24:3810','phone':'24:4746','puzzle':'24:4903','coin':'24:5345','headphones':'24:5089','lamp':'24:5485','wallet':'24:4594','folder':'24:4430','pen':'24:4287','flowers':'28:11629'},
  'background': {'book':'24:6934','phone':'24:6990','puzzle':'24:7147','coin':'24:7205','headphones':'24:7344','lamp':'24:7429','wallet':'24:7568','folder':'24:7520','pen':'24:7543','flowers':'28:11766'},
 }
}
NAMES={'book':'Книга','phone':'Телефон','puzzle':'Пазлы','coin':'Монета','headphones':'Наушники','lamp':'Лампа','wallet':'Кошелёк','folder':'Папка','pen':'Ручка','flowers':'Цветы'}
TAGS={'book':['знания','чтение','обучение','образование','learning','books'], 'phone':['связь','телефон','технологии','приложение','мобильный','mobile'], 'puzzle':['задача','решение','сотрудничество','команда','идеи','puzzle'], 'coin':['финансы','деньги','бизнес','рост','экономика'], 'headphones':['аудио','музыка','слушать','подкаст','концентрация'], 'lamp':['свет','работа','идея','вдохновение','учёба'], 'wallet':['финансы','кошелёк','покупки','деньги','оплата'], 'folder':['папка','документы','организация','архив'], 'pen':['ручка','писать','записи','учёба','идея'], 'flowers':['цветы','растения','уют','природа','развитие']}
PALETTES={
 'lilac': {'name':'Лавандовая','background':['#D7CDF5','#AA9BF0','#7864D7','#181817'], 'objects':['#F9ECB0','#F9A3AA','#FFE3E1','#FFFFFF']},
 'peach': {'name':'Персиковая','background':['#FDD7B9','#FAC896','#D27532','#181817'], 'objects':['#F9ECB0','#80DADA','#BEEBEB','#FFFFFF']},
 'mint': {'name':'Бирюзовая','background':['#BEEBEB','#80DADA','#5ABEBE','#181817'], 'objects':['#FFD4F2','#6D7BFC','#B6C6FE','#FFFFFF']},
}

def idof(n):
 g=n['guid'];return f"{g['sessionID']}:{g['localID']}"

def mat(n):
 a=n.get('transform') or {}
 return [a.get(k,v) for k,v in [('m00',1),('m10',0),('m01',0),('m11',1),('m02',0),('m12',0)]]

def matstr(m):return 'matrix('+ ' '.join(f'{x:.6f}'.rstrip('0').rstrip('.') if abs(x)>1e-8 else '0' for x in m)+')'

def color(p):
 c=p.get('color')
 if not c:return None
 return '#'+''.join(f'{max(0,min(255,round(c.get(k,0)*255))):02X}' for k in ('r','g','b'))

def alpha(p):
 c=p.get('color') or {}
 return float(p.get('opacity',1) * c.get('a',1))

def pathblob(raw):
 if not raw:return None
 p=0;parts=[]
 try:
  while p<len(raw):
   code=raw[p];p+=1
   if code==0:parts.append('Z');continue
   if code in (1,2):
    x,y=struct.unpack_from('<ff',raw,p);p+=8
    if not math.isfinite(x+y):return None
    parts.append(f'{"M" if code==1 else "L"}{x:.9g},{y:.9g}')
   elif code==4:
    q=struct.unpack_from('<ffffff',raw,p);p+=24
    if not all(math.isfinite(a) for a in q):return None
    parts.append('C'+','.join(f'{z:.9g}' for z in q))
   else:return None
  return ' '.join(parts)
 except (struct.error,ValueError):return None

class Exporter:
 def __init__(self,d):
  self.nodes={idof(n):n for n in d['message']['nodeChanges'] if n.get('guid')}
  self.ch=collections.defaultdict(list)
  for n in d['message']['nodeChanges']:
   p=n.get('parentIndex',{}).get('guid')
   if p:self.ch[f"{p['sessionID']}:{p['localID']}"].append(n)
  for child in self.ch.values():child.sort(key=lambda n: n.get('parentIndex',{}).get('position',''))
  self.blobs=d['message']['blobs'];self.path_cache={}
  self.stats=collections.Counter()
 def paint(self,node,kind='fill',style=0):
  styles=node.get('fillPaints' if kind=='fill' else 'strokePaints') or []
  if style:
   for override in (node.get('vectorData',{}).get('styleOverrideTable') or []):
    if override.get('styleID')==style:
     styles=override.get('fillPaints' if kind=='fill' else 'strokePaints') or styles
     break
  for p in reversed(styles):
   if p.get('visible') is False:continue
   if p.get('type')=='SOLID' and color(p):return ('solid',color(p),alpha(p))
   if p.get('type','').startswith('GRADIENT_'):return ('gradient',p,alpha(p))
   self.stats['unsupported_paint_'+str(p.get('type'))]+=1
  return None
 def addpaint(self,el,node,kind='fill',style=0,defs=None):
  paint=self.paint(node,kind,style)
  if not paint:
   el.set('fill','none');return False
  if paint[0]=='solid':
   el.set('fill',paint[1]);
   if paint[2]<.99999:el.set('fill-opacity',f'{paint[2]:.5f}')
  elif paint[0]=='gradient' and defs is not None:
   p=paint[1];gid=f'gradient-{len(defs)}'
   g=etree.SubElement(defs,'{%s}linearGradient'%SVGNS,id=gid)
   # Approximate spatial gradient due to Figma-specific transform convention.
   g.set('x1','0%');g.set('y1','0%');g.set('x2','100%');g.set('y2','100%')
   for stop in p.get('stops') or []:
    c=stop.get('color') or {};q={'color':c,'opacity':1}
    etree.SubElement(g,'{%s}stop'%SVGNS,offset=f"{max(0,min(1,stop.get('position',0)))*100:.2f}%",style=f'stop-color:{color(q) or "#000"};stop-opacity:{c.get("a",1)}')
   el.set('fill',f'url(#{gid})');self.stats['approximate_gradient']+=1
  return True
 def make(self,root_id,out):
  root=self.nodes[root_id];w=(root.get('size') or {}).get('x',1);h=(root.get('size') or {}).get('y',1)
  svg=etree.Element('{%s}svg'%SVGNS,nsmap={None:SVGNS},attrib={'viewBox':f'0 0 {w:.6f} {h:.6f}','width':f'{w:.4f}','height':f'{h:.4f}'})
  svg.set('data-source-node',root_id);defs=etree.SubElement(svg,'{%s}defs'%SVGNS)
  self._walk(root,svg,defs,root_id,True)
  out.parent.mkdir(parents=True,exist_ok=True)
  out.write_bytes(etree.tostring(svg,xml_declaration=True,encoding='utf-8'))
  return dict(path_count=len(svg.xpath('.//*[local-name()="path"]')),byte_count=out.stat().st_size)
 def _walk(self,node,parent,defs,root_id,isroot=False):
  ntype=node.get('type')
  if node.get('visible') is False:
   self.stats['skipped_hidden']+=1;return
  group=etree.SubElement(parent,'{%s}g'%SVGNS)
  group.set('data-figma-node',idof(node))
  if node.get('name') and ntype!='VECTOR':group.set('data-name',node['name'])
  if not isroot:
   m=mat(node)
   group.set('transform',matstr(m))
  if node.get('opacity',1)<.9999:group.set('opacity',f"{node['opacity']:.5f}")
  sz=node.get('size') or {}
  if ntype in ('VECTOR','BOOLEAN_OPERATION'):
   # The commandsBlob coordinates are already in the node's local units.
   # vectorData.normalizedSize is editing metadata and must NOT rescale paths.
   sg=group
   for cat in ('fill','stroke'):
    for ge in node.get(cat+'Geometry') or []:
     idx=ge.get('commandsBlob');
     if idx is None or idx>=len(self.blobs):continue
     if idx not in self.path_cache:self.path_cache[idx]=pathblob(self.blobs[idx]['bytes'])
     path=self.path_cache[idx]
     if not path:
      self.stats['failed_path']+=1;continue
     el=etree.SubElement(sg,'{%s}path'%SVGNS,d=path)
     self.addpaint(el,node,cat,ge.get('styleID',0),defs)
     if ge.get('windingRule')=='ODD':el.set('fill-rule','evenodd')
     self.stats['path']+=1
  elif ntype in ('FRAME','ROUNDED_RECTANGLE','RECTANGLE','ELLIPSE'):
   if node.get('fillPaints'):
    if ntype=='ELLIPSE': el=etree.SubElement(group,'{%s}ellipse'%SVGNS, cx=str(sz.get('x',0)/2),cy=str(sz.get('y',0)/2),rx=str(sz.get('x',0)/2),ry=str(sz.get('y',0)/2))
    else:
     el=etree.SubElement(group,'{%s}rect'%SVGNS,x='0',y='0',width=str(sz.get('x',0)),height=str(sz.get('y',0)))
     if ntype=='ROUNDED_RECTANGLE' and node.get('cornerRadius'): el.set('rx',str(node['cornerRadius']))
    self.addpaint(el,node,defs=defs)
  elif ntype=='LINE':
   strokepaint=self.paint(node,'stroke')
   if strokepaint and strokepaint[0]=='solid':
    el=etree.SubElement(group,'{%s}line'%SVGNS,x1='0',y1='0',x2=str(sz.get('x',0)),y2=str(sz.get('y',0)))
    el.set('stroke',strokepaint[1]);el.set('stroke-width',str(node.get('strokeWeight',1)))
  # TEXT and exotic types are intentionally omitted from asset export
  # Boolean operands must not be painted separately: Figma stores the flattened
  # result in the parent operation's fillGeometry.
  if ntype!='BOOLEAN_OPERATION':
   for c in self.ch[idof(node)]:self._walk(c,group,defs,root_id)

def main():
 with (HERE/'tools/parsed.pickle').open('rb') as f:d=pickle.load(f)
 ex=Exporter(d);stats=[];output=HERE/'assets/svg';output.mkdir(parents=True,exist_ok=True)
 for sz,roles in ASSETS.items():
  for role,assets in roles.items():
   for slug,source in assets.items():
    out=output/sz/role/(slug+'.svg');s=ex.make(source,out)
    stats.append(dict(id=f'{sz}/{role}/{slug}',name=NAMES[slug],semanticId=slug,size=sz,role=role,sourceNodeId=source,path=str(out.relative_to(HERE)),tags=TAGS[slug],width=ex.nodes[source].get('size',{}).get('x'),height=ex.nodes[source].get('size',{}).get('y'),**s))
 (HERE/'assets/manifest.json').write_text(json.dumps({'source':'Тестовое _ иллюстрации (Copy).fig','assetCount':len(stats),'assets':stats},ensure_ascii=False,indent=2))
 (HERE/'assets/palettes.json').write_text(json.dumps(PALETTES,ensure_ascii=False,indent=2))
 print('exported:',len(stats),'assets; total paths:',sum(s['path_count'] for s in stats),'stat',ex.stats)
 for a in stats:print(a['id'],a['path_count'],a['byte_count'])

if __name__=='__main__':main()
