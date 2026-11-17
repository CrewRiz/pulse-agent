// A minimal MCP server over stdio for tests: newline-delimited JSON-RPC 2.0, two tools, one that fails.
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const TOOLS = [
  { name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "boom", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "secret", description: "Not on the allowlist.", inputSchema: { type: "object", properties: {} } },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  if (m.method === "notifications/initialized") return;
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  if (m.method === "tools/call") {
    if (m.params.name === "echo") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `echo: ${m.params.arguments.text} (${process.env.FAKE_MCP_TAG ?? "no tag"})` }] } });
    if (m.params.name === "boom") return send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "it broke" }] } });
    return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such tool" } });
  }
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
