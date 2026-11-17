import { workspace, scripted } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../lib/loop.mjs";
import { openMemory } from "../lib/memory.mjs";
import { openSkills } from "../lib/skills.mjs";

const sys = (model, i = 0) => model.seen[i].messages[0].content;

test("the loop: the model calls tools until it answers, each result goes back to it, and the run reports what changed", async () => {
  const root = workspace();
  const model = scripted([{ tool_calls: [["write_file", { path: "a.txt", content: "one" }]] }, { tool_calls: [["read_file", { path: "a.txt" }]] }, { content: "wrote a.txt" }]);
  const r = await runTask({ root, task: "create a.txt", model });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one");
  assert.equal(r.answer, "wrote a.txt"); assert.equal(r.steps, 3); assert.deepEqual(r.changed, ["a.txt"]); assert.equal(r.verdict, "unverified");
  const last = model.seen[2].messages; assert.equal(last.at(-1).role, "tool"); assert.match(last.at(-1).content, /one/);
  assert.match(sys(model), /builder/); assert.deepEqual(model.seen[0].tools.sort(), ["apply_work", "delegate", "edit_file", "kill_command", "list_files", "propose_skill", "read_file", "read_output", "run", "run_background", "search", "write_file"]);
});

test("the loop stops at its step limit and says so; a refused tool call is answered, not executed", async () => {
  const root = workspace();
  const forever = scripted([{ tool_calls: [["run", { command: "echo again" }]] }]);
  const r = await runTask({ root, task: "loop", model: forever, maxSteps: 4 });
  assert.equal(r.steps, 4); assert.equal(r.stopped, "step limit"); assert.equal(r.verdict, "unverified");
  const ev = scripted([{ tool_calls: [["write_file", { path: "x.txt", content: "x" }]] }, { content: "could not write" }]);
  const e = await runTask({ root, task: "review", model: ev, role: "evaluator", verify: "true" });
  assert.equal(existsSync(join(root, "x.txt")), false); assert.match(ev.seen[1].messages.at(-1).content, /not available to the evaluator role/);
});

test("before the first step the ledger is asked whether this was already tried: a closed direction is in the prompt, marked", async () => {
  const root = workspace(), mem = openMemory(root);
  for (let i = 0; i < 30; i++) mem.remember({ cause: `deploy-${i}`, effect: `worker-${i}-live`, note: `worker ${i} deployed to the edge with a health check` });
  mem.remember({ cause: "cache-redis-trial", effect: "cache-redis-rejected", note: "redis cache layer for the pricing endpoint rejected: stale prices under load" });
  const model = scripted([{ content: "ok" }]);
  const r = await runTask({ root, task: "add a redis cache layer to the pricing endpoint", model });
  assert.match(sys(model), /already tried/i); assert.match(sys(model), /✗ \(t31\).*redis cache layer.*\[rejected\]/);
  assert.equal(r.drift.length, 1); assert.equal(r.drift[0].closed, "rejected");
  const clean = scripted([{ content: "ok" }]); await runTask({ root, task: "rename the logger module", model: clean });
  assert.ok(!/already tried/i.test(sys(clean)));
});

test("the check decides, not the model: a failing check goes back to the model, and fail-then-pass is recorded as a lesson with its evidence", async () => {
  const root = workspace(); writeFileSync(join(root, "n.txt"), "1");
  const model = scripted([
    { content: "done, all good" },                                                          // claims success; the check says otherwise
    { tool_calls: [["write_file", { path: "n.txt", content: "2" }]] }, { content: "fixed" },
  ]);
  const r = await runTask({ root, task: "make n.txt say 2", model, verify: 'test "$(cat n.txt)" = 2 || { echo "n.txt is $(cat n.txt), want 2"; exit 1; }' });
  assert.equal(r.verdict, "pass"); assert.equal(r.rounds, 2);
  assert.match(model.seen[1].messages.at(-1).content, /check failed.*n\.txt is 1, want 2/s);
  const rows = openMemory(root).rows(), lesson = rows.find((e) => (e.tags ?? []).includes("lesson"));
  assert.ok(lesson, "a lesson row exists"); assert.match(lesson.note, /n\.txt is 1, want 2/); assert.match(lesson.note, /n\.txt/); assert.match(lesson.effect, /passed-after/);
  assert.ok(rows.some((e) => /verified-pass/.test(e.effect)), "the run itself is on the record");
  // and the next run on this workspace carries the lesson in
  const next = scripted([{ content: "ok" }]); await runTask({ root, task: "another change to n.txt", model: next });
  assert.match(sys(next), /Lessons from verified runs/); assert.match(sys(next), /want 2/);
});

