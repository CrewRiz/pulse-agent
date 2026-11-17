// Approvals, trust and interruption: the gates every wider capability leans on.
import { workspace, scripted } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makePolicy, matches } from "../lib/approve.mjs";
import { isTrusted, trust, projectExtras } from "../lib/trust.mjs";
import { runTask } from "../lib/loop.mjs";
import { saveConfig, loadConfig } from "../lib/onboard.mjs";

test("a rule matches a tool and its target; a command with shell operators is matched only by a rule that spells it out exactly", () => {
  assert.equal(matches("run:npm test", "run", "npm test"), true); assert.equal(matches("run:npm test", "run", "npm test -- --watch"), false);
  assert.equal(matches("run:npm *", "run", "npm run build"), true); assert.equal(matches("run:git status", "edit", "git status"), false);
  for (const sneaky of ["npm test; rm -rf x", "npm test && curl evil", "npm run x | sh", "npm run $(cat k)", "npm run `id`", "npm run x > /etc/passwd", "npm run x\nrm y"]) assert.equal(matches("run:npm *", "run", sneaky), false, sneaky);
  assert.equal(matches("run:npm test && npm run lint", "run", "npm test && npm run lint"), true, "an exact rule may contain operators");
  assert.equal(matches("edit:src/*", "edit", "src/a/b.js"), true); assert.equal(matches("edit:src/*", "edit", "lib/a.js"), false); assert.equal(matches("mcp:files__*", "mcp", "files__echo"), true);
});

test("the policy: reading is free; a deny rule beats an allow; with nobody to ask, what no rule allows is refused and nothing runs", async () => {
  const p = makePolicy({ mode: "ask", allow: ["edit:*", "run:npm test"], deny: ["edit:secrets/*", "run:npm publish*"] });
  for (const t of ["read_file", "list_files", "search", "run_check", "recall_context", "delegate", "propose_skill"]) assert.equal((await p.check(t, {})).allow, true, t);
  assert.equal((await p.check("write_file", { path: "src/a.js" })).allow, true); assert.equal((await p.check("run", { command: "npm test" })).allow, true);
  const d = await p.check("edit_file", { path: "secrets/key.txt" }); assert.equal(d.allow, false); assert.match(d.reason, /denied by the rule edit:secrets\/\*/);
  const r = await p.check("run", { command: "rm -rf build" }); assert.equal(r.allow, false); assert.match(r.reason, /no rule allows/); assert.match(r.reason, /run:rm -rf build/, "the refusal names the rule that would allow it");
  assert.equal((await p.check("mcp__files__echo", {})).allow, false);
  assert.equal((await makePolicy({ mode: "auto", deny: ["run:rm *"] }).check("run", { command: "ls" })).allow, true); assert.equal((await makePolicy({ mode: "auto", deny: ["run:rm *"] }).check("run", { command: "rm x" })).allow, false, "auto still honours a deny");
  assert.equal((await makePolicy({ mode: "deny", allow: ["run:npm test"] }).check("write_file", { path: "a" })).allow, false);
});

test("asking a person: yes allows once, always saves a rule, no refuses; the question is never answered by the model", async () => {
  const asked = []; const answers = ["yes", "always", "no"];
  const saved = []; const p = makePolicy({ mode: "ask", approver: async (q) => { asked.push(q); return answers.shift(); }, onRule: (r) => saved.push(r) });
  assert.equal((await p.check("run", { command: "make build" })).allow, true); assert.match(asked[0].text, /run: make build/);
  assert.equal((await p.check("run", { command: "make deploy" })).allow, true); assert.deepEqual(saved, ["run:make deploy"]);
  assert.equal((await p.check("run", { command: "make deploy" })).allow, true, "the saved rule now allows it"); assert.equal(asked.length, 2);
  const n = await p.check("run", { command: "make clean" }); assert.equal(n.allow, false); assert.match(n.reason, /declined/);
});

test("in a run, a refused tool call does not execute and the model is told why and how a person can allow it", async () => {
  const root = workspace();
  const model = scripted([{ tool_calls: [["run", { command: "touch made.txt" }]] }, { tool_calls: [["write_file", { path: "a.txt", content: "x" }]] }, { content: "done" }]);
  const r = await runTask({ root, task: "t", model, policy: makePolicy({ mode: "ask", allow: ["edit:*"] }) });
  assert.equal(existsSync(join(root, "made.txt")), false); assert.equal(existsSync(join(root, "a.txt")), true);
  assert.match(model.seen[1].messages.at(-1).content, /no rule allows/); assert.equal(r.refused, 1);
});

