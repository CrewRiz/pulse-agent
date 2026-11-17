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
  const h = await run(root, ["--help"]); assert.equal(h.code, 0); for (const w of ["run", "skills", "lessons", "sync", "state export", "--verify", "--role", "--no-learned", "PULSE_AGENT_MODEL", "MEMORY_PULSE_KEY"]) assert.match(h.out, new RegExp(w));
  const u = await run(root, ["frobnicate"]); assert.equal(u.code, 1); assert.match(u.out, /unknown command/);
  const n = await run(root, ["run", "do a thing"]); assert.equal(n.code, 1); assert.match(n.out, /PULSE_AGENT_MODEL|--model/);
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
