// Gaps closed from the 2026-11-17 survey: background commands, session fork, connectors over HTTP.
import { workspace, scripted } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJobs } from "../lib/jobs.mjs";
import { runTask } from "../lib/loop.mjs";
import { makePolicy, classOf } from "../lib/approve.mjs";
import { openContext, forkSession } from "../lib/context.mjs";
import { connectAll } from "../lib/mcp.mjs";

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

test("a background command keeps running while the agent does other things; its output is read in pieces; kill stops it and everything it started", async () => {
  const root = workspace(), jobs = createJobs({ cwd: root });
  const a = jobs.start("echo one; sleep 0.3; echo two"); assert.equal(a.ok, true); assert.match(a.output, /bg-1/);
  await wait(120); const r1 = jobs.read("bg-1"); assert.match(r1.output, /one/); assert.match(r1.output, /still running/);
  await wait(450); const r2 = jobs.read("bg-1"); assert.match(r2.output, /two/); assert.ok(!/one/.test(r2.output), "only what is new since the last read"); assert.match(r2.output, /exited with code 0/);
  const b = jobs.start("echo $$ > pid.txt; sleep 30 & echo $! > child.txt; wait"); await wait(200);
  const pids = ["pid.txt", "child.txt"].map((f) => Number(readFileSync(join(root, f), "utf8"))); assert.equal(jobs.kill("bg-2").ok, true); await wait(150);
  for (const p of pids) assert.ok(gone(p), `process ${p} is gone`);
  assert.equal(jobs.read("bg-9").ok, false); assert.equal(jobs.kill("bg-9").ok, false);
  for (let i = 0; i < 4; i++) jobs.start("sleep 30"); const over = jobs.start("sleep 30"); assert.equal(over.ok, false); assert.match(over.output, /at most 4/);
  jobs.killAll(); await wait(150); assert.equal(jobs.running(), 0);
});

test("in a run: starting one needs the same approval as any command, and whatever is still running when the run ends is stopped", async () => {
  assert.deepEqual(classOf("run_background", { command: "npm run dev" }), ["run", "npm run dev"]); assert.equal(classOf("read_output", {}), null); assert.equal(classOf("kill_command", {}), null);
  const root = workspace();
  const model = scripted([{ tool_calls: [["run_background", { command: "echo $$ > pid.txt; echo started; sleep 30" }]] }, { tool_calls: [["read_output", { id: "bg-1" }]] }, { content: "left it running" }]);
  const denied = await runTask({ root, task: "t", model: scripted([{ tool_calls: [["run_background", { command: "sleep 30" }]] }, { content: "x" }]), policy: makePolicy({ mode: "ask" }) }); assert.equal(denied.refused, 1);
  const paced = async (x) => { await wait(150); return model(x); };                    // a real model takes time between calls; the command has printed by then
  const r = await runTask({ root, task: "start a server", model: paced }); assert.equal(r.answer, "left it running");
  assert.match(model.seen[2].messages.at(-1).content, /started/);
  await wait(150); assert.ok(gone(Number(readFileSync(join(root, "pid.txt"), "utf8"))), "the run ended, so its background command was stopped");
});

test("a session can be forked at an earlier turn: both continue separately, and the fork's store still verifies", async () => {
  const root = workspace();
  for (const [i, q] of ["one", "two", "three"].entries()) await runTask({ root, task: q, model: scripted([{ content: `answer ${q}` }]), sessionId: "main", resume: i > 0 });
  const f = forkSession(root, "main", { at: 2, name: "branch" }); assert.equal(f.ok, true); assert.equal(f.turns, 2);
  const msgs = openContext(root, "branch").load(); assert.deepEqual(msgs.filter((m) => m.role === "user").map((m) => m.content), ["one", "two"]); assert.equal(msgs.at(-1).content, "answer two");
  assert.equal(openContext(root, "branch").verify().ok, true); assert.equal(openContext(root, "main").load().filter((m) => m.role === "user").length, 3, "the original is untouched");
  const cont = scripted([(m) => ({ content: `saw ${m.filter((x) => x.role === "user").map((x) => x.content).join(",")}` })]);
  assert.equal((await runTask({ root, task: "other", model: cont, sessionId: "branch", resume: true })).answer, "saw one,two,other");
  assert.equal(forkSession(root, "nope", { at: 1, name: "x" }).ok, false); assert.equal(forkSession(root, "main", { at: 9, name: "y" }).ok, false); assert.equal(forkSession(root, "main", { at: 1, name: "branch" }).ok, false, "a fork never overwrites a session");
});

