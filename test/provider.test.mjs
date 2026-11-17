import "./_helpers.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openaiCompatible } from "../lib/provider.mjs";

const seen = []; let respond;
const fake = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { const body = JSON.parse(Buffer.concat(c).toString("utf8")); seen.push({ url: req.url, auth: req.headers.authorization, body }); const r = respond(body); res.writeHead(r.status, { "content-type": "application/json" }); res.end(JSON.stringify(r.body)); }); });
let base;
before(async () => { await new Promise((ok) => fake.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${fake.address().port}/v1`; });
after(() => fake.close());
const TOOL = [{ type: "function", function: { name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];

test("an OpenAI-compatible endpoint: the request carries model, messages and tools; tool calls come back parsed", async () => {
  respond = () => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] } }] } });
  const model = openaiCompatible({ baseUrl: base, model: "local-model", apiKey: "k" });
  const out = await model({ messages: [{ role: "user", content: "hi" }], tools: TOOL });
  assert.deepEqual(out, { content: "", tool_calls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] });
  const s = seen.at(-1); assert.equal(s.url, "/v1/chat/completions"); assert.equal(s.auth, "Bearer k"); assert.equal(s.body.model, "local-model"); assert.equal(s.body.tools[0].function.name, "read_file"); assert.equal(s.body.messages[0].content, "hi");
});

test("no key sends no Authorization header; plain text comes back as content; arguments that are not JSON become an error the model can read", async () => {
  respond = () => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: "hello" } }] } });
  const model = openaiCompatible({ baseUrl: base + "/", model: "m" });
  assert.deepEqual(await model({ messages: [{ role: "user", content: "hi" }], tools: [] }), { content: "hello", tool_calls: [] });
  assert.equal(seen.at(-1).auth, undefined); assert.equal(seen.at(-1).body.tools, undefined, "an empty tool list is not sent");
  respond = () => ({ status: 200, body: { choices: [{ message: { content: "", tool_calls: [{ id: "c2", function: { name: "read_file", arguments: "{not json" } }] } }] } });
  const bad = await model({ messages: [{ role: "user", content: "hi" }], tools: TOOL });
  assert.equal(bad.tool_calls[0].name, "read_file"); assert.match(bad.tool_calls[0].error, /not valid JSON/);
});

test("a failed request says which endpoint and what it answered; an unreachable one says how to start a local model", async () => {
  respond = () => ({ status: 404, body: { error: { message: "model 'm' not found" } } });
  await assert.rejects(openaiCompatible({ baseUrl: base, model: "m" })({ messages: [], tools: [] }), /404.*model 'm' not found/s);
  await assert.rejects(openaiCompatible({ baseUrl: "http://127.0.0.1:1/v1", model: "m" })({ messages: [], tools: [] }), /could not reach.*127\.0\.0\.1:1/s);
});
