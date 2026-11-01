#!/usr/bin/env python3
"""Verify MCP with the official SDK. Requires a user-issued token in the environment."""
import asyncio
import os
import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def check(url: str, token: str):
    async with httpx2.AsyncClient(headers={'Authorization': 'Bearer '+token}) as http:
        async with streamable_http_client(url, http_client=http) as streams:
            async with ClientSession(*streams) as session:
                initialized = await session.initialize()
                tools = await session.list_tools()
                names = {t.name for t in tools.tools}
                assert {'get_me','get_use_case','create_run','generate_report','submit_proposal'} <= names
                me = await session.call_tool('get_me', {})
                projects = await session.call_tool('list_projects', {})
                assert not me.is_error and not projects.is_error
                print(f'MCP SDK check passed: protocol={initialized.protocol_version}, tools={len(names)}')


if __name__ == '__main__':
    asyncio.run(check(os.environ.get('UCASELAB_MCP_URL','http://localhost:8080/mcp/'), os.environ['UCASELAB_MCP_TOKEN']))
