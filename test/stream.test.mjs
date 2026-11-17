import "./_helpers.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openaiCompatible } from "../lib/provider.mjs";

let events = [], asJson = null, seen = [], base;
const fake = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
  seen.push(JSON.parse(Buffer.concat(c).toString("utf8")));
  if (asJson) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(asJson)); }
  res.writeHead(200, { "content-type": "text/event-stream" });
  // split the stream at awkward byte positions: an event must survive arriving in pieces
  const all = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""); let i = 0;
  const tick = () => { if (i >= all.length) return res.end(); res.write(all.slice(i, i + 37)); i += 37; setImmediate(tick); }; tick();
}); });
before(async () => { await new Promise((ok) => fake.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${fake.address().port}/v1`; });
after(() => fake.close());
const d = (delta) => ({ choices: [{ delta }] });

test("streamed text arrives piece by piece through onDelta and adds up to the content", async () => {
  events = [d({ role: "assistant", content: "Hel" }), d({ content: "lo, " }), d({ content: "world" }), { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]; asJson = null; seen = [];
  const got = []; const out = await openaiCompatible({ baseUrl: base, model: "m" })({ messages: [{ role: "user", content: "hi" }], tools: [], onDelta: (t) => got.push(t) });
  assert.deepEqual(got, ["Hel", "lo, ", "world"]); assert.deepEqual(out, { content: "Hello, world", tool_calls: [] }); assert.equal(seen[0].stream, true);
});

test("streamed tool calls are assembled from their fragments, several at once, in order", async () => {
  const tc = (index, extra) => d({ tool_calls: [{ index, ...extra }] });
  events = [d({ content: "Reading." }), tc(0, { id: "a", type: "function", function: { name: "read_file", arguments: "" } }), tc(0, { function: { arguments: '{"pa' } }), tc(1, { id: "b", type: "function", function: { name: "run", arguments: '{"command":' } }),
    tc(0, { function: { arguments: 'th":"a.txt"}' } }), tc(1, { function: { arguments: '"ls"}' } }), "[DONE]"]; asJson = null;
  const out = await openaiCompatible({ baseUrl: base, model: "m" })({ messages: [], tools: [], onDelta: () => {} });
  assert.deepEqual(out, { content: "Reading.", tool_calls: [{ id: "a", name: "read_file", args: { path: "a.txt" } }, { id: "b", name: "run", args: { command: "ls" } }] });
});

test("without onDelta nothing is streamed; a server that answers a stream request with plain JSON still works; a broken stream is an error", async () => {
  asJson = { choices: [{ message: { content: "plain" } }] }; seen = [];
  assert.equal((await openaiCompatible({ baseUrl: base, model: "m" })({ messages: [], tools: [] })).content, "plain"); assert.equal(seen[0].stream, undefined);
  const got = []; assert.equal((await openaiCompatible({ baseUrl: base, model: "m" })({ messages: [], tools: [], onDelta: (t) => got.push(t) })).content, "plain"); assert.deepEqual(got, ["plain"]);
  asJson = null; events = [d({ content: "half" }), { error: { message: "model crashed" } }];
  await assert.rejects(openaiCompatible({ baseUrl: base, model: "m" })({ messages: [], tools: [], onDelta: () => {} }), /model crashed/);
});

test("a streamed piece that arrives as a number is text too", async () => {
  // live, 2026-11-17: a hosted endpoint streamed the digits of an answer as JSON numbers and "service 1 is 5 attempts" was saved as "service  is  attempts"
  events = [d({ content: "service " }), d({ content: 1 }), d({ content: " is " }), d({ content: 5 }), d({ content: 0 }), d({ content: " attempts" }), "[DONE]"]; asJson = null;
  const got = []; const out = await openaiCompatible({ baseUrl: base, model: "m" })({ messages: [], tools: [], onDelta: (t) => got.push(t) });
  assert.equal(out.content, "service 1 is 50 attempts"); assert.equal(got.join(""), "service 1 is 50 attempts");
});
