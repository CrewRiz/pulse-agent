import { workspace } from "./_helpers.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CLI = join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
// async on purpose: the fake model lives in this process, and a synchronous spawn would block the loop that answers it
const run = (cwd, args, env = {}) => new Promise((done) => execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 30000 }, (err, stdout, stderr) => done({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })));
let script = [], calls = 0, base;
const fake = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { const m = script[Math.min(calls++, script.length - 1)]; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: m }] })); }); });
before(async () => { await new Promise((ok) => fake.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${fake.address().port}/v1`; });
after(() => fake.close());
const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name, arguments: JSON.stringify(args) } }] });

test("help names every command; an unknown command and a run without a model say what to do and exit 1", async () => {
  const root = workspace();
  const h = await run(root, ["--help"]); assert.equal(h.code, 0); for (const w of ["run", "skills", "lessons", "sync", "state export", "--verify", "--role", "--no-learned", "PULSE_AGENT_MODEL", "MEMORY_PULSE_KEY", "init", "team", "connectors", "chat", "sessions", "trust", "allow", "--yes"]) assert.match(h.out, new RegExp(w));
  const u = await run(root, ["frobnicate"]); assert.equal(u.code, 1); assert.match(u.out, /unknown command/);
  const n = await run(root, ["run", "do a thing"]); assert.equal(n.code, 1); assert.match(n.out, /pulse-agent init/);
});

test("run: a task goes through a real HTTP model endpoint, the check decides, and the exit code is the verdict", async () => {
  const root = workspace(); script = [call("write_file", { path: "out.txt", content: "42" }), { role: "assistant", content: "wrote it" }]; calls = 0;
  const ok = await run(root, ["run", "write 42 to out.txt", "--model", "m", "--base-url", base, "--verify", 'test "$(cat out.txt)" = 42']);
  assert.equal(ok.code, 0, ok.out); assert.equal(readFileSync(join(root, "out.txt"), "utf8"), "42"); assert.match(ok.out, /verdict: pass/); assert.match(ok.out, /out\.txt/);
  script = [{ role: "assistant", content: "done" }]; calls = 0;
  const bad = await run(root, ["run", "do nothing", "--model", "m", "--base-url", base, "--verify", "exit 1", "--max-rounds", "1"]);
  assert.equal(bad.code, 2, bad.out); assert.match(bad.out, /verdict: fail/);
  const les = await run(root, ["lessons"]); assert.equal(les.code, 0); assert.match(les.out, /no lessons yet|lesson/i);
});

test("skills: list shows what waits for review, accept and reject move it, and a name that is not there exits 1", async () => {
  const root = workspace(); const dir = join(root, ".pulse-agent", "skills", "proposed"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "release-checklist.md"), "# release-checklist\n\nWhen: cutting a release\n\n1. test\n"); writeFileSync(join(dir, "old-idea.md"), "# old-idea\n\nWhen: never\n\nx\n");
  const l = await run(root, ["skills"]); assert.match(l.out, /proposed.*release-checklist/s); assert.match(l.out, /skills accept/);
  assert.equal((await run(root, ["skills", "show", "release-checklist"])).out.includes("cutting a release"), true);
  assert.equal((await run(root, ["skills", "accept", "release-checklist"])).code, 0); assert.ok(existsSync(join(root, ".pulse-agent", "skills", "accepted", "release-checklist.md")));
  assert.equal((await run(root, ["skills", "reject", "old-idea"])).code, 0); assert.equal(existsSync(join(dir, "old-idea.md")), false);
  assert.equal((await run(root, ["skills", "accept", "nope"])).code, 1);
});

test("sync: the agent's state is committed to git in the workspace; with no remote it says so and pushes nothing", async () => {
  const root = workspace(); mkdirSync(join(root, ".pulse-agent", "skills", "accepted"), { recursive: true }); writeFileSync(join(root, ".pulse-agent", "skills", "accepted", "a.md"), "# a\n\nWhen: w\n\ns\n");
  writeFileSync(join(root, ".memory-pulse", "events.jsonl"), ""); writeFileSync(join(root, "secret.env"), "KEY=1");
  const s = await run(root, ["sync"], { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" });
  assert.equal(s.code, 0, s.out); assert.match(s.out, /committed/); assert.match(s.out, /no remote/);
  const files = await new Promise((done) => execFile("git", ["ls-files"], { cwd: root, encoding: "utf8" }, (_e, o) => done(o)));
  assert.match(files, /\.pulse-agent\/skills\/accepted\/a\.md/); assert.match(files, /\.memory-pulse\/events\.jsonl/); assert.ok(!/secret\.env/.test(files), "only the agent's own state is staged");
  const again = await run(root, ["sync"]); assert.equal(again.code, 0); assert.match(again.out, /nothing new/);
});

test("state: export writes a packed .rain capsule, verify checks it, import restores the ledger into an empty project and refuses a damaged file", async () => {
  const { openMemory } = await import("../lib/memory.mjs"); const { readdirSync, statSync, copyFileSync } = await import("node:fs");
  const root = workspace(), mem = openMemory(root);
  for (let i = 0; i < 40; i++) mem.remember({ cause: `task-${i}`, effect: i % 2 ? "verified-pass" : "verify-failed", tags: ["pulse-agent", "run"], note: `builder run ${i}: the check passed after ${i % 3} round(s); files changed: src/a${i % 5}.js` });
  const e = await run(root, ["state", "export"]); assert.equal(e.code, 0, e.out); assert.match(e.out, /40 row\(s\)/); assert.match(e.out, /packed/);
  const dir = join(root, ".pulse-agent", "state"), file = join(dir, readdirSync(dir).find((f) => f.endsWith(".rainz")));
  assert.ok(statSync(file).size < statSync(join(root, ".memory-pulse", "events.jsonl")).size, "the packed capsule is smaller than the ledger it carries");
  const v = await run(root, ["state", "verify", file]); assert.equal(v.code, 0, v.out); assert.match(v.out, /verified.*40 row/s);
  const fresh = workspace(); const i = await run(fresh, ["state", "import", file]); assert.equal(i.code, 0, i.out); assert.match(i.out, /installed/);
  assert.equal(openMemory(fresh).rows().filter((r) => /^task-/.test(r.cause)).length, 40);
  const again = await run(fresh, ["state", "import", file]); assert.equal(again.code, 0); assert.match(again.out, /unchanged|ahead/);
  const bad = join(dir, "bad.rainz"); copyFileSync(file, bad); const { openSync, writeSync, closeSync } = await import("node:fs"); const fd = openSync(bad, "r+"); writeSync(fd, Buffer.from([0x5a]), 0, 1, statSync(bad).size - 9); closeSync(fd);
  const no = await run(workspace(), ["state", "import", bad]); assert.equal(no.code, 1); assert.match(no.out, /does not match|corrupt/);
  const none = await run(workspace(), ["state", "export"]); assert.equal(none.code, 1); assert.match(none.out, /no ledger/);
});

test("init then run: a project is set up from a running model server with no flags, and run needs none either", async () => {
  // the fake answers /v1/models too, and calls whatever tool it is offered when the script says so
  const models = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { res.setHeader("content-type", "application/json"); if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "local-coder" }] })); const b = JSON.parse(Buffer.concat(c).toString("utf8")); const t = b.tools?.[0]?.function?.name; const said = b.messages.some((m) => m.role === "tool"); res.end(JSON.stringify({ choices: [{ message: t === "report_ready" ? { content: "", tool_calls: [{ id: "c", type: "function", function: { name: t, arguments: "{}" } }] } : said ? { content: "done" } : call("write_file", { path: "ok.txt", content: "ok" }) }] })); }); });
  await new Promise((ok) => models.listen(0, "127.0.0.1", ok)); const url = `http://127.0.0.1:${models.address().port}/v1`;
  try {
    const root = workspace(); writeFileSync(join(root, "Makefile"), "test:\n\ttest -f ok.txt\n");
    const i = await run(root, ["init", "--base-url", url]); assert.equal(i.code, 0, i.out); assert.match(i.out, /local-coder: calls tools/); assert.match(i.out, /make test/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".pulse-agent", "config.json"), "utf8")), { model: "local-coder", baseUrl: url, verify: "make test" });
    const r = await run(root, ["run", "create ok.txt"]); assert.equal(r.code, 0, r.out); assert.match(r.out, /verdict: pass/); assert.ok(existsSync(join(root, "ok.txt")));
    const t = await run(root, ["team", "create ok.txt again"]); assert.equal(t.code, 0, t.out); assert.match(t.out, /\[builder\]/); assert.match(t.out, /evaluator's review|no review/);
    const none = await run(workspace(), ["init", "--base-url", "http://127.0.0.1:1/v1"]); assert.equal(none.code, 1); assert.match(none.out, /No local model server/);
  } finally { models.close(); }
});

