#!/usr/bin/env python3
"""Small usable stdio MCP example for learning explicit plugin selection."""
import json
import sys

TOOL = {
    "name": "echo",
    "description": "Return the supplied text unchanged.",
    "inputSchema": {
        "type": "object", "properties": {"text": {"type": "string"}},
        "required": ["text"], "additionalProperties": False,
    },
}

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method, params = request.get("method"), request.get("params", {})
    response = {"jsonrpc": "2.0", "id": request["id"]}
    if method == "initialize":
        result = {"protocolVersion": params["protocolVersion"], "capabilities": {"tools": {}},
                  "serverInfo": {"name": "Achbit Echo Example", "version": "1.0.0"}}
    elif method == "tools/list":
        result = {"tools": [TOOL]}
    elif method == "tools/call" and params.get("name") == "echo":
        text = params.get("arguments", {}).get("text")
        if not isinstance(text, str):
            result = {"isError": True, "content": [{"type": "text", "text": "text must be a string"}]}
        else:
            result = {"content": [{"type": "text", "text": text}]}
    elif method == "ping":
        result = {}
    else:
        response["error"] = {"code": -32601, "message": "Method not found"}
        print(json.dumps(response), flush=True)
        continue
    response["result"] = result
    print(json.dumps(response), flush=True)
