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

## Personal connectors

A connector you want in every project is added once, outside any project:

```sh
pulse-agent connectors add web --global --url https://your-worker.example/mcp --header "Authorization: Bearer ${WEB_MCP_TOKEN}"
pulse-agent allow "mcp:web__*"
```

`${NAME}` in a header is filled from your environment when the connector starts, so the token is not written into a file a project shares. If the variable is not set, the connector is not started and the placeholder is never sent. Personal connectors are kept in a file only you can read and need no project to be trusted. `pulse-agent connectors remove <name> --global` takes one away.

A remote MCP server on Cloudflare Workers, or any other host, works this way. When the connectors together offer more than 12 tools, the model is given a search over them instead of every definition.

## Who can use them

The builder can. The evaluator cannot: it reads files and runs your check, and nothing else.

## What to know

A connector runs as its own process with your user's permissions and a minimal environment: your API keys and tokens are not passed to it unless the config names them under `env` or `passEnv`. It is not held inside the project folder the way the file tools are. Configure servers you trust and use the `tools` list.

A connector that fails to start is reported and skipped. The run goes on without it.
