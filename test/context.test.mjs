// Recoverable context. A bounded window with nothing lost: what leaves the window goes verbatim into a hash-chained store,
// the model is told where it went, and one tool brings any of it back exactly. No step depends on a summary being good.
import { workspace, scripted } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openContext } from "../lib/context.mjs";
import { runTask } from "../lib/loop.mjs";
import { openMemory } from "../lib/memory.mjs";

const sys = { role: "system", content: "S" }, task = { role: "user", content: "the task" };
const body = (i) => `file ${i} says the rate limit is ${100 + i} per minute\n` + "x".repeat(4000) + `\nend of file ${i}`;
const turn = (i) => [{ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/f${i}.js` }) } }] }, { role: "tool", tool_call_id: `c${i}`, content: body(i) }];
const convo = (n) => [sys, task, ...Array.from({ length: n }, (_, i) => turn(i)).flat(), { role: "assistant", content: "latest thought" }];
const noOrphans = (messages) => { const calls = new Set(messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))); for (const m of messages) if (m.role === "tool") assert.ok(calls.has(m.tool_call_id), `orphan tool result ${m.tool_call_id}`); };

test("first, with no model call: old bulky tool results leave the window, each replaced by a line saying what it was and how to get it back", async () => {
  const root = workspace(), ctx = openContext(root, "s1", { budget: 30000, keep: 4 }), model = scripted([{ content: "should not be asked" }]);
  const out = await ctx.fit(convo(12), { model });
  assert.equal(out.changed, true); assert.equal(model.seen.length, 0, "eliding stored output needs no model");
  assert.ok(JSON.stringify(out.messages).length <= 30000); assert.equal(out.messages.length, convo(12).length, "every turn is still there; only bulky bodies moved");
  const stub = out.messages[3].content; assert.match(stub, /^\[stored as ctx-1: read_file src\/f0\.js, 4,0\d\d characters\. recall_context brings it back\]$/);
  assert.equal(out.messages.at(-2).content, body(11), "recent results are untouched"); noOrphans(out.messages);
  assert.deepEqual(ctx.recall({ id: "ctx-1" }), { ok: true, output: body(0) }, "the exact bytes come back");
  assert.equal(ctx.status().stored, out.stored); assert.ok(out.stored >= 6);
});

test("then, if still too big: old turns leave whole; a summary stands in for them; with no working summariser a plain index does, and nothing is lost either way", async () => {
  for (const [name, model] of [["summariser works", scripted([{ content: "NOTES: read thirty files about rate limits." }])], ["summariser is down", async () => { throw new Error("down"); }], ["summariser returns nothing", scripted([{ content: "" }])]]) {
    const root = workspace(), ctx = openContext(root, "s2", { budget: 9000, keep: 4 });
    const out = await ctx.fit(convo(30), { model });
    assert.equal(out.changed, true, name); assert.ok(out.messages.length < 20, name); assert.equal(out.messages[0], sys); assert.equal(out.messages[1], task); assert.equal(out.messages.at(-1).content, "latest thought");
    assert.match(out.messages[2].content, /Earlier turns were moved out of the window/); noOrphans(out.messages);
    if (name === "summariser works") assert.match(out.messages[2].content, /NOTES: read thirty files/); else assert.match(out.messages[2].content, /read_file src\/f0\.js -> ctx-\d+/, `${name}: the record names what was stored`);
    const hit = ctx.recall({ query: "rate limit 117 per minute file 17" }); assert.equal(hit.ok, true, name); assert.ok(hit.output.includes(body(17)), `${name}: a turn that left the window comes back word for word`);
  }
});

test("what leaves whole is stored too: an old note the assistant wrote, or a short result, comes back exactly", async () => {
  const root = workspace(), ctx = openContext(root, "s2b", { budget: 9000, keep: 4 });
  const messages = convo(30); messages.splice(2, 0, { role: "assistant", content: "Decision recorded early: the retry ceiling stays at seven attempts because of the vendor contract." }, { role: "user", content: "agreed, keep seven" });
  const out = await ctx.fit(messages, { model: async () => { throw new Error("down"); } });
  assert.ok(!JSON.stringify(out.messages.slice(0, -4)).includes("vendor contract"), "the note left the window");
  const hit = ctx.recall({ query: "retry ceiling vendor contract" }); assert.equal(hit.ok, true); assert.ok(hit.output.includes("the retry ceiling stays at seven attempts because of the vendor contract."));
  const id = /assistant: Decision recorded early.* -> (ctx-\d+)/.exec(out.messages[2].content)?.[1]; assert.ok(id, "the index names it"); assert.equal(ctx.recall({ id }).output, messages[2].content);
});

test("the store is a hash chain on disk: it survives a new process, and a changed entry is detected and never returned", async () => {
  const root = workspace(), ctx = openContext(root, "s3", { budget: 30000, keep: 4 }); await ctx.fit(convo(12), { model: scripted([{ content: "x" }]) });
  const again = openContext(root, "s3", { budget: 30000, keep: 4 });
  assert.equal(again.verify().ok, true); assert.deepEqual(again.recall({ id: "ctx-2" }), { ok: true, output: body(1) }); assert.equal(again.status().head, ctx.status().head);
  const file = join(root, ".pulse-agent", "sessions", "s3", "context.jsonl"), lines = readFileSync(file, "utf8").split("\n");
  lines[1] = lines[1].replace("101 per minute", "999 per minute"); writeFileSync(file, lines.join("\n"));
  const bad = openContext(root, "s3", { budget: 30000, keep: 4 }); assert.equal(bad.verify().ok, false); assert.match(bad.verify().reason, /ctx-2/);
  const r = bad.recall({ id: "ctx-2" }); assert.equal(r.ok, false); assert.match(r.output, /does not match its hash/);
  assert.equal(bad.recall({ id: "ctx-99" }).ok, false); assert.match(bad.recall({ query: "zebra crossing" }).output, /nothing stored matches/);
});

test("in a run it is seamless: the window stays under budget, the model can recall an exact earlier result, and the ledger records each checkpoint", async () => {
  const root = workspace(); for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.txt`), body(i));
  const script = [...Array.from({ length: 10 }, (_, i) => ({ tool_calls: [["read_file", { path: `f${i}.txt` }]] })),
    { tool_calls: [["recall_context", { query: "rate limit file 2 per minute 102" }]] },
    (m) => { assert.ok(m.at(-1).content.includes(body(2)), "the recalled text is the original"); return { content: "file 2 says 102" }; }];
  const model = scripted(script), events = [];
  const r = await runTask({ root, task: "read every file, then tell me what file 2 says", model, contextBudget: 16000, sessionId: "run1", onEvent: (e) => events.push(e) });
  assert.equal(r.answer, "file 2 says 102"); assert.ok(events.some((e) => e.type === "context"));
  for (const call of model.seen) assert.ok(JSON.stringify(call.messages).length <= 16000 + 6000, `a request carried ${JSON.stringify(call.messages).length} characters`);
  assert.ok(model.seen.at(-1).tools.includes("recall_context"));
  const row = openMemory(root).rows().find((e) => (e.tags ?? []).includes("context")); assert.ok(row, "a checkpoint row is in the ledger"); assert.match(row.note, /run1/); assert.match(row.note, /head [0-9a-f]{12}/);
  assert.equal(r.session, "run1");
});

