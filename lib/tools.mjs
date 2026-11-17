// The tools a model can call. Every call goes through execute(): the role's allowlist first, then the workspace boundary,
// then the ledger's guard on anything written. A refused call is answered with the reason and nothing runs.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, join } from "node:path";
import { spawn } from "node:child_process";
import { resolveIn } from "./workspace.mjs";

const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const S = { type: "string" };
export const TOOLS = [
  fn("read_file", "Read a text file in the workspace.", { path: S }, ["path"]),
  fn("list_files", "List the files under a folder of the workspace (default: all of it). Dependency and state folders are skipped.", { path: S }, []),
  fn("search", "Search the workspace's text files for a regular expression. Returns file:line: text for each match.", { pattern: S, path: S }, ["pattern"]),
  fn("script", "Run a short JavaScript program that calls tools and prints only what you need. Use it when a task needs several tool calls or large results (many files, long listings): what the tools return stays out of this conversation and only what you print comes back. Inside: `await tools.read_file({ path })` and the other tools return their text or throw; `print(x)` returns a line to you; top-level await works. The code itself cannot write files, start processes or use the network; it can only call tools.", { code: S }, ["code"]),
  fn("write_file", "Create or replace a file in the workspace with the given content.", { path: S, content: S }, ["path", "content"]),
  fn("edit_file", "Replace one exact occurrence of `old` with `new` in a file. Fails when `old` is missing or appears more than once.", { path: S, old: S, new: S }, ["path", "old", "new"]),
  fn("run", "Run a shell command in the workspace and get its exit code and the end of its output.", { command: S }, ["command"]),
  fn("run_background", "Start a long-running command (a dev server, a watcher) and keep working. Returns an id.", { command: S }, ["command"]),
  fn("read_output", "Read what a background command has printed since you last read it, and whether it is still running.", { id: S }, ["id"]),
  fn("kill_command", "Stop a background command and everything it started.", { id: S }, ["id"]),
  fn("run_check", "Run the check command the person configured for this workspace. Takes no command of your own.", {}, []),
  fn("delegate", "Hand one self-contained question or review to a subagent with a fresh context. role is scout (reads and searches, cannot change anything), evaluator (reads and runs the configured check) or worker (edits in its own copy of the project; you apply its result with apply_work). It sees only the task you write, so include what it needs. Several delegate calls in one turn run at the same time.", { role: S, task: S }, ["role", "task"]),
  fn("apply_work", "Apply a worker's changes to the project, by the work id it reported. All of it is applied, or none if it no longer fits.", { id: S }, ["id"]),
  fn("propose_skill", "Propose a reusable procedure learned in this task. It is held for a person to review and is kept only if the task's check passes.", { name: S, when: S, steps: S }, ["name", "when", "steps"]),
];
export const toolsFor = (role) => TOOLS.filter((t) => role.tools.includes(t.function.name));

const MAX_OUT = 6000;
const tail = (s) => (s.length > MAX_OUT ? `[... ${s.length - MAX_OUT} earlier characters cut]\n${s.slice(-MAX_OUT)}` : s);

export function shell(command, { cwd, timeoutMs = 120000, signal = null, input = null } = {}) {
  return new Promise((done) => {
    // its own process group, so a timeout or an interrupt stops the command AND everything it started
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: process.env, detached: true }); let out = "", why = null;
    const stop = (reason) => { why ??= reason; try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs), onAbort = () => stop("interrupted");
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    child.stdin.on("error", () => {}); child.stdin.end(input ?? "");
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); done(why ? { ok: false, code: null, output: tail(`${out}\n[${why}]`) } : { ok: code === 0, code, output: tail(out) }); });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, code: null, output: String(e.message) }); });
  });
}

// resolveIn returns the real path, so the workspace is made real too before a path is shown relative to it
const rel = (ctx, p) => relative(realpathSync(ctx.root), p);
const guarded = (ctx, text, full) => { const g = ctx.memory.guard(text, full); return g.blocked ? { ok: false, blocked: true, output: `not written. The ledger blocks this text:\n${g.reasons.map((r) => `  ${r}`).join("\n")}` } : null; };