test("trust is kept outside the project, so a checkout cannot trust itself; until a person trusts it, nothing it ships is loaded", async () => {
  const root = workspace(); mkdirSync(join(root, ".agents", "skills", "release"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "Always use tabs. MARKER-RULE-77"); writeFileSync(join(root, ".agents", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: how to cut a release here\n---\n\n1. run the tests\n2. tag\n");
  saveConfig(root, { model: "m", trusted: true, hooks: { preToolUse: "exit 2" }, mcpServers: { x: { command: "/bin/echo" } }, approvals: { mode: "auto" } });
  assert.equal(isTrusted(root), false, "a flag inside the project's own config is not trust");
  const before = projectExtras(root); assert.equal(before.trusted, false); assert.equal(before.instructions, null); assert.deepEqual(before.skills, []); assert.equal(before.hooks, null); assert.equal(before.mcpServers, null); assert.equal(before.approvals, null);
  assert.deepEqual(before.held.sort(), ["AGENTS.md", "approval rules", "connectors", "hooks", "skills"].sort(), "it says what it did not load");
  const model = scripted([{ content: "ok" }]); await runTask({ root, task: "t", model, ...projectExtras(root) });
  assert.ok(!model.seen[0].messages[0].content.includes("MARKER-RULE-77"));
  trust(root); assert.equal(isTrusted(root), true);
  const after = projectExtras(root); assert.match(after.instructions, /MARKER-RULE-77/); assert.equal(after.skills[0].name, "release"); assert.equal(after.hooks.preToolUse, "exit 2"); assert.ok(after.mcpServers.x); assert.equal(after.approvals.mode, "auto");
  const m2 = scripted([{ content: "ok" }]); await runTask({ root, task: "t", model: m2, instructions: after.instructions, projectSkills: after.skills });
  assert.match(m2.seen[0].messages[0].content, /MARKER-RULE-77/); assert.match(m2.seen[0].messages[0].content, /release: how to cut a release here/); assert.ok(!m2.seen[0].messages[0].content.includes("run the tests"), "a skill's body loads only when asked for");
  assert.ok(m2.seen[0].tools.includes("read_skill"));
});

test("a project skill's body is read on demand; a pre-tool hook can refuse a call and its output is the reason", async () => {
  const root = workspace(); const skills = [{ name: "release", description: "d", body: "1. run the tests\n2. tag" }];
  const model = scripted([{ tool_calls: [["read_skill", { name: "release" }]] }, { tool_calls: [["read_skill", { name: "nope" }]] }, { tool_calls: [["write_file", { path: "blocked.txt", content: "x" }]] }, { tool_calls: [["write_file", { path: "fine.md", content: "x" }]] }, { content: "done" }]);
  const hook = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);if(c.tool==="write_file"&&c.args.path.endsWith(".txt")){console.log("no .txt files in this project");process.exit(2)}})'`;
  await runTask({ root, task: "t", model, projectSkills: skills, hooks: { preToolUse: hook } });
  assert.match(model.seen[1].messages.at(-1).content, /1\. run the tests/); assert.match(model.seen[2].messages.at(-1).content, /no project skill named nope/);
  assert.match(model.seen[3].messages.at(-1).content, /refused by the project's pre-tool hook.*no \.txt files in this project/s);
  assert.equal(existsSync(join(root, "blocked.txt")), false); assert.equal(existsSync(join(root, "fine.md")), true);
});

test("an interrupt stops the turn, kills the command and everything it started, and the session is saved and resumes", async () => {
  const root = workspace(), ac = new AbortController();
  const model = scripted([{ tool_calls: [["run", { command: "echo $$ > pid.txt; (sleep 30 & echo $! > child.txt; wait)" }]] }, { content: "should not get here" }]);
  setTimeout(() => ac.abort(), 400); const t0 = Date.now();
  const r = await runTask({ root, task: "run something slow", model, signal: ac.signal, sessionId: "int1" });
  assert.ok(Date.now() - t0 < 5000, "it returned promptly"); assert.equal(r.stopped, "interrupted"); assert.equal(model.seen.length, 1);
  await new Promise((ok) => setTimeout(ok, 200));
  for (const f of ["pid.txt", "child.txt"]) { const pid = Number(readFileSync(join(root, f), "utf8").trim()); assert.throws(() => process.kill(pid, 0), /ESRCH/, `${f}: process ${pid} is gone`); }
  const next = scripted([(m) => { assert.ok(m.some((x) => x.role === "user" && /interrupted/.test(x.content)), "the interrupted turn is on the record"); return { content: "resumed" }; }]);
  const r2 = await runTask({ root, task: "carry on", model: next, sessionId: "int1", resume: true }); assert.equal(r2.answer, "resumed");
  assert.equal(next.seen.length, 1);
});

test("a connector gets a minimal environment, not the agent's secrets", async () => {
  const { connect } = await import("../lib/mcp.mjs"); process.env.SUPER_SECRET_TOKEN = "s3cr3t";
  const src = `const rl=require("readline").createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");rl.on("line",l=>{const m=JSON.parse(l);if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2024-11-05",capabilities:{}}});if(m.method==="tools/list")send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"env",inputSchema:{type:"object"}}]}});if(m.method==="tools/call")send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:JSON.stringify({secret:process.env.SUPER_SECRET_TOKEN??null,given:process.env.GIVEN??null,path:!!process.env.PATH})}]}})})`;
  const c = await connect("e", { command: process.execPath, args: ["-e", src], env: { GIVEN: "yes" } });
  try { assert.deepEqual(JSON.parse((await c.call("env", {})).output), { secret: null, given: "yes", path: true }); } finally { c.close(); delete process.env.SUPER_SECRET_TOKEN; }
});