test("a run whose check never passes is recorded as failed, teaches nothing, and its skill proposal is thrown away", async () => {
  const root = workspace();
  const model = scripted([{ tool_calls: [["propose_skill", { name: "bump-n", when: "n.txt is stale", steps: "write the number" }]] }, { content: "done" }]);
  const r = await runTask({ root, task: "make n.txt say 2", model, verify: "exit 1", maxRounds: 2 });
  assert.equal(r.verdict, "fail"); assert.equal(r.rounds, 2);
  const rows = openMemory(root).rows();
  assert.ok(rows.some((e) => /verify-failed/.test(e.effect))); assert.ok(!rows.some((e) => (e.tags ?? []).includes("lesson")));
  assert.deepEqual(openSkills(root).list(), { proposed: [], accepted: [] });
});

test("a skill proposed in a verified run is held, not used; only a person's accept puts it in front of the model", async () => {
  const root = workspace();
  const model = scripted([{ tool_calls: [["propose_skill", { name: "Release Checklist!", when: "cutting a release of the package", steps: "1. run the tests\n2. bump the version\n3. tag" }]] }, { content: "done" }]);
  const r = await runTask({ root, task: "cut a release", model, verify: "true" });
  assert.equal(r.verdict, "pass"); assert.deepEqual(r.proposed, ["release-checklist"]);
  const sk = openSkills(root); assert.deepEqual(sk.list(), { proposed: ["release-checklist"], accepted: [] });
  const before = scripted([{ content: "ok" }]); await runTask({ root, task: "cut a release of the package", model: before });
  assert.ok(!/release-checklist/.test(sys(before)), "a held proposal is not shown to the model");
  assert.equal(sk.accept("release-checklist").ok, true); assert.deepEqual(sk.list(), { proposed: [], accepted: ["release-checklist"] });
  const after = scripted([{ content: "ok" }]); await runTask({ root, task: "cut a release of the package", model: after });
  assert.match(sys(after), /release-checklist/); assert.match(sys(after), /bump the version/);
  const other = scripted([{ content: "ok" }]); await runTask({ root, task: "fix the flaky websocket reconnect", model: other });
  assert.ok(!/release-checklist/.test(sys(other)), "an accepted skill is shown only for a task it bears on");
  assert.equal(sk.reject("nope").ok, false);
  // a proposal cannot write outside the skills directory or smuggle a path in its name
  const evil = await sk.propose({ name: "../../etc/x", when: "w", steps: "s" }); assert.equal(evil.ok, true); assert.ok(readdirSync(join(root, ".pulse-agent", "skills", "pending")).every((f) => /^[a-z0-9-]+\.md$/.test(f)));
});

test("lessons are this agent's own: a row another tool tagged as a lesson, or one without a note, is not carried into a run", async () => {
  // live smoke, 2026-11-16: with a shared ledger, `pulse-agent lessons` listed other tools' rows and printed "undefined" for rows without a note
  const root = workspace(), mem = openMemory(root);
  mem.remember({ cause: "other-tool", effect: "some-lesson", tags: ["lesson"], note: "a lesson another tool recorded" });
  mem.remember({ cause: "task-x", effect: "check-passed-after-1-failed-round", tags: ["pulse-agent", "lesson"] });
  mem.remember({ cause: "task-y", effect: "check-passed-after-2-failed-rounds", tags: ["pulse-agent", "lesson"], note: "ours, with a note" });
  const ls = mem.lessons(10);
  assert.deepEqual(ls.map((l) => l.text), ["ours, with a note", "task-x: check-passed-after-1-failed-round"]);
  const model = scripted([{ content: "ok" }]); await runTask({ root, task: "anything", model });
  assert.ok(!/another tool recorded/.test(sys(model))); assert.ok(!/undefined/.test(sys(model))); assert.match(sys(model), /ours, with a note/);
});

test("every message the loop sends has string content: an assistant turn that only calls tools carries an empty string, not null", async () => {
  // live run, 2026-11-16: a hosted OpenAI-compatible endpoint answered 400 (type mismatch at /messages/2/content) to a null
  const root = workspace();
  const model = scripted([{ tool_calls: [["write_file", { path: "a.txt", content: "x" }]] }, { content: "done" }]);
  await runTask({ root, task: "write a.txt", model });
  for (const call of model.seen) for (const m of call.messages) assert.equal(typeof m.content, "string", `${m.role} content is ${m.content === null ? "null" : typeof m.content}`);
});
