// The tools a model can call. Every call goes through execute(): the role's allowlist first, then the workspace boundary,
// then the ledger's guard on anything written. A refused call is answered with the reason and nothing runs.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, relative } from "node:path";
import { spawn } from "node:child_process";
import { resolveIn } from "./workspace.mjs";

const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const S = { type: "string" };
export const TOOLS = [
  fn("read_file", "Read a text file in the workspace.", { path: S }, ["path"]),
  fn("write_file", "Create or replace a file in the workspace with the given content.", { path: S, content: S }, ["path", "content"]),
  fn("edit_file", "Replace one exact occurrence of `old` with `new` in a file. Fails when `old` is missing or appears more than once.", { path: S, old: S, new: S }, ["path", "old", "new"]),
  fn("run", "Run a shell command in the workspace and get its exit code and the end of its output.", { command: S }, ["command"]),
  fn("run_check", "Run the check command the person configured for this workspace. Takes no command of your own.", {}, []),
  fn("propose_skill", "Propose a reusable procedure learned in this task. It is held for a person to review and is kept only if the task's check passes.", { name: S, when: S, steps: S }, ["name", "when", "steps"]),
];
export const toolsFor = (role) => TOOLS.filter((t) => role.tools.includes(t.function.name));

const MAX_OUT = 6000;
const tail = (s) => (s.length > MAX_OUT ? `[... ${s.length - MAX_OUT} earlier characters cut]\n${s.slice(-MAX_OUT)}` : s);

export function shell(command, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((done) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: process.env }); let out = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => { clearTimeout(timer); done(timedOut ? { ok: false, code: null, output: tail(`${out}\n[timed out after ${timeoutMs} ms]`) } : { ok: code === 0, code, output: tail(out) }); });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, code: null, output: String(e.message) }); });
  });
}

// resolveIn returns the real path, so the workspace is made real too before a path is shown relative to it
const rel = (ctx, p) => relative(realpathSync(ctx.root), p);
const guarded = (ctx, text, full) => { const g = ctx.memory.guard(text, full); return g.blocked ? { ok: false, blocked: true, output: `not written. The ledger blocks this text:\n${g.reasons.map((r) => `  ${r}`).join("\n")}` } : null; };

const impl = {
  read_file(a, ctx) { const p = resolveIn(ctx.root, a.path); if (!existsSync(p)) return { ok: false, output: `${a.path} does not exist` }; return { ok: true, output: tail(readFileSync(p, "utf8")) }; },
  write_file(a, ctx) {
    const p = resolveIn(ctx.root, a.path), content = String(a.content ?? ""); const no = guarded(ctx, content, p); if (no) return no;
    mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); ctx.changed?.add(rel(ctx, p)); return { ok: true, output: `wrote ${a.path} (${content.length} characters)` };
  },
  edit_file(a, ctx) {
    const p = resolveIn(ctx.root, a.path); if (!existsSync(p)) return { ok: false, output: `${a.path} does not exist` };
    const old = String(a.old ?? ""), next = String(a.new ?? ""), text = readFileSync(p, "utf8"); if (!old) return { ok: false, output: "`old` is empty" };
    const n = text.split(old).length - 1;
    if (n === 0) return { ok: false, output: "`old` was not found in the file; read the file and copy the text exactly" };
    if (n > 1) return { ok: false, output: `\`old\` appears in ${n} places; include more of the surrounding text so it names one` };
    const no = guarded(ctx, next, p); if (no) return no;
    writeFileSync(p, text.replace(old, () => next)); ctx.changed?.add(rel(ctx, p)); return { ok: true, output: `edited ${a.path}` };
  },
  run(a, ctx) { return shell(String(a.command ?? ""), { cwd: ctx.root, timeoutMs: ctx.timeoutMs }); },
  run_check(_a, ctx) { return ctx.check ? shell(ctx.check, { cwd: ctx.root, timeoutMs: ctx.timeoutMs }) : { ok: false, output: "no check command is configured for this workspace (--verify)" }; },
  propose_skill(a, ctx) { return ctx.skills ? ctx.skills.propose(a) : { ok: false, output: "skills are not enabled in this run" }; },
};

/** Run one tool call for a role. Never throws: a refusal or an error comes back as { ok: false, output }. */
export async function execute(name, args, ctx) {
  if (!impl[name] || !ctx.role.tools.includes(name)) return { ok: false, refused: true, output: impl[name] ? `${name} is not available to the ${ctx.role.name} role` : `there is no tool named ${name}` };
  try { return await impl[name](args ?? {}, ctx); } catch (e) { return { ok: false, output: String(e?.message ?? e) }; }
}
