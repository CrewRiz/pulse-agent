import { workspace, scripted } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../lib/loop.mjs";
import { execute } from "../lib/tools.mjs";
import { ROLES } from "../lib/roles.mjs";
import { openMemory } from "../lib/memory.mjs";

const ctx = (root, role = "scout") => ({ root, role: ROLES[role], memory: openMemory(root) });

test("list_files and search read the workspace without a shell, skip dependency and state folders, and cap what they return", async () => {
  const root = workspace(); mkdirSync(join(root, "src")); mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), "export const price = 29;\n// TODO fix rounding\n"); writeFileSync(join(root, "src", "b.js"), "const y = 1;\n"); writeFileSync(join(root, "node_modules", "x", "i.js"), "TODO never shown\n");
  const ls = await execute("list_files", {}, ctx(root)); assert.equal(ls.ok, true); assert.match(ls.output, /src\/a\.js/); assert.ok(!/node_modules|\.memory-pulse/.test(ls.output));
  const s = await execute("search", { pattern: "TODO" }, ctx(root)); assert.match(s.output, /src\/a\.js:2:.*TODO fix rounding/); assert.ok(!/never shown/.test(s.output));
  assert.match((await execute("search", { pattern: "nothing-like-this" }, ctx(root))).output, /no match/);
  assert.equal((await execute("search", { pattern: "(" }, ctx(root))).ok, false, "a bad pattern is an error, not a crash");
  assert.equal((await execute("list_files", { path: "../.." }, ctx(root))).ok, false);
  assert.deepEqual([...ROLES.scout.tools].sort(), ["list_files", "read_file", "search"]);
  assert.equal((await execute("write_file", { path: "x", content: "y" }, ctx(root))).refused, true);
});

test("delegate: the builder hands a question to a scout with a fresh context and read-only tools, and gets its answer back as a tool result", async () => {
  const root = workspace(); writeFileSync(join(root, "a.js"), "export const price = 29;\n");
  const model = scripted([
    (m) => ({ tool_calls: [["delegate", { role: "scout", task: "Where is the price defined?" }]] }),                                        // builder
    (m) => { assert.equal(m[1].content, "Where is the price defined?"); assert.ok(!JSON.stringify(m).includes("find and report the price")); return { tool_calls: [["write_file", { path: "hack.txt", content: "x" }]] }; },  // scout tries to write
    () => ({ content: "price is defined in a.js line 1" }),                                                                                  // scout answers
    (m) => { assert.match(m.at(-1).content, /price is defined in a\.js line 1/); return { content: "It is in a.js." }; },                      // builder continues
  ]);
  const events = []; const r = await runTask({ root, task: "find and report the price", model, onEvent: (e) => events.push(e) });
  assert.equal(r.answer, "It is in a.js."); assert.equal(existsSync(join(root, "hack.txt")), false, "the scout's write was refused");
  assert.deepEqual(model.seen[1].tools.sort(), ["list_files", "read_file", "search"], "a subagent cannot delegate further and cannot write");
  assert.ok(events.some((e) => e.who === "scout" && e.type === "tool" && e.refused)); assert.equal(r.delegated, 1);
});

test("delegate refuses a role that may not be delegated to, and several delegations in one turn run at the same time", async () => {
  const root = workspace();
  const bad = scripted([{ tool_calls: [["delegate", { role: "builder", task: "do it all" }]] }, { content: "ok" }]);
  const rb = await runTask({ root, task: "t", model: bad });
  // asserted on what was recorded, not inside the model function: a failure there is swallowed by the delegation's own error handling
  assert.equal(bad.seen.length, 2, "no child agent was started"); assert.match(bad.seen[1].messages.at(-1).content, /can delegate only to: scout, evaluator/); assert.equal(rb.delegated, 0);
  let active = 0, peak = 0;
  const slow = async ({ messages, tools }) => {
    const names = tools.map((t) => t.function.name);
    if (names.includes("delegate")) return messages.some((m) => m.role === "tool") ? { content: "both done", tool_calls: [] } : { content: "", tool_calls: [{ id: "1", name: "delegate", args: { role: "scout", task: "one" } }, { id: "2", name: "delegate", args: { role: "scout", task: "two" } }] };
    active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 60)); active--; return { content: `answer to ${messages[1].content}`, tool_calls: [] };
  };
  const r = await runTask({ root, task: "ask two scouts", model: slow });
  assert.equal(peak, 2, "the two scouts overlapped"); assert.equal(r.delegated, 2); assert.equal(r.answer, "both done");
});

