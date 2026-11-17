import { workspace, scripted } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTeam } from "../lib/team.mjs";
import { openMemory } from "../lib/memory.mjs";

test("a team run: the builder works, then an evaluator that did not build it and cannot write reviews the change; the check is still the verdict", async () => {
  const root = workspace(); writeFileSync(join(root, "n.txt"), "1");
  const builder = scripted([{ tool_calls: [["write_file", { path: "n.txt", content: "2" }]] }, { content: "set n to 2" }]);
  const evaluator = scripted([{ tool_calls: [["read_file", { path: "n.txt" }]] }, { tool_calls: [["write_file", { path: "n.txt", content: "3" }]] }, { tool_calls: [["run_check", {}]] }, { content: "The check passes. n.txt holds 2. I verified by running the check; no defect found." }]);
  const r = await runTeam({ root, task: "make n.txt say 2", model: builder, evalModel: evaluator, verify: 'test "$(cat n.txt)" = 2' });
  assert.equal(r.verdict, "pass"); assert.equal(readFileSync(join(root, "n.txt"), "utf8"), "2", "the evaluator's write was refused");
  assert.match(r.review, /no defect found/); assert.deepEqual(r.build.changed, ["n.txt"]);
  const first = evaluator.seen[0].messages; assert.deepEqual(evaluator.seen[0].tools.sort(), ["read_file", "run_check"]);
  assert.match(first[1].content, /make n\.txt say 2/); assert.match(first[1].content, /n\.txt/); assert.ok(!JSON.stringify(first).includes("set n to 2"), "the evaluator does not get the builder's own account of its work");
  assert.ok(openMemory(root).rows().some((e) => (e.tags ?? []).includes("review") && /no defect found/.test(e.note)));
});

test("nothing to review means no review: a build that changed no files, or whose check failed, ends there", async () => {
  const root = workspace();
  const evaluator = scripted([{ content: "should not be asked" }]);
  const idle = await runTeam({ root, task: "do nothing", model: scripted([{ content: "nothing to do" }]), evalModel: evaluator, verify: "true" });
  assert.equal(idle.review, null); assert.equal(evaluator.seen.length, 0);
  const failed = await runTeam({ root, task: "break", model: scripted([{ tool_calls: [["write_file", { path: "a.txt", content: "x" }]] }, { content: "done" }]), evalModel: evaluator, verify: "exit 1", maxRounds: 1 });
  assert.equal(failed.verdict, "fail"); assert.equal(failed.review, null); assert.equal(evaluator.seen.length, 0); assert.ok(existsSync(join(root, "a.txt")));
});
