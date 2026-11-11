#!/usr/bin/env python3
"""Audit embedded vector-only SVG library and static SVG examples."""
from pathlib import Path
import json
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parent.parent
M=json.loads((ROOT/'assets/manifest.json').read_text())
P=json.loads((ROOT/'assets/palettes.json').read_text())
assets=M['assets']
assert len(assets)==M['assetCount']==40
assert len(P)==3
allowed={f'{s}/{r}/{a}' for s in ['L','S'] for r in ['main','background'] for a in ['book','phone','puzzle','coin','headphones','lamp','wallet','folder','pen','flowers']}
assert {a['id'] for a in assets}==allowed, 'Missing/unexpected source asset'
seen=[];paths=0

def local_name(tag):
    return tag.rsplit('}',1)[-1]

for info in assets:
    p=ROOT/info['path']
    root=ET.parse(p).getroot()
    nodes=list(root.iter())[1:]
    assert local_name(root.tag)=='svg' and root.get('viewBox')
    assert root.get('data-source-node')==info['sourceNodeId']
    layers=[node for node in nodes if local_name(node.tag)=='path']
    assert layers, f'No vector paths: {info["id"]}'
    assert len(layers)==info['path_count'], info['id']
    assert not [node for node in nodes if local_name(node.tag) in {'image','foreignObject','text'}], info['id']
    assert not [node for node in nodes if local_name(node.tag)=='use'], info['id']
    assert not [value for node in nodes for key,value in node.attrib.items() if local_name(key)=='href' and value.lower().startswith(('data:','http'))], info['id']
    assert p.stat().st_size==info['byte_count'], f'Manifest stale for {info["id"]}'
    seen.append(info['id']);paths+=len(layers)
assert paths==3024,(paths,'count mismatch')
for p in sorted((ROOT/'examples').glob('*.svg')):
    root=ET.parse(p).getroot()
    nodes=list(root.iter())[1:]
    assert any(local_name(node.tag)=='path' for node in nodes),p
    assert not any(local_name(node.tag) in {'image','foreignObject'} for node in nodes),p
    scene_objs=[node for node in nodes if local_name(node.tag)=='svg' and node.get('data-source-node')]
    assert len(scene_objs)>=3,p
    scales=[]
    for obj in scene_objs:
        root_id=obj.get('data-source-node')
        matching=[a for a in assets if a['sourceNodeId']==root_id]
        assert len(matching)==1,p
        native=float(matching[0]['width']);scene=float(obj.get('width'))
        scales.append(scene/native)
    assert max(scales)-min(scales)<1e-6,f'Nonuniform object scale in {p}'
    path_count=sum(local_name(node.tag)=='path' for node in nodes)
    print(f'{p.name}: {len(scene_objs)} source objects, uniform scale {scales[0]:.5f}, paths {path_count}')
print(f'PASSED: 40 source SVG, {paths} path elements, 3 compositions, 3 palettes, no bitmap elements')
