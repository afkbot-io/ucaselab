#!/usr/bin/env python3
"""Regenerate the public contract from the same registry as REST and MCP."""
import tomllib
import json
import sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'apps/api'))
from app.main import REGISTRY
schema={'version':tomllib.loads((root/"pyproject.toml").read_text())["project"]["version"],'transport':'Streamable HTTP','authentication':'Bearer personal token','operations':{name:{'description':op['func'].__doc__,'scope':op['scope'],'role':op['role'],'write':op['write'],'global':op['global_'],'arguments':op['model'].model_json_schema()} for name,op in sorted(REGISTRY.items())}}
(root/'docs/API_SCHEMA.json').write_text(json.dumps(schema,ensure_ascii=False,indent=2)+'\n')
print(f'Exported {len(REGISTRY)} operation schemas')
