// Writing subagents. A worker edits in its own git worktree, never in the shared checkout. Its changes come back as a patch
// the builder applies on purpose. If isolation cannot be had (no git repository), the worker is refused, not run in place.
import { workspace, scripted } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../lib/loop.mjs";
import { makePolicy } from "../lib/approve.mjs";
import { ROLES } from "../lib/roles.mjs";

const git = (root, ...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
const repo = () => { const root = workspace(); git(root, "init", "-q", "-b", "main"); writeFileSync(join(root, "a.txt"), "line one\nline two\nline three\n"); writeFileSync(join(root, "b.txt"), "b\n"); git(root, "add", "a.txt", "b.txt"); git(root, "commit", "-q", "-m", "init"); return root; };
const isWorker = (tools) => !tools.map((t) => t.function.name).includes("delegate");
const worktrees = (root) => git(root, "worktree", "list").trim().split("\n").length;

test("two workers change the same file in separate worktrees; the shared checkout is untouched until the builder applies a patch; a patch that no longer fits is refused whole", async () => {
  const root = repo(); let peak = 0, active = 0; const seenTasks = [];
  const model = async ({ messages, tools }) => {
    if (isWorker(tools)) {
      const task = messages[1].content, done = messages.some((m) => m.role === "tool"); seenTasks.push(task);
      if (!done) { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 80)); active--; return { content: "", tool_calls: [{ id: "w", name: "edit_file", args: { path: "a.txt", old: "line two", new: task.includes("ALPHA") ? "line two ALPHA" : "line two BETA" } }] }; }
      return { content: `changed line two for ${task.includes("ALPHA") ? "ALPHA" : "BETA"}`, tool_calls: [] };
    }
    const results = messages.filter((m) => m.role === "tool");
    if (results.length === 0) return { content: "", tool_calls: [{ id: "d1", name: "delegate", args: { role: "worker", task: "make it ALPHA" } }, { id: "d2", name: "delegate", args: { role: "worker", task: "make it BETA" } }] };
    if (results.length === 2) { assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "line one\nline two\nline three\n", "nothing has reached the shared checkout yet"); return { content: "", tool_calls: [{ id: "a1", name: "apply_work", args: { id: /work (w-\d+)/.exec(results[0].content)[1] } }] }; }
    if (results.length === 3) return { content: "", tool_calls: [{ id: "a2", name: "apply_work", args: { id: /work (w-\d+)/.exec(results[1].content)[1] } }] };
    return { content: "applied one", tool_calls: [] };
  };
  const r = await runTask({ root, task: "try two variants", model });
  assert.equal(peak, 2, "the workers ran at the same time"); assert.equal(r.answer, "applied one"); assert.deepEqual(r.changed, ["a.txt"]);
  const text = readFileSync(join(root, "a.txt"), "utf8"); assert.ok(text === "line one\nline two ALPHA\nline three\n" || text === "line one\nline two BETA\nline three\n", text);
  assert.ok(!text.includes("<<<<"), "a patch that does not fit leaves no conflict markers");
  assert.equal(worktrees(root), 1, "every worktree is gone when the run ends"); assert.equal(git(root, "branch", "--list", "pa/*").trim(), "");
});

test("a worker's result names its work id and what changed; a worker cannot delegate; its tools are the role's and nothing more", async () => {
  const root = repo(); let workerTools = null, report = "";
  const model = async ({ messages, tools }) => {
    if (isWorker(tools)) { workerTools = tools.map((t) => t.function.name).sort(); return messages.some((m) => m.role === "tool") ? { content: "added c.txt", tool_calls: [] } : { content: "", tool_calls: [{ id: "w", name: "write_file", args: { path: "c.txt", content: "new\n" } }] }; }
    const res = messages.filter((m) => m.role === "tool"); if (!res.length) return { content: "", tool_calls: [{ id: "d", name: "delegate", args: { role: "worker", task: "add c.txt" } }] };
    report = res[0].content; return { content: "left unapplied", tool_calls: [] };
  };
  await runTask({ root, task: "t", model });
  assert.deepEqual(workerTools, [...ROLES.worker.tools].sort()); assert.ok(!workerTools.includes("delegate") && !workerTools.includes("apply_work"));
  assert.match(report, /added c\.txt/); assert.match(report, /work w-1/); assert.match(report, /c\.txt/); assert.match(report, /apply_work/);
  assert.equal(existsSync(join(root, "c.txt")), false, "unapplied work never reaches the checkout");
});

test("no isolation, no worker: outside a git repository, or with no commit, the delegation is refused and nothing is run in the shared checkout", async () => {
  const root = workspace(); let workerRan = false;
  const model = async ({ messages, tools }) => { if (isWorker(tools)) { workerRan = true; return { content: "x", tool_calls: [] }; } return messages.some((m) => m.role === "tool") ? { content: messages.at(-1).content, tool_calls: [] } : { content: "", tool_calls: [{ id: "d", name: "delegate", args: { role: "worker", task: "edit things" } }] }; };
  const r = await runTask({ root, task: "t", model }); assert.equal(workerRan, false); assert.match(r.answer, /needs a git repository with at least one commit/);
});

test("a worker inherits the parent's approval rules and cannot widen them; at most three workers run at once", async () => {
  const root = repo();
  const model = async ({ messages, tools }) => {
    if (isWorker(tools)) return messages.some((m) => m.role === "tool") ? { content: messages.at(-1).content, tool_calls: [] } : { content: "", tool_calls: [{ id: "w", name: "run", args: { command: "touch sneaky.txt" } }] };
    return messages.some((m) => m.role === "tool") ? { content: messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n=====\n"), tool_calls: [] } : { content: "", tool_calls: [1, 2, 3, 4].map((i) => ({ id: `d${i}`, name: "delegate", args: { role: "worker", task: `job ${i}` } })) };
  };
  const r = await runTask({ root, task: "t", model, policy: makePolicy({ mode: "ask", allow: ["edit:*"] }) });
  const parts = r.answer.split("\n=====\n"); assert.equal(parts.length, 4);
  assert.equal(parts.filter((p) => /no rule allows/.test(p)).length, 3, "each worker that ran was refused the command"); assert.equal(parts.filter((p) => /at most 3 workers/.test(p)).length, 1);
  assert.equal(worktrees(root), 1);
});
