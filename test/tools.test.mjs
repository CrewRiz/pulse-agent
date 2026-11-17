import { workspace } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveIn } from "../lib/workspace.mjs";
import { execute, toolsFor, TOOLS } from "../lib/tools.mjs";
import { ROLES } from "../lib/roles.mjs";
import { openMemory } from "../lib/memory.mjs";

const ctx = (root, role = "builder", extra = {}) => ({ root, role: ROLES[role], memory: openMemory(root), ...extra });

test("a path stays inside the workspace: parents, absolute paths and links that leave it are refused", () => {
  const root = workspace();
  assert.equal(resolveIn(root, "src/a.js"), join(realpathSync(root), "src", "a.js"), "the real path: on macOS a temp directory is itself reached through a link");
  for (const bad of ["../x", "src/../../x", "/etc/passwd", ""]) assert.throws(() => resolveIn(root, bad), /outside the workspace|empty path/, bad);
  mkdirSync(join(root, "in")); symlinkSync("/tmp", join(root, "in", "out"));
  assert.throws(() => resolveIn(root, "in/out/x.txt"), /outside the workspace/);
});

test("write, read and edit: an edit replaces exactly one occurrence and says so when it cannot", async () => {
  const root = workspace(), c = ctx(root);
  assert.equal((await execute("write_file", { path: "src/a.js", content: "const a = 1;\nconst b = 1;\n" }, c)).ok, true);
  assert.equal(readFileSync(join(root, "src/a.js"), "utf8"), "const a = 1;\nconst b = 1;\n");
  assert.match((await execute("read_file", { path: "src/a.js" }, c)).output, /const a = 1;/);
  assert.equal((await execute("edit_file", { path: "src/a.js", old: "const a = 1;", new: "const a = 2;" }, c)).ok, true);
  assert.match(readFileSync(join(root, "src/a.js"), "utf8"), /const a = 2;\nconst b = 1;/);
  const twice = await execute("edit_file", { path: "src/a.js", old: "const", new: "let" }, c); assert.equal(twice.ok, false); assert.match(twice.output, /2 places/);
  const none = await execute("edit_file", { path: "src/a.js", old: "nope", new: "x" }, c); assert.equal(none.ok, false); assert.match(none.output, /not found/);
  const missing = await execute("read_file", { path: "src/zzz.js" }, c); assert.equal(missing.ok, false);
  const out = await execute("write_file", { path: "../escape.txt", content: "x" }, c); assert.equal(out.ok, false); assert.match(out.output, /outside the workspace/);
});

test("run executes in the workspace, returns the exit code and the end of the output, and stops at its timeout", async () => {
  const root = workspace(), c = ctx(root);
  writeFileSync(join(root, "hello.txt"), "hi");
  const ok = await execute("run", { command: "cat hello.txt && echo done" }, c); assert.equal(ok.ok, true); assert.equal(ok.code, 0); assert.match(ok.output, /hidone/);
  const bad = await execute("run", { command: "echo oops >&2; exit 3" }, c); assert.equal(bad.ok, false); assert.equal(bad.code, 3); assert.match(bad.output, /oops/);
  const slow = await execute("run", { command: "sleep 5" }, { ...c, timeoutMs: 200 }); assert.equal(slow.ok, false); assert.match(slow.output, /timed out/);
});

test("the ledger guards a write: a withdrawn value does not go back into a file, and the refusal names the correction", async () => {
  const root = workspace(), c = ctx(root);
  c.memory.remember({ cause: "price-set-49", effect: "price-corrected-to-29", kind: "correction", withdrawn: ["$49"], replacement: ["$29"], note: "WTP is $29" });
  const w = await execute("write_file", { path: "pricing.md", content: "Pro is $49 per seat" }, c);
  assert.equal(w.ok, false); assert.match(w.output, /\$49.*withdrawn/); assert.match(w.output, /\$29/); assert.equal(existsSync(join(root, "pricing.md")), false);
  assert.equal((await execute("write_file", { path: "pricing.md", content: "Pro is $29 per seat" }, c)).ok, true);
  const e = await execute("edit_file", { path: "pricing.md", old: "$29", new: "$49" }, c); assert.equal(e.ok, false); assert.match(readFileSync(join(root, "pricing.md"), "utf8"), /\$29/);
});

test("a role's tool limits are enforced by the harness: a tool outside the role is refused and never runs", async () => {
  const root = workspace();
  assert.deepEqual(toolsFor(ROLES.evaluator).map((t) => t.function.name).sort(), ["read_file", "run_check"]);
  assert.ok(toolsFor(ROLES.builder).length >= 8); assert.ok(TOOLS.every((t) => t.function.name && t.function.parameters));
  const w = await execute("write_file", { path: "a.txt", content: "x" }, ctx(root, "evaluator"));
  assert.equal(w.ok, false); assert.equal(w.refused, true); assert.match(w.output, /not available to the evaluator role/); assert.equal(existsSync(join(root, "a.txt")), false);
  const r = await execute("run", { command: "touch b.txt" }, ctx(root, "evaluator")); assert.equal(r.refused, true); assert.equal(existsSync(join(root, "b.txt")), false);
  const u = await execute("launch_missiles", {}, ctx(root)); assert.equal(u.refused, true);
  // the evaluator's one command is the check the person configured, never a command the model writes
  const chk = await execute("run_check", { command: "touch c.txt" }, ctx(root, "evaluator", { check: "echo checked" }));
  assert.equal(chk.ok, true); assert.match(chk.output, /checked/); assert.equal(existsSync(join(root, "c.txt")), false);
  const none = await execute("run_check", {}, ctx(root, "evaluator")); assert.equal(none.ok, false); assert.match(none.output, /no check command/);
});
