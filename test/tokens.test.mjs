// Token cost. Three measures, each with the number that shows it: (1) usage is counted, so a saving can be seen; (2) code
// over tools: the model writes a script that calls tools and prints only what it needs, so intermediate results never enter
// the conversation; (3) a large set of connector tools is searched on demand instead of being sent in every request.
import { workspace, scripted } from "./_helpers.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../lib/loop.mjs";
import { openaiCompatible } from "../lib/provider.mjs";
import { scriptAvailable, runScript } from "../lib/script.mjs";
import { makePolicy } from "../lib/approve.mjs";

let srv, base, mode = "json";
before(async () => { srv = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { const b = JSON.parse(Buffer.concat(c).toString("utf8"));
  if (b.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`); if (b.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } })}\n\n`); return res.end("data: [DONE]\n\n"); }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], ...(mode === "json" ? { usage: { prompt_tokens: 100, completion_tokens: 5 } } : {}) })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${srv.address().port}/v1`; });
after(() => srv.close());

test("usage is counted when the endpoint reports it, streamed or not, and a run adds it up; an endpoint that reports none is shown as unknown, not zero", async () => {
  const m = openaiCompatible({ baseUrl: base, model: "m" });
  assert.deepEqual((await m({ messages: [], tools: [] })).usage, { input: 100, output: 5 });
  assert.deepEqual((await m({ messages: [], tools: [], onDelta: () => {} })).usage, { input: 120, output: 7 });
  const root = workspace(); const r = await runTask({ root, task: "say hi", model: m }); assert.deepEqual(r.usage, { input: 100, output: 5, calls: 1, reported: 1 });
  mode = "none"; const r2 = await runTask({ root: workspace(), task: "say hi", model: m }); assert.deepEqual(r2.usage, { input: null, output: null, calls: 1, reported: 0 }); mode = "json";
});

test("the script sandbox is confirmed before it is offered: no file writes, no reading outside its own folder, no child processes, no network", async () => {
  const s = await scriptAvailable(); assert.equal(s.ok, true, s.reason);
  assert.deepEqual(s.denied.sort(), ["network", "read", "spawn", "write"]);
});

test("a script calls tools and prints only what it needs: the files it read never enter the conversation", async () => {
  const root = workspace(); for (let i = 0; i < 6; i++) writeFileSync(join(root, `notes${i}.txt`), `Service ${i}.\nThe retry ceiling for service ${i} is ${3 + i * 2} attempts.\n` + "filler line lorem ipsum dolor\n".repeat(150));
  const code = `const files = (await tools.list_files({})).split("\\n").filter((f) => f.startsWith("notes"));
let best = null;
for (const f of files) { const t = await tools.read_file({ path: f }); const m = /service (\\d+) is (\\d+) attempts/.exec(t); if (m && (!best || +m[2] > best.n)) best = { f, n: +m[2] }; }
print(best.f + " has the highest ceiling: " + best.n);`;
  const model = scripted([{ tool_calls: [["script", { code }]] }, { content: "notes5.txt, 13 attempts" }]);
  const r = await runTask({ root, task: "which service has the highest retry ceiling?", model });
  const result = model.seen[1].messages.at(-1).content; assert.match(result, /notes5\.txt has the highest ceiling: 13/);
  assert.ok(result.length < 200, `the script returned ${result.length} characters`);
  const sent = JSON.stringify(model.seen[1].messages); assert.ok(!sent.includes("filler line lorem"), "no file body reached the model"); assert.ok(sent.length < 6000, `${sent.length} characters in the request against about 27,000 for six direct reads`);
  assert.ok(model.seen[0].tools.includes("script")); assert.equal(r.answer, "notes5.txt, 13 attempts");
});

test("a script has no more rights than the tools: its own code cannot write, spawn or reach the network, and each tool call inside it passes the same gate", async () => {
  const root = workspace(); const ctx = { tools: { read_file: async () => ({ ok: true, output: "x" }) } };
  const direct = await runScript(`import("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(join(root, "escaped.txt"))}, "x")).catch((e) => print("write: " + e.code));\nawait new Promise((r) => setTimeout(r, 50));\ntry { (await import("node:child_process")).execSync("touch ${join(root, "spawned.txt")}"); } catch (e) { print("spawn: " + e.code); }`, { call: async () => ({ ok: true, output: "" }) });
  assert.match(direct.output, /write: ERR_ACCESS_DENIED/); assert.match(direct.output, /spawn: ERR_ACCESS_DENIED/); assert.equal(existsSync(join(root, "escaped.txt")), false); assert.equal(existsSync(join(root, "spawned.txt")), false);
  const model = scripted([{ tool_calls: [["script", { code: `const r = await tools.run({ command: "touch via-script.txt" }).catch((e) => "refused: " + e.message); print(r); const w = await tools.write_file({ path: "ok.txt", content: "fine" }); print(w);` }]] }, { content: "done" }]);
  const r = await runTask({ root, task: "t", model, policy: makePolicy({ mode: "ask", allow: ["edit:*"] }) });
  const out = model.seen[1].messages.at(-1).content; assert.match(out, /refused: .*no rule allows/); assert.match(out, /wrote ok\.txt/);
  assert.equal(existsSync(join(root, "via-script.txt")), false); assert.equal(existsSync(join(root, "ok.txt")), true); assert.deepEqual(r.changed, ["ok.txt"]); assert.equal(r.refused, 1);
});

