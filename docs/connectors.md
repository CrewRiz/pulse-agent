# Connectors

A connector is a Model Context Protocol (MCP) server. MCP is the open standard other agents use for their tools, so a server written for any of them works here without changes.

## Add one

Put it in `.pulse-agent/config.json`, in the same shape other agents use:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "<an MCP server package>"],
      "tools": ["read", "search"]
    }
  }
}
```

`tools` is optional. With it, the model is offered only the tools you name.

Check that it starts and see what it offers:

```sh
pulse-agent connectors
```

Each tool reaches the model as `mcp__<server>__<tool>`.

## Who can use them

The builder can. The evaluator cannot: it reads files and runs your check, and nothing else.

## What to know

A connector runs as its own process with your user's permissions. It is not held inside the project folder the way the file tools are. Configure servers you trust and use the `tools` list.

A connector that fails to start is reported and skipped. The run goes on without it.
