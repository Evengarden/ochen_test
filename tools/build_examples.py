#!/usr/bin/env python3
"""Assemble static, all-vector examples from extracted original SVG objects.
Only position, uniform scale, layer order, and palette mapping are changed.
"""
import copy,io,json,pathlib,re
from lxml import etree
from PIL import Image
import cairosvg
from export_fig_assets import PALETTES, HERE
NS='http://www.w3.org/2000/svg';F=lambda tag:f'{{{NS}}}{tag}'
SCENES=[
 {'name':'01-business-growth','title':'Рост бизнеса','size':'L','palette':'lilac','dimensions':(1200,630),'scale':.46,'background':'#D7CDF5',
  'objects':[('book','background',-130,240),('phone','main',410,222),('puzzle','main',740,44),('coin','main',990,365)]},
 {'name':'02-education-ideas','title':'Обучение и идеи','size':'S','palette':'mint','dimensions':(1000,1000),'scale':.87,'background':'#BEEBEB',
  'objects':[('flowers','background',745,15),('book','main',-105,220),('lamp','main',530,275),('pen','main',455,775)]},
 {'name':'03-creativity-notes','title':'Творческий процесс','size':'L','palette':'peach','dimensions':(800,1200),'scale':.56,'background':'#FDD7B9',
  'objects':[('flowers','background',400,-140),('lamp','main',105,150),('folder','main',-135,830),('pen','main',485,1005)]},
]
def rgb(h):return tuple(int(h[i:i+2],16) for i in (1,3,5))
def remap(h,role,target):
 base=PALETTES['lilac'];allowed=base['background'] if role=='background' else base['background']+base['objects']
 dest=target['background'] if role=='background' else target['background']+target['objects']
 try:v=rgb(h)
 except:return h
 idx=min(range(len(allowed)),key=lambda i:sum((v[k]-rgb(allowed[i])[k])**2 for k in range(3)))
 return dest[idx]
def main():
 outdir=HERE/'examples';outdir.mkdir(exist_ok=True)
 for scene in SCENES:
  w,h=scene['dimensions'];palette=PALETTES[scene['palette']]
  svg=etree.Element(F('svg'),nsmap={None:NS},width=str(w),height=str(h),viewBox=f'0 0 {w} {h}',attrib={'data-title':scene['title'],'data-size':scene['size'],'data-theme':scene['palette']})
  etree.SubElement(svg,F('rect'),x='0',y='0',width=str(w),height=str(h),fill=scene['background'])
  for slug,role,x,y in scene['objects']:
   src=HERE/'assets/svg'/scene['size']/role/(slug+'.svg');tree=etree.parse(str(src));r=tree.getroot();sw=float(r.get('width'));sh=float(r.get('height'));sc=scene['scale']
   sub=etree.SubElement(svg,F('svg'),x=str(x),y=str(y),width=str(sw*sc),height=str(sh*sc),viewBox=r.get('viewBox'),attrib={'data-asset':slug,'data-role':role,'data-source-node':r.get('data-source-node')})
   for child in r:sub.append(copy.deepcopy(child))
   for el in sub.iter():
    if el.get('fill') and re.fullmatch('#[A-Fa-f0-9]{6}',el.get('fill')):
     el.set('fill',remap(el.get('fill'),role,palette))
    if el.get('stroke') and re.fullmatch('#[A-Fa-f0-9]{6}',el.get('stroke')):
     el.set('stroke',remap(el.get('stroke'),role,palette))
  outfile=outdir/(scene['name']+'.svg')
  outfile.write_bytes(etree.tostring(svg,encoding='utf-8',xml_declaration=True,pretty_print=True))
  png=outdir/(scene['name']+'.png');cairosvg.svg2png(bytestring=outfile.read_bytes(),write_to=str(png),output_width=int(w*.6),output_height=int(h*.6))
  print(outfile.name,'paths',len(svg.xpath('.//*[local-name()="path"]')),'bytes',outfile.stat().st_size)

if __name__=='__main__':main()