test("a script that throws, loops or floods is contained: the error is reported, the time limit holds, the output is capped, and it cannot call itself or delegate", async () => {
  const call = async () => ({ ok: true, output: "x" });
  const boom = await runScript(`throw new Error("bad thing")`, { call }); assert.equal(boom.ok, false); assert.match(boom.output, /bad thing/);
  const t0 = Date.now(); const loop = await runScript(`for (;;) {}`, { call, timeoutMs: 400 }); assert.equal(loop.ok, false); assert.match(loop.output, /time limit/); assert.ok(Date.now() - t0 < 4000);
  const flood = await runScript(`print("y".repeat(100000))`, { call }); assert.ok(flood.output.length < 7000);
  const nested = await runScript(`print(Object.keys(tools).sort().join(","))`, { call, names: ["read_file", "search"] }); assert.equal(nested.output.trim(), "read_file,search");
  const root = workspace(); const model = scripted([{ tool_calls: [["script", { code: `print(Object.keys(tools).join(","))` }]] }, { content: "x" }]); await runTask({ root, task: "t", model });
  const names = model.seen[1].messages.at(-1).content; assert.ok(!/script|delegate|apply_work|propose_skill/.test(names), names); assert.match(names, /read_file/);
});

test("many connector tools are found on demand, not sent in every request; a few are sent as they are", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ type: "function", function: { name: `mcp__big__tool_${i}`, description: i === 17 ? "Look up an invoice by its number in the billing system." : `Does unrelated thing number ${i} with a long description that costs tokens every single request. `.repeat(3), parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } }));
  const calls = []; const fakeMcp = { failed: [], tools: many, async call(name, args) { calls.push([name, args]); return { ok: true, output: `called ${name}` }; }, close() {} };
  const root = workspace();
  const model = scripted([{ tool_calls: [["find_tool", { query: "invoice number billing" }]] }, { tool_calls: [["call_tool", { name: "mcp__big__tool_17", args: { id: "A-1" } }]] }, { tool_calls: [["call_tool", { name: "mcp__big__nope", args: {} }]] }, { content: "done" }]);
  await runTask({ root, task: "find invoice A-1", model, connectors: fakeMcp });
  assert.ok(!model.seen[0].tools.some((t) => t.startsWith("mcp__")), "the 40 schemas are not in the request"); assert.ok(model.seen[0].tools.includes("find_tool") && model.seen[0].tools.includes("call_tool"));
  const found = model.seen[1].messages.at(-1).content; assert.match(found, /mcp__big__tool_17/); assert.match(found, /invoice/); assert.match(found, /"id"/, "the schema comes with the match"); assert.ok(found.length < 1500);
  assert.match(model.seen[2].messages.at(-1).content, /called mcp__big__tool_17/); assert.deepEqual(calls, [["mcp__big__tool_17", { id: "A-1" }]]); assert.match(model.seen[3].messages.at(-1).content, /no connector tool named/);
  const few = { ...fakeMcp, tools: many.slice(0, 3) }; const m2 = scripted([{ content: "x" }]); await runTask({ root: workspace(), task: "t", model: m2, connectors: few });
  assert.ok(m2.seen[0].tools.includes("mcp__big__tool_0") && !m2.seen[0].tools.includes("find_tool"));
  const denied = scripted([{ tool_calls: [["call_tool", { name: "mcp__big__tool_17", args: { id: "A-1" } }]] }, { content: "x" }]); const r = await runTask({ root: workspace(), task: "t", model: denied, connectors: fakeMcp, policy: makePolicy({ mode: "ask" }) });
  assert.equal(r.refused, 1, "a call through call_tool is gated as the connector tool it names");
});

test("a script may make at most 200 tool calls; the next one fails inside the script and no more reach the tools", async () => {
  let made = 0; const r = await runScript(`let ok = 0, bad = ""; for (let i = 0; i < 205; i++) { try { await tools.read_file({ path: "a" }); ok++; } catch (e) { bad = e.message; } } print(ok + " ok; then: " + bad);`, { names: ["read_file"], call: async () => { made++; return { ok: true, output: "x" }; } });
  assert.match(r.output, /200 ok; then: a script may make at most 200 tool calls/); assert.equal(made, 200);
});