test("a connector over HTTP: JSON or event-stream replies, the session header carried, headers from the config, and an error status reported", async () => {
  const seen = []; let sse = false;
  const srv = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
    const m = JSON.parse(Buffer.concat(c).toString("utf8") || "{}"); seen.push({ method: m.method, session: req.headers["mcp-session-id"], auth: req.headers.authorization, accept: req.headers.accept });
    if (req.url === "/down") { res.writeHead(503); return res.end("unavailable"); }
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    const result = m.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} } } : m.method === "tools/list" ? { tools: [{ name: "lookup", description: "Look a thing up.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] } : { content: [{ type: "text", text: `found ${m.params.arguments.q}` }] };
    const body = JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), h = m.method === "initialize" ? { "mcp-session-id": "sess-7" } : {};
    if (sse) { res.writeHead(200, { "content-type": "text/event-stream", ...h }); res.end(`event: message\ndata: ${body}\n\n`); } else { res.writeHead(200, { "content-type": "application/json", ...h }); res.end(body); }
  }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (sse of [false, true]) {
      seen.length = 0; const set = await connectAll({ kb: { url: `${url}/mcp`, headers: { authorization: "Bearer t0k" } }, down: { url: `${url}/down` } }, { timeoutMs: 2000 });
      try {
        assert.deepEqual(set.tools.map((t) => t.function.name), ["mcp__kb__lookup"]); assert.equal(set.failed.length, 1); assert.match(set.failed[0].reason, /503/);
        assert.deepEqual(await set.call("mcp__kb__lookup", { q: "x" }), { ok: true, output: "found x" });
        const call = seen.find((s) => s.method === "tools/call" && s.session); assert.equal(call.session, "sess-7"); assert.equal(call.auth, "Bearer t0k"); assert.match(call.accept, /application\/json/); assert.match(call.accept, /text\/event-stream/);
      } finally { set.close(); }
    }
  } finally { srv.close(); }
});

test("a connector's token comes from the environment, not from the project file: ${NAME} is filled in at connect time, and a name that is not set stops the connector", async () => {
  const seen = []; const srv = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { const m = JSON.parse(Buffer.concat(c).toString("utf8") || "{}"); seen.push(req.headers.authorization); if (m.id === undefined) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "tools/list" ? { tools: [{ name: "t", inputSchema: { type: "object" } }] } : { protocolVersion: "2024-11-05", capabilities: {} } })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  try {
    process.env.PA_TEST_TOKEN = "s3cret-value";
    const set = await connectAll({ a: { url, headers: { authorization: "Bearer ${PA_TEST_TOKEN}" } }, b: { url, headers: { authorization: "Bearer ${PA_TEST_NOT_SET}" } } });
    assert.deepEqual(set.tools.map((t) => t.function.name), ["mcp__a__t"]); assert.ok(seen.every((h) => h === "Bearer s3cret-value"), "the literal placeholder was never sent");
    assert.equal(set.failed.length, 1); assert.match(set.failed[0].reason, /PA_TEST_NOT_SET is not set/); assert.ok(!set.failed[0].reason.includes("s3cret")); set.close();
  } finally { srv.close(); delete process.env.PA_TEST_TOKEN; }
});
