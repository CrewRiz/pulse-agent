#!/usr/bin/env node
// pulse-agent: a coding agent that improves only on evidence. See README.md.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "./lib/loop.mjs";
import { openaiCompatible } from "./lib/provider.mjs";
import { openMemory } from "./lib/memory.mjs";
import { openSkills } from "./lib/skills.mjs";
import { ROLES } from "./lib/roles.mjs";

const HELP = `pulse-agent — a coding agent that improves only on evidence

usage: pulse-agent <command> [options]          (run it in the project you want it to work on)

  run "<task>" [--verify "<command>"] [--role builder|evaluator] [--model M] [--base-url URL] [--max-steps N] [--max-rounds N]
        work on the task with tools confined to this directory. With --verify, that command decides whether the task
        succeeded (exit 0 = pass); a failure goes back to the model, up to --max-rounds times (default 3).
        Exit code: 0 pass or unverified, 2 the check failed, 1 an error.
  skills [show|accept|reject <name>]
        procedures the agent proposed after verified runs. A proposal is never used until you accept it.
  lessons
        what verified runs taught: a check that failed, then passed, and which files changed in between.
  sync  commit the agent's state (.memory-pulse ledger, .pulse-agent skills) to git here and push if a remote exists.

Model: any endpoint that speaks the OpenAI chat-completions shape with tool calls, local or hosted.
  PULSE_AGENT_MODEL      model name (or --model)
  PULSE_AGENT_BASE_URL   default http://127.0.0.1:11434/v1, a local Ollama (or --base-url)
  PULSE_AGENT_API_KEY    only if your endpoint needs one

Memory: a memory-pulse ledger in .memory-pulse/events.jsonl. Its corrections block a write that puts a withdrawn value
back, and before each task the ledger is asked whether the same thing was already tried and closed.`;

const argv = process.argv.slice(2), cmd = argv[0], root = process.cwd();
const VALUED = new Set(["--verify", "--role", "--model", "--base-url", "--api-key", "--max-steps", "--max-rounds"]);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !VALUED.has(all[i - 1]));
const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };
const git = (args, o = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o });

async function main() {
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") return console.log(HELP);
  if (cmd === "run") {
    const task = positional.join(" ").trim(); if (!task) fail('usage: pulse-agent run "<task>" [--verify "<command>"]');
    const model = opt("--model") ?? process.env.PULSE_AGENT_MODEL; if (!model) fail("no model: set PULSE_AGENT_MODEL or pass --model (for a local Ollama: --model <name from `ollama list`>)");
    const role = opt("--role") ?? "builder"; if (!ROLES[role]) fail(`no role named ${role}; roles: ${Object.keys(ROLES).join(", ")}`);
    const num = (n, d) => { const v = opt(n); if (v === undefined) return d; const x = Number(v); if (!Number.isInteger(x) || x < 1) fail(`${n} must be a whole number of 1 or more`); return x; };
    const r = await runTask({ root, task, role, verify: opt("--verify"), maxSteps: num("--max-steps", 30), maxRounds: num("--max-rounds", 3),
      model: openaiCompatible({ baseUrl: opt("--base-url") ?? process.env.PULSE_AGENT_BASE_URL, model, apiKey: opt("--api-key") ?? process.env.PULSE_AGENT_API_KEY }),
      onEvent: (e) => console.log(e.type === "tool" ? `  ${e.refused ? "refused" : e.ok ? "ok     " : "failed "} ${e.name}${e.args?.path ? ` ${e.args.path}` : e.args?.command ? ` ${String(e.args.command).slice(0, 80)}` : ""}` : `  check ${e.ok ? "passed" : `failed (exit ${e.code})`}`) });
    if (r.drift.length) console.log(`ledger: ${r.drift.length} row(s) may bear on this task, ${r.drift.filter((d) => d.closed).length} closed or failed (shown to the model)`);
    if (r.answer) console.log(`\n${r.answer}\n`);
    console.log(`verdict: ${r.verdict}${r.stopped ? ` (stopped at the ${r.stopped})` : ""} · ${r.steps} step(s)${r.rounds ? ` · ${r.rounds} check round(s)` : ""}`);
    console.log(`files changed: ${r.changed.join(", ") || "none"}`);
    if (r.proposed.length) console.log(`skills proposed (held for you): ${r.proposed.join(", ")} — pulse-agent skills`);
    if (r.verdict === "unverified") console.log("no --verify command: this run is on the record as unverified and taught nothing");
    process.exit(r.verdict === "fail" ? 2 : 0);
  }
  if (cmd === "skills") {
    const sk = openSkills(root), [sub, name] = positional;
    if (!sub) { const l = sk.list(); console.log(`proposed (waiting for you): ${l.proposed.join(", ") || "none"}\naccepted (shown to the model when a task bears on them): ${l.accepted.join(", ") || "none"}`); if (l.proposed.length) console.log("review one with: pulse-agent skills show <name>   then: pulse-agent skills accept <name>  or  reject <name>"); return; }
    if (!name) fail("usage: pulse-agent skills show|accept|reject <name>");
    if (sub === "show") { for (const k of ["proposed", "accepted"]) { try { return console.log(sk.read(k, name)); } catch { /* try the next */ } } fail(`no skill named ${name}`); }
    if (sub === "accept" || sub === "reject") { const r = sk[sub](name); console.log(r.output); process.exit(r.ok ? 0 : 1); }
    fail(`unknown skills command ${sub}`);
  }
  if (cmd === "lessons") { const ls = openMemory(root).lessons(20); if (!ls.length) return console.log("no lessons yet: a lesson is recorded when a --verify check fails and then passes"); for (const l of ls) console.log(`t${l.t}  ${l.text}`); return; }
  if (cmd === "sync") {
    if (!existsSync(join(root, ".git"))) git(["init", "-q"]);
    const paths = [".memory-pulse/events.jsonl", ".pulse-agent"].filter((p) => existsSync(join(root, p))); if (!paths.length) return console.log("nothing to sync: no ledger and no skills here yet");
    git(["add", "-f", "--", ...paths]);
    const staged = git(["diff", "--cached", "--name-only", "--", ...paths]).trim();
    if (staged) { try { git(["commit", "-q", "-m", `pulse-agent state ${new Date().toISOString()}`, "--", ...paths]); } catch (e) { fail(`git could not commit: ${String(e.stderr ?? e.message).trim()}`); } console.log(`committed ${staged.split("\n").length} file(s) of agent state`); }
    else console.log("nothing new to commit");
    const remotes = git(["remote"]).trim();
    if (!remotes) return console.log("no remote: to keep state on GitHub, create a private repository and run `git remote add origin <url>`, then sync again");
    try { git(["push", "-q", remotes.split("\n")[0], "HEAD"]); console.log(`pushed to ${remotes.split("\n")[0]}`); } catch (e) { fail(`push failed: ${String(e.stderr ?? e.message).trim()}`); }
    return;
  }
  fail(`unknown command ${cmd}; pulse-agent --help lists the commands`);
}
main().catch((e) => fail(`pulse-agent: ${e?.message ?? e}`));
