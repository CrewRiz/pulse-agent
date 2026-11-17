import { workspace, scripted } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { connect, connectAll } from "../lib/mcp.mjs";
import { runTask } from "../lib/loop.mjs";
import { saveConfig } from "../lib/onboard.mjs";

const FAKE = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-mcp.mjs");
const server = (extra = {}) => ({ command: process.execPath, args: [FAKE], ...extra });

test("a connector is an MCP server: it is started, its tools are listed under a prefixed name, a call returns its text, an error comes back as one", async () => {
  const c = await connect("files", server({ env: { FAKE_MCP_TAG: "t1" } }));
  try {
    assert.deepEqual(c.tools.map((t) => t.function.name), ["mcp__files__echo", "mcp__files__boom", "mcp__files__secret"]);
    assert.equal(c.tools[0].function.parameters.required[0], "text"); assert.match(c.tools[0].function.description, /Echo/);
    assert.deepEqual(await c.call("echo", { text: "hi" }), { ok: true, output: "echo: hi (t1)" });
    const b = await c.call("boom", {}); assert.equal(b.ok, false); assert.match(b.output, /it broke/);
    const n = await c.call("nope", {}); assert.equal(n.ok, false); assert.match(n.output, /no such tool/);
  } finally { c.close(); }
});

test("an allowlist limits a connector to the tools named; a server that cannot start or never answers is reported, not fatal", async () => {
  const set = await connectAll({ files: server({ tools: ["echo"] }), broken: { command: "/nonexistent/binary" }, silent: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } }, { timeoutMs: 600 });
  try {
    assert.deepEqual(set.tools.map((t) => t.function.name), ["mcp__files__echo"]);
    assert.equal(set.failed.length, 2); assert.ok(set.failed.some((f) => f.name === "broken")); assert.ok(set.failed.some((f) => f.name === "silent" && /did not answer/.test(f.reason)));
    assert.deepEqual(await set.call("mcp__files__echo", { text: "x" }), { ok: true, output: "echo: x (no tag)" });
    const off = await set.call("mcp__files__secret", {}); assert.equal(off.ok, false); assert.equal(off.refused, true);
  } finally { set.close(); }
});

test("in a run the builder can call a configured connector; the evaluator is never given one", async () => {
  const root = workspace(); saveConfig(root, { model: "m", mcpServers: { files: server() } });
  const model = scripted([{ tool_calls: [["mcp__files__echo", { text: "from the agent" }]] }, { content: "done" }]);
  const r = await runTask({ root, task: "use the connector", model, mcpServers: { files: server() } });
  assert.ok(model.seen[0].tools.includes("mcp__files__echo")); assert.match(model.seen[1].messages.at(-1).content, /echo: from the agent/); assert.equal(r.answer, "done");
  const ev = scripted([{ tool_calls: [["mcp__files__echo", { text: "x" }]] }, { content: "no" }]);
  await runTask({ root, task: "review", model: ev, role: "evaluator", mcpServers: { files: server() } });
  assert.ok(!ev.seen[0].tools.some((t) => t.startsWith("mcp__"))); assert.match(ev.seen[1].messages.at(-1).content, /no tool named|not available/);
});