test("connectors: lists each configured MCP server's tools, names one that fails, and says how to add one when there are none", async () => {
  const root = workspace(); const fake = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-mcp.mjs");
  assert.match((await run(root, ["connectors"])).out, /no connectors configured/);
  mkdirSync(join(root, ".pulse-agent"), { recursive: true }); writeFileSync(join(root, ".pulse-agent", "config.json"), JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [fake], tools: ["echo"] }, gone: { command: "/nonexistent/x" } } }));
  const held = await run(root, ["connectors"]); assert.equal(held.code, 1); assert.match(held.out, /not started until you trust it/);
  assert.match((await run(root, ["trust"])).out, /now loaded on each run: connectors/);
  const c = await run(root, ["connectors"]); assert.equal(c.code, 1); assert.match(c.out, /files: echo/); assert.match(c.out, /gone: FAILED/);
});

test("chat: an interactive session streams each reply, keeps the conversation across turns, and can be resumed by a new process", async () => {
  const bodies = []; let n = 0;
  const srv = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { const b = JSON.parse(Buffer.concat(c).toString("utf8")); bodies.push(b); n++;
    res.writeHead(200, { "content-type": "text/event-stream" }); for (const piece of [`reply `, `number `, `${n}`]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`); res.end("data: [DONE]\n\n"); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const url = `http://127.0.0.1:${srv.address().port}/v1`;
  const chat = (cwd, args, input) => new Promise((done) => { const p = execFile(process.execPath, [CLI, "chat", "--model", "m", "--base-url", url, ...args], { cwd, env: process.env, encoding: "utf8", timeout: 30000 }, (err, stdout, stderr) => done({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })); p.stdin.end(input); });
  try {
    const root = workspace();
    const a = await chat(root, [], "first question\n/session\nsecond question\n/context\n/exit\n");
    assert.equal(a.code, 0, a.out); assert.match(a.out, /reply number 1/); assert.match(a.out, /reply number 2/); assert.match(a.out, /nothing has left the window/);
    assert.equal(bodies[0].stream, true); assert.equal(bodies[1].messages.filter((m) => m.role === "user").map((m) => m.content).join("|"), "first question|second question");
    assert.ok(bodies[1].messages.some((m) => m.role === "assistant" && m.content === "reply number 1"), "the first reply is in the second request");
    const id = /session: (s-[A-Za-z0-9-]+)/.exec(a.out)?.[1]; assert.ok(id, a.out);
    const ls = await run(root, ["sessions"]); assert.match(ls.out, new RegExp(id));
    const b = await chat(root, ["--resume", id], "third question\n"); assert.equal(b.code, 0, b.out); assert.match(b.out, /reply number 3/);
    assert.equal(bodies[2].messages.filter((m) => m.role === "user").length, 3, "a resumed chat carries the earlier turns");
    const none = await chat(root, ["--resume", "nope"], "x\n"); assert.equal(none.code, 1); assert.match(none.out, /no session named nope/);
    const { openMemory } = await import("../lib/memory.mjs"); assert.equal(openMemory(root).rows().filter((e) => (e.tags ?? []).includes("run")).length, 0, "a chat turn that changed no file writes no run row");
  } finally { srv.close(); }
});

test("approvals from the command line: a command the model wants to run is refused until a rule, or --yes, allows it; edits in the project are allowed", async () => {
  const bodies = []; let step = 0;
  const srv = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { bodies.push(JSON.parse(Buffer.concat(c).toString("utf8"))); const m = [call("write_file", { path: "a.txt", content: "x" }), call("run", { command: "touch made.txt" }), { role: "assistant", content: "done" }][Math.min(step++, 2)]; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: m }] })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const url = `http://127.0.0.1:${srv.address().port}/v1`;
  try {
    const root = workspace(), args = ["run", "do it", "--model", "m", "--base-url", url];
    const a = await run(root, args); assert.equal(a.code, 0, a.out); assert.ok(existsSync(join(root, "a.txt"))); assert.equal(existsSync(join(root, "made.txt")), false); assert.match(a.out, /refused run touch made\.txt/); assert.match(a.out, /1 tool call\(s\) were refused/);
    assert.match(bodies[2].messages.at(-1).content, /no rule allows/);
    step = 0; assert.match((await run(root, ["allow", "run:touch made.txt"])).out, /run:touch made\.txt/);
    await run(root, args); assert.ok(existsSync(join(root, "made.txt")), "the saved rule allows exactly that command");
    const other = workspace(); step = 0; await run(other, [...args, "--yes"]); assert.ok(existsSync(join(other, "made.txt")), "--yes allows everything for one run");
    assert.equal((await run(root, ["allow", "anything goes"])).code, 1);
  } finally { srv.close(); }
});