const SKIP = new Set(["node_modules", ".git", ".memory-pulse", ".pulse-agent", "dist", "build", "target", ".venv", "__pycache__"]);
function walk(dir, base, out, cap) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= cap) return; if (SKIP.has(e.name)) continue; const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out, cap); else if (e.isFile()) out.push(relative(base, p));
  }
}

const impl = {
  read_file(a, ctx) { const p = resolveIn(ctx.root, a.path); if (!existsSync(p)) return { ok: false, output: `${a.path} does not exist` }; return { ok: true, output: tail(readFileSync(p, "utf8")) }; },
  list_files(a, ctx) { const base = realpathSync(ctx.root), out = []; walk(a.path ? resolveIn(ctx.root, a.path) : base, base, out, 2000); return { ok: true, output: out.length ? `${out.join("\n")}${out.length >= 2000 ? "\n[list cut at 2000 files]" : ""}` : "no files" }; },
  search(a, ctx) {
    let re; try { re = new RegExp(String(a.pattern ?? "")); } catch (e) { return { ok: false, output: `not a valid regular expression: ${e.message}` }; }
    const base = realpathSync(ctx.root), files = [], hits = []; walk(a.path ? resolveIn(ctx.root, a.path) : base, base, files, 5000);
    for (const f of files) { if (hits.length >= 200) break; let text; try { if (statSync(join(base, f)).size > 1048576) continue; text = readFileSync(join(base, f), "utf8"); } catch { continue; } if (text.includes("\u0000")) continue;
      text.split("\n").forEach((line, i) => { if (hits.length < 200 && re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`); }); }
    return { ok: true, output: hits.length ? `${hits.join("\n")}${hits.length >= 200 ? "\n[cut at 200 matches]" : ""}` : "no match" };
  },
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
  run(a, ctx) { return shell(String(a.command ?? ""), { cwd: ctx.root, timeoutMs: ctx.timeoutMs, signal: ctx.signal }); },
  run_background(a, ctx) { return ctx.jobs ? ctx.jobs.start(a.command) : { ok: false, output: "background commands are not available in this run" }; },
  read_output(a, ctx) { return ctx.jobs ? ctx.jobs.read(String(a.id ?? "")) : { ok: false, output: "no background commands" }; },
  kill_command(a, ctx) { return ctx.jobs ? ctx.jobs.kill(String(a.id ?? "")) : { ok: false, output: "no background commands" }; },
  run_check(_a, ctx) { return ctx.check ? shell(ctx.check, { cwd: ctx.root, timeoutMs: ctx.timeoutMs, signal: ctx.signal }) : { ok: false, output: "no check command is configured for this workspace (--verify)" }; },
  delegate(a, ctx) { return ctx.delegate ? ctx.delegate(a) : { ok: false, output: "delegation is not available in this run" }; },
  apply_work(a, ctx) { if (!ctx.work) return { ok: false, output: "there is no worker output in this run" }; const r = ctx.work.apply(a.id); for (const f of r.files ?? []) ctx.changed?.add(f); return { ok: r.ok, output: r.output }; },
  propose_skill(a, ctx) { return ctx.skills ? ctx.skills.propose(a) : { ok: false, output: "skills are not enabled in this run" }; },
};

/** Run one tool call for a role. Never throws: a refusal or an error comes back as { ok: false, output }. */
export async function execute(name, args, ctx) {
  if (!impl[name] || !ctx.role.tools.includes(name)) return { ok: false, refused: true, output: impl[name] ? `${name} is not available to the ${ctx.role.name} role` : `there is no tool named ${name}` };
  try { return await impl[name](args ?? {}, ctx); } catch (e) { return { ok: false, output: String(e?.message ?? e) }; }
}
