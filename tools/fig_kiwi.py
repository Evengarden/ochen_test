"""Offline Kiwi decoder for inspection of a Figma .fig export.

Read-only. The resulting decoded properties are *not* guaranteed to round-trip
with official Figma; use Figma's exportAsync for final SVG asset extraction.
Kiwi binary rules follow evanw/kiwi (MIT).
"""
from __future__ import annotations
import argparse, json, struct, zlib, zipfile, subprocess, collections, pickle, pathlib, sys
from typing import Any
PRIMS=('bool','byte','int','uint','float','string','int64','uint64')
KINDS=('ENUM','STRUCT','MESSAGE')
class Reader:
    def __init__(self,b:bytes):self.b=b;self.i=0;self.n=len(b)
    def byte(self):
        if self.i>=self.n: raise EOFError(f'byte at {self.i}/{self.n}')
        r=self.b[self.i];self.i+=1;return r
    def varuint(self):
        r=0;s=0
        while True:
            v=self.byte();r|=(v&127)<<s
            if not (v&128):return r
            s+=7
            if s>70:raise ValueError('varuint overflow')
    def varint(self):
        v=self.varuint();return ~(v>>1) if v&1 else v>>1
    def string(self):
        end=self.b.find(b'\0',self.i)
        if end<0: raise EOFError('string')
        r=self.b[self.i:end].decode('utf-8','replace');self.i=end+1;return r
    def barray(self):
        n=self.varuint();v=self.b[self.i:self.i+n];self.i+=n;return v
    def varfloat(self):
        f=self.byte()
        if f==0:return 0.
        data=bytes((f,))+self.b[self.i:self.i+3];self.i+=3
        rotated=int.from_bytes(data,'little');bits=((rotated<<23)|(rotated>>9))&0xffffffff
        return struct.unpack('<f',bits.to_bytes(4,'little'))[0]

def parse_schema(b):
    r=Reader(b);count=r.varuint();defs=[]
    for i in range(count):
        name=r.string();kind=KINDS[r.byte()];num=r.varuint();fields=[]
        for j in range(num):
            fname=r.string();ftype=r.varint();arr=bool(r.byte()&1);value=r.varuint()
            fields.append(dict(name=fname,type_id=ftype,array=arr,value=value))
        defs.append(dict(name=name,kind=kind,fields=fields))
    for d in defs:
        for f in d['fields']:
            fid=f['type_id']
            f['type']=PRIMS[~fid] if fid<0 else defs[fid]['name']
    return defs
class Decoder:
    def __init__(self,defs,data):
        self.defs={d['name']:d for d in defs}
        self.byvalue={d['name']:{f['value']:f for f in d['fields']} for d in defs}
        self.enums={d['name']:{f['value']:f['name'] for f in d['fields']} for d in defs if d['kind']=='ENUM'}
        self.r=Reader(data);self.depth=0
    def val(self,t):
        r=self.r
        if t=='byte':return r.byte()
        if t=='bool':return bool(r.byte())
        if t=='uint':return r.varuint()
        if t=='int':return r.varint()
        if t=='float':return r.varfloat()
        if t=='string':return r.string()
        if t=='uint64':return r.varuint()
        if t=='int64':return r.varint()
        if t in self.enums:return self.enums[t].get(r.varuint(),'UNKNOWN')
        return self.decode(t)
    def decode(self,name):
        self.depth+=1
        if self.depth>1500: raise ValueError('too nested')
        d=self.defs[name];kind=d['kind'];result={}
        try:
            if kind=='STRUCT':
                fields=d['fields']
                for field in fields:
                    result[field['name']]=self.fieldval(field)
            else:
                fields=self.byvalue[name]
                while True:
                    k=self.r.varuint()
                    if not k:break
                    if k not in fields:raise ValueError(f'unknown field {name}.{k} at {self.r.i}')
                    f=fields[k];result[f['name']]=self.fieldval(f)
            return result
        finally:self.depth-=1
    def fieldval(self,field):
        if field['array']:
            if field['type']=='byte':return self.r.barray()
            n=self.r.varuint()
            if n>10**7:raise ValueError('array too big')
            return [self.val(field['type']) for _ in range(n)]
        return self.val(field['type'])

def decompress(b):
    if b[:4]==b'\x28\xb5\x2f\xfd':
        return subprocess.run(['zstd','-d','-c'],input=b,capture_output=True,check=True).stdout
    try:return zlib.decompress(b,-15)
    except:return zlib.decompress(b)

def decode_fig(p):
    with zipfile.ZipFile(p) as z: b=z.read('canvas.fig')
    assert b[:8]==b'fig-kiwi'
    version=int.from_bytes(b[8:12],'little');i=12;chunks=[]
    while i<len(b):
        n=int.from_bytes(b[i:i+4],'little');i+=4
        chunks.append(decompress(b[i:i+n]));i+=n
    defs=parse_schema(chunks[0]);d=Decoder(defs,chunks[1]);rootname=next(x['name'] for x in defs if x['name']=='Message')
    msg=d.decode(rootname)
    return version,defs,msg,d.r.i,len(chunks[1])

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('fig');ap.add_argument('--out',default='document.pickle');args=ap.parse_args()
    v,defs,msg,pos,total=decode_fig(args.fig)
    print('FIG format',v,'defs',len(defs),'decoded',pos,'/',total)
    print('Message fields',list(msg),'nodeChanges',len(msg.get('nodeChanges',[])))
    print('Schema highlights:')
    for d in defs:
        if d['name'] in ('Message','NodeChange','VectorNetwork','Vector','VectorPath'):
            print(d['name'],d['kind'], [(x['name'],x['type'],x['array']) for x in d['fields']][:70])
    with open(args.out,'wb') as f:pickle.dump({'version':v,'schema':defs,'message':msg},f,protocol=5)
    print('Saved:',args.out)