test("trust from the command line: a project's AGENTS.md reaches the model only after `pulse-agent trust`, and --revoke takes it away", async () => {
  const bodies = []; const srv = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { bodies.push(JSON.parse(Buffer.concat(c).toString("utf8"))); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const url = `http://127.0.0.1:${srv.address().port}/v1`;
  try {
    const root = workspace(); writeFileSync(join(root, "AGENTS.md"), "Use tabs. MARKER-RULE-42"); const args = ["run", "hello", "--model", "m", "--base-url", url];
    const a = await run(root, args); assert.match(a.out, /not loaded, because this project is not trusted yet: AGENTS\.md/); assert.ok(!bodies[0].messages[0].content.includes("MARKER-RULE-42"));
    assert.match((await run(root, ["trust"])).out, /now loaded on each run: AGENTS\.md/);
    const b = await run(root, args); assert.ok(!/not trusted/.test(b.out)); assert.ok(bodies[1].messages[0].content.includes("MARKER-RULE-42"));
    await run(root, ["trust", "--revoke"]); await run(root, args); assert.ok(!bodies[2].messages[0].content.includes("MARKER-RULE-42"));
  } finally { srv.close(); }
});

test("run --json prints one JSON object per line and ends with the verdict; sessions fork branches a session from the command line", async () => {
  script = [call("write_file", { path: "j.txt", content: "1" }), { role: "assistant", content: "wrote it" }]; calls = 0;
  const root = workspace(); const r = await run(root, ["run", "write j.txt", "--model", "m", "--base-url", base, "--verify", "test -f j.txt", "--json"]);
  assert.equal(r.code, 0, r.out); const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.type === "tool" && e.name === "write_file" && e.ok)); assert.ok(lines.some((e) => e.type === "check" && e.ok));
  const end = lines.at(-1); assert.equal(end.type, "end"); assert.equal(end.verdict, "pass"); assert.deepEqual(end.changed, ["j.txt"]); assert.equal(end.answer, "wrote it"); assert.match(end.session, /^s-/);
  const f = await run(root, ["sessions", "fork", end.session, "--at", "1", "--name", "branch"]); assert.equal(f.code, 0, f.out); assert.match(f.out, /files in the project are not restored/);
  assert.match((await run(root, ["sessions"])).out, /branch {2}1 turn/); assert.equal((await run(root, ["sessions", "fork", "nope", "--at", "1"])).code, 1);
});