test("a session is state on disk: a new process resumes it with the same window and the same store", async () => {
  const root = workspace(); writeFileSync(join(root, "a.txt"), body(1));
  const first = scripted([{ tool_calls: [["read_file", { path: "a.txt" }]] }, { content: "I read a.txt" }]);
  const r1 = await runTask({ root, task: "read a.txt", model: first, sessionId: "chat1" });
  const second = scripted([(m) => { assert.equal(m[1].content, "read a.txt"); assert.ok(m.some((x) => x.role === "assistant" && x.content === "I read a.txt"), "the earlier turn is in the window"); assert.equal(m.at(-1).content, "what did it say about the rate limit?"); return { content: "101 per minute" }; }]);
  const r2 = await runTask({ root, task: "what did it say about the rate limit?", model: second, sessionId: "chat1", resume: true });
  assert.equal(r2.answer, "101 per minute"); assert.equal(r2.session, r1.session);
  await assert.rejects(runTask({ root, task: "x", model: second, sessionId: "nope", resume: true }), /no session named nope/);
});

// ---- found by a live run on 2026-11-17 (hosted 70B model, budget 9,000): the model re-read the same six files for 30 steps.
// Each read left the window at once, the note that replaced it did not read as a record of work done, the same bytes were
// stored again on every read (113 entries for 6 files), and the summariser was called on every step.
test("the same content is stored once: reading a file again reuses its id", async () => {
  const root = workspace(), ctx = openContext(root, "d1", { budget: 9000, keep: 2 });
  const twice = [sys, task, ...turn(0), ...turn(0).map((m) => (m.role === "tool" ? { ...m, tool_call_id: "c0b" } : { ...m, tool_calls: [{ ...m.tool_calls[0], id: "c0b" }] })), ...turn(1), { role: "assistant", content: "latest thought" }];
  const out = await ctx.fit(twice, {}); assert.equal(ctx.status().stored, 1, "two reads of one file, one entry");
  assert.equal(out.messages.filter((m) => /^\[stored as ctx-1:/.test(m.content ?? "")).length + (out.messages[2].content.match(/ctx-1:/g) ?? []).length >= 1, true);
});

test("the note that stands in for old turns is a record of work done, and it accumulates: a second eviction keeps the first one's lines and does not store the note itself", async () => {
  const root = workspace(), ctx = openContext(root, "d2", { budget: 9000, keep: 4 }); let asked = 0; const model = async () => { asked++; return { content: "notes", tool_calls: [] }; };
  const first = await ctx.fit(convo(10), { model });
  assert.match(first.messages[2].content, /Work already done/); assert.match(first.messages[2].content, /Do not repeat it/); assert.match(first.messages[2].content, /read_file src\/f0\.js -> ctx-1/);
  const more = [...first.messages.slice(0, -1), ...[20, 21, 22, 23, 24].flatMap((i) => turn(i)), { role: "assistant", content: "latest thought" }];
  const second = await ctx.fit(more, { model });
  assert.match(second.messages[2].content, /read_file src\/f0\.js -> ctx-1/, "the first eviction's record is still in the window"); assert.match(second.messages[2].content, /read_file src\/f20\.js -> ctx-\d+/);
  assert.equal(second.messages.filter((m) => /Work already done/.test(m.content ?? "")).length, 1, "one note, not a pile of them");
  assert.equal(ctx.recall({ query: "Work already done recall_context brings" }).ok, false, "the note is bookkeeping and is not stored as if it were a turn");
});

test("the summariser is asked only when there is enough to summarise; a small eviction costs no model call", async () => {
  const root = workspace(), ctx = openContext(root, "d3", { budget: 9000, keep: 4 }); let asked = 0; const model = async () => { asked++; return { content: "notes", tool_calls: [] }; };
  const first = await ctx.fit(convo(10), { model }); assert.equal(asked, 1);
  const more = [...first.messages.slice(0, -1), ...turn(20), { role: "assistant", content: "latest thought" }];
  await ctx.fit(more, { model }); assert.equal(asked, 1, "two more messages are indexed, not summarised");
});
