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

// ---- from the 2026-11-17 token survey (docs/internal-TOKENS, sources there): defects in the first cut of the above
test("inside a script a tool returns the whole result, so a script can filter a large file; only what it prints is capped", async () => {
  const root = workspace(); writeFileSync(join(root, "big.log"), Array.from({ length: 4000 }, (_, i) => (i === 137 ? "ERROR disk full on node-7" : `info line ${i} ok`)).join("\n"));
  const model = scripted([{ tool_calls: [["script", { code: `const t = await tools.read_file({ path: "big.log" }); const lines = t.split("\\n"); print(lines.length + " lines; " + lines.filter((l) => l.startsWith("ERROR")).join(" | "));` }]] }, { content: "x" }]);
  await runTask({ root, task: "t", model });
  assert.match(model.seen[1].messages.at(-1).content, /4000 lines; ERROR disk full on node-7/);
});

test("read_file pages: the start of a long file with what remains, and any range on request; search and list_files are capped and say what was cut", async () => {
  const { execute } = await import("../lib/tools.mjs"); const { ROLES } = await import("../lib/roles.mjs"); const { openMemory } = await import("../lib/memory.mjs");
  const root = workspace(), ctx = { root, role: ROLES.builder, memory: openMemory(root) };
  writeFileSync(join(root, "long.txt"), Array.from({ length: 900 }, (_, i) => `line ${i + 1} of the long file with some padding text`).join("\n"));
  const head = await execute("read_file", { path: "long.txt" }, ctx); assert.match(head.output, /^line 1 of/); assert.ok(head.output.length <= 6400); assert.match(head.output, /\[lines 1-\d+ of 900; read_file with offset \d+ for more\]/);
  const mid = await execute("read_file", { path: "long.txt", offset: 500, limit: 3 }, ctx); assert.equal(mid.output, "line 500 of the long file with some padding text\nline 501 of the long file with some padding text\nline 502 of the long file with some padding text\n[lines 500-502 of 900; read_file with offset 503 for more]");
  const small = await execute("read_file", { path: "long.txt", offset: 899 }, ctx); assert.match(small.output, /line 900/); assert.ok(!/for more/.test(small.output));
  for (let i = 0; i < 300; i++) writeFileSync(join(root, `file-with-a-fairly-long-name-${String(i).padStart(3, "0")}.txt`), "needle here\n");
  const s = await execute("search", { pattern: "needle" }, ctx); assert.ok(s.output.length <= 6400, `search returned ${s.output.length}`); assert.match(s.output, /more match/);
  const l = await execute("list_files", {}, ctx); assert.ok(l.output.length <= 6400, `list returned ${l.output.length}`); assert.match(l.output, /\d+ more file/);
});

test("the tool list is the same bytes on every request of a session, so a provider's prompt cache keeps hitting: recall is offered from the start and connector tools are in name order", async () => {
  const root = workspace(); for (let i = 0; i < 4; i++) writeFileSync(join(root, `f${i}.txt`), "x".repeat(5000));
  const conn = { failed: [], tools: ["zeta", "alpha", "mid"].map((n) => ({ type: "function", function: { name: `mcp__c__${n}`, description: n, parameters: { type: "object", properties: {} } } })), async call() { return { ok: true, output: "" }; }, close() {} };
  const seenTools = []; const base = scripted([...[0, 1, 2, 3].map((i) => ({ tool_calls: [["read_file", { path: `f${i}.txt` }]] })), { content: "done" }]);
  const model = async (a) => { seenTools.push(JSON.stringify(a.tools)); return base(a); };
  const r = await runTask({ root, task: "read them", model, contextBudget: 9000, connectors: conn });
  assert.equal(r.answer, "done"); assert.ok(new Set(seenTools).size === 1, "one tool list for the whole session, before and after material left the window");
  const names = JSON.parse(seenTools[0]).map((t) => t.function.name); assert.ok(names.includes("recall_context")); assert.deepEqual(names.filter((n) => n.startsWith("mcp__")), ["mcp__c__alpha", "mcp__c__mid", "mcp__c__zeta"]);
});

test("find_tool matches on argument names and returns the whole schema; a subagent's report is capped; cached tokens are counted when reported", async () => {
  const tools = Array.from({ length: 20 }, (_, i) => ({ type: "function", function: { name: `mcp__x__t${i}`, description: `generic thing ${i}`, parameters: { type: "object", properties: i === 9 ? { invoice_number: { type: "string", description: "the invoice to fetch ".repeat(40) }, currency: { type: "string" } } : { id: { type: "string" } }, required: [] } } }));
  const conn = { failed: [], tools, async call() { return { ok: true, output: "" }; }, close() {} };
  const m = scripted([{ tool_calls: [["find_tool", { query: "invoice number" }]] }, { content: "x" }]); await runTask({ root: workspace(), task: "t", model: m, connectors: conn });
  const found = m.seen[1].messages.at(-1).content; assert.match(found, /mcp__x__t9/); assert.match(found, /"currency"/, "the schema is not cut");
  const root = workspace(); const big = async ({ tools: ts }) => (ts.some((t) => t.function.name === "delegate") ? null : { content: "report ".repeat(3000), tool_calls: [] });
  const parent = scripted([{ tool_calls: [["delegate", { role: "scout", task: "look" }]] }, { content: "ok" }]); const both = async (a) => (await big(a)) ?? parent(a);
  await runTask({ root, task: "t", model: both }); const rep = parent.seen[1].messages.at(-1).content; assert.ok(rep.length < 6500, `a subagent's report came back at ${rep.length} characters`); assert.match(rep, /report cut/);
  const cached = async () => ({ content: "hi", tool_calls: [], usage: { input: 1000, output: 5, cached: 900 } }); const r = await runTask({ root: workspace(), task: "t", model: cached }); assert.equal(r.usage.cached, 900);
});

test("a connector that lists its tools in pages is read to the end", async () => {
  const { connectAll } = await import("../lib/mcp.mjs");
  const srv2 = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { const m = JSON.parse(Buffer.concat(c).toString("utf8") || "{}"); if (m.id === undefined) { res.writeHead(202); return res.end(); }
    const tool = (n) => ({ name: n, inputSchema: { type: "object", properties: {} } });
    const result = m.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {} } : m.method === "tools/list" ? (m.params?.cursor === "p2" ? { tools: [tool("c"), tool("d")] } : { tools: [tool("a"), tool("b")], nextCursor: "p2" }) : {};
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); }); });
  await new Promise((ok) => srv2.listen(0, "127.0.0.1", ok));
  try { const set = await connectAll({ p: { url: `http://127.0.0.1:${srv2.address().port}/mcp` } }); assert.deepEqual(set.tools.map((t) => t.function.name), ["mcp__p__a", "mcp__p__b", "mcp__p__c", "mcp__p__d"]); set.close(); } finally { srv2.close(); }
});