test("personal connectors live outside every project, apply in all of them without trust, and are added from the command line into a file only you can read", async () => {
  const fake = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-mcp.mjs"); const { statSync } = await import("node:fs");
  const root = workspace();
  const a = await run(root, ["connectors", "add", "mine", "--global", "--command", process.execPath, "--arg", fake, "--tools", "echo"]); assert.equal(a.code, 0, a.out); assert.match(a.out, /personal connector mine/);
  const file = join(process.env.PULSE_AGENT_HOME, "connectors.json"); assert.equal(statSync(file).mode & 0o777, 0o600);
  const l = await run(root, ["connectors"]); assert.equal(l.code, 0, l.out); assert.match(l.out, /mine \(personal\): echo/);
  const other = workspace(); assert.match((await run(other, ["connectors"])).out, /mine \(personal\): echo/, "it is there in a project that was never set up or trusted");
  const h = await run(root, ["connectors", "add", "web", "--global", "--url", "http://127.0.0.1:1/mcp", "--header", "Authorization: Bearer ${SOME_TOKEN}"]); assert.equal(h.code, 0, h.out);
  const saved = JSON.parse(readFileSync(file, "utf8")); assert.deepEqual(saved.web, { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer ${SOME_TOKEN}" } });
  assert.equal((await run(root, ["connectors", "add", "bad name", "--global", "--url", "x"])).code, 1); assert.equal((await run(root, ["connectors", "add", "x", "--global"])).code, 1);
  const rm = await run(root, ["connectors", "remove", "mine", "--global"]); assert.equal(rm.code, 0); assert.ok(!/mine/.test((await run(root, ["connectors"])).out));
});
