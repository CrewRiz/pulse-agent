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

A server reached over HTTP takes a `url` instead of a command:

```json
{ "mcpServers": { "kb": { "url": "https://example.com/mcp", "headers": { "authorization": "Bearer <token>" }, "tools": ["lookup"] } } }
```

`tools` is optional. With it, the model is offered only the tools you name.

Connectors in a project's config are started only after you run `pulse-agent trust` there. Each call also needs an approval rule, for example `pulse-agent allow "mcp:files__*"`, or `--yes`.

Check that it starts and see what it offers:

```sh
pulse-agent connectors
```

Each tool reaches the model as `mcp__<server>__<tool>`.

## Who can use them

The builder can. The evaluator cannot: it reads files and runs your check, and nothing else.

## What to know

A connector runs as its own process with your user's permissions and a minimal environment: your API keys and tokens are not passed to it unless the config names them under `env` or `passEnv`. It is not held inside the project folder the way the file tools are. Configure servers you trust and use the `tools` list.

A connector that fails to start is reported and skipped. The run goes on without it.
