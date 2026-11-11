#!/usr/bin/env python3
"""Rebuild best-effort offline assets from the supplied Figma .fig.

Requires system zstd and Python packages in tools/requirements.txt.
The Figma plugin's native SVG export is still the authoritative output.
"""
from pathlib import Path
import argparse,pickle
from fig_kiwi import decode_fig
from export_fig_assets import main as export_main
from build_examples import main as examples_main
ROOT=Path(__file__).resolve().parent.parent
if __name__=='__main__':
    arg=argparse.ArgumentParser();arg.add_argument('fig',nargs='?',default=str(ROOT/'source/Тестовое _ иллюстрации (Copy).fig'))
    ns=arg.parse_args();file=Path(ns.fig)
    if not file.exists():raise SystemExit(f'Original .fig not found: {file}')
    v,defs,msg,pos,total=decode_fig(file)
    assert pos==total
    raw=ROOT/'tools/parsed.pickle'
    try:
        with raw.open('wb') as f:pickle.dump({'version':v,'schema':defs,'message':msg},f,protocol=5)
        print('Decoded:',len(msg.get('nodeChanges',[])),'nodes',len(msg.get('blobs',[])),'geometry blobs')
        export_main();examples_main()
    finally:
        raw.unlink(missing_ok=True)
