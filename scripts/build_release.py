#!/usr/bin/env python3
"""Build a reproducible source release from an allowlist; never package local secrets/data."""
import gzip
import hashlib
import io
import tomllib
import json
import tarfile
from pathlib import Path

from export_public import product_files
ROOT=Path(__file__).resolve().parents[1]
VERSION=tomllib.loads((ROOT/"pyproject.toml").read_text())["project"]["version"]
TOP=f'ucaselab-{VERSION}'
paths=product_files(ROOT)
catalog_path = ROOT / 'dist/skills/index.json'
catalog = json.loads(catalog_path.read_text())
paths.append(catalog_path)
for skill in catalog['skills']:
    name = skill['archive']
    if Path(name).name != name:
        raise ValueError('Skill archive must be a filename')
    archive_path = catalog_path.parent / name
    if hashlib.sha256(archive_path.read_bytes()).hexdigest() != skill['sha256']:
        raise ValueError('Skill archive checksum mismatch')
    paths.append(archive_path)
manifest={p.relative_to(ROOT).as_posix():{'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(paths)}
archive=ROOT/'dist'/f'{TOP}.tar.gz'
with archive.open('wb') as raw,gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as gz,tarfile.open(fileobj=gz,mode='w',format=tarfile.PAX_FORMAT) as tar:
    def add(name,data):
        info=tarfile.TarInfo(TOP+'/'+name)
        info.size=len(data);info.mode=0o644;info.uid=info.gid=0;info.mtime=0
        tar.addfile(info,io.BytesIO(data))
    for p in sorted(paths):
        add(p.relative_to(ROOT).as_posix(),p.read_bytes())
    add('release-manifest.json',json.dumps({'version':VERSION,'files':manifest},sort_keys=True,ensure_ascii=False,indent=2).encode())
checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(archive.suffix+'.sha256').write_text(checksum+'  '+archive.name+'\n')
print(f'Release built: {archive.name}; {len(paths)} files; {archive.stat().st_size} bytes')
