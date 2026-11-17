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
import { pack, unpack } from "./lib/pack.mjs";
import { onboard, loadConfig } from "./lib/onboard.mjs";
import { runTeam } from "./lib/team.mjs";
import { connectAll } from "./lib/mcp.mjs";
import { buildCapsule, verifyCapsule, importCapsule } from "memory-pulse/server.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const HELP = `pulse-agent — a coding agent that improves only on evidence

usage: pulse-agent <command> [options]          (run it in the project you want it to work on)

  init [--force] [--base-url URL] [--model M]
        set this project up without questions: find a model server running on this machine (Ollama, LM Studio, llama.cpp,
        MLX, vLLM), pick the first model that really calls a tool, find the project's own test command, and save
        .pulse-agent/config.json. Run it once per project.
  run "<task>" [--verify "<command>"] [--role builder|evaluator] [--model M] [--base-url URL] [--max-steps N] [--max-rounds N] [--no-learned]
        work on the task with tools confined to this directory. With --verify, that command decides whether the task
        succeeded (exit 0 = pass); a failure goes back to the model, up to --max-rounds times (default 3).
        Exit code: 0 pass or unverified, 2 the check failed, 1 an error.
  team "<task>" [same options as run] [--eval-model M]
        the builder does the task; then an evaluator that did not build it and cannot write reviews the change.
  connectors
        start each connector in .pulse-agent/config.json ("mcpServers", the same shape other agents use) and list its tools.
        A connector is any MCP server. The builder can call them; the evaluator cannot.
  skills [show|accept|reject <name>]
        procedures the agent proposed after verified runs. A proposal is never used until you accept it.
  lessons
        what verified runs taught: a check that failed, then passed, and which files changed in between.
  state export | verify <file> | import <file>
        export packs the ledger into a .rain state capsule (hash-chained rows, verified before packing) and compresses it
        to .pulse-agent/state/<time>.rainz. verify checks a file end to end. import restores or fast-forwards the ledger
        here from one, and refuses a damaged file or a ledger that diverged.
  sync  commit the agent's state (.memory-pulse ledger, .pulse-agent skills) to git here and push if a remote exists.

Model: any endpoint that speaks the OpenAI chat-completions shape with tool calls, local or hosted.
  PULSE_AGENT_MODEL      model name (or --model)
  PULSE_AGENT_BASE_URL   default http://127.0.0.1:11434/v1, a local Ollama (or --base-url)
  PULSE_AGENT_API_KEY    only if your endpoint needs one

Memory: a memory-pulse ledger in .memory-pulse/events.jsonl. Its corrections block a write that puts a withdrawn value
back, and before each task the ledger is asked whether the same thing was already tried and closed.
  MEMORY_PULSE_KEY       optional. With a key, each run also asks memory-pulse's engine which corrections bear on the
                         task (the learned read). That sends the ledger's rows to the engine. --no-learned turns it off.`;

const argv = process.argv.slice(2), cmd = argv[0], root = process.cwd();
const VALUED = new Set(["--verify", "--role", "--model", "--base-url", "--api-key", "--max-steps", "--max-rounds", "--eval-model"]);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !VALUED.has(all[i - 1]));
const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };
const git = (args, o = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o });

async function main() {
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") return console.log(HELP);
  if (cmd === "init") {
    const base = opt("--base-url") ?? process.env.PULSE_AGENT_BASE_URL;
    const r = await onboard({ root, endpoints: base ? [base] : undefined, model: opt("--model"), apiKey: opt("--api-key") ?? process.env.PULSE_AGENT_API_KEY, force: argv.includes("--force") });
    console.log(r.report); process.exit(r.ok ? 0 : 1);
  }
  if (cmd === "connectors") {
    const servers = loadConfig(root).mcpServers ?? {}; if (!Object.keys(servers).length) return console.log('no connectors configured. Add MCP servers under "mcpServers" in .pulse-agent/config.json, for example:\n  { "mcpServers": { "files": { "command": "npx", "args": ["-y", "<an MCP server package>"], "tools": ["read"] } } }');
    const set = await connectAll(servers);
    try { for (const name of Object.keys(servers)) { const f = set.failed.find((x) => x.name === name); console.log(f ? `${name}: FAILED: ${f.reason}` : `${name}: ${set.tools.filter((t) => t.function.name.startsWith(`mcp__${name}__`)).map((t) => t.function.name.split("__")[2]).join(", ") || "no tools"}`); } } finally { set.close(); }
    process.exit(set.failed.length ? 1 : 0);
  }
  if (cmd === "run" || cmd === "team") {
    const cfg = loadConfig(root), task = positional.join(" ").trim(); if (!task) fail(`usage: pulse-agent ${cmd} "<task>" [--verify "<command>"]`);
    const model = opt("--model") ?? process.env.PULSE_AGENT_MODEL ?? cfg.model; if (!model) fail("no model: run `pulse-agent init` to set this project up, or set PULSE_AGENT_MODEL or pass --model");
    const role = opt("--role") ?? "builder"; if (!ROLES[role]) fail(`no role named ${role}; roles: ${Object.keys(ROLES).join(", ")}`);
    const num = (n, d) => { const v = opt(n); if (v === undefined) return d; const x = Number(v); if (!Number.isInteger(x) || x < 1) fail(`${n} must be a whole number of 1 or more`); return x; };
    const baseUrl = opt("--base-url") ?? process.env.PULSE_AGENT_BASE_URL ?? cfg.baseUrl, apiKey = opt("--api-key") ?? process.env.PULSE_AGENT_API_KEY, verify = opt("--verify") ?? cfg.verify;
    const show = (e) => console.log(`${e.who ? `[${e.who}] ` : ""}${e.type === "tool" ? `  ${e.refused ? "refused" : e.ok ? "ok     " : "failed "} ${e.name}${e.args?.path ? ` ${e.args.path}` : e.args?.command ? ` ${String(e.args.command).slice(0, 80)}` : ""}` : e.type === "connector" ? `  connector ${e.name} did not start: ${e.reason}` : `  check ${e.ok ? "passed" : `failed (exit ${e.code})`}`}`);
    const common = { root, task, verify, maxSteps: num("--max-steps", 30), maxRounds: num("--max-rounds", 3), mcpServers: cfg.mcpServers ?? null, onEvent: show,
      learned: argv.includes("--no-learned") || !process.env.MEMORY_PULSE_KEY ? null : { key: process.env.MEMORY_PULSE_KEY, api: process.env.MEMORY_PULSE_API },
      model: openaiCompatible({ baseUrl, model, apiKey }) };
    let r, review = null;
    if (cmd === "team") { const t = await runTeam({ ...common, evalModel: opt("--eval-model") ? openaiCompatible({ baseUrl, model: opt("--eval-model"), apiKey }) : undefined }); r = t.build; review = t.review; }
    else r = await runTask({ ...common, role });
    if (r.drift.length) console.log(`ledger: ${r.drift.length} row(s) may bear on this task, ${r.drift.filter((d) => d.closed).length} closed or failed (shown to the model)`);
    if (r.learned) console.log(r.learned.unavailable ? `learned read unavailable: ${r.learned.unavailable}` : `learned read: ${r.learned.hits.length} correction(s) named (${r.learned.rung})`);
    if (r.answer) console.log(`\n${r.answer}\n`);
    console.log(`verdict: ${r.verdict}${r.stopped ? ` (stopped at the ${r.stopped})` : ""} · ${r.steps} step(s)${r.rounds ? ` · ${r.rounds} check round(s)` : ""}`);
    console.log(`files changed: ${r.changed.join(", ") || "none"}`);
    if (cmd === "team") console.log(review ? `\nevaluator's review:\n${review}\n` : "no review: nothing changed, or the check failed");
    if (r.proposed.length) console.log(`skills proposed (held for you): ${r.proposed.join(", ")} — pulse-agent skills`);
    if (r.verdict === "unverified") console.log("no check command: this run is on the record as unverified and taught nothing (pass --verify, or run `pulse-agent init`)");
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
  if (cmd === "state") {
    const [sub, file] = positional, mem = openMemory(root), kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    const open = (f) => { if (!f) fail(`usage: pulse-agent state ${sub} <file>`); let cap; try { cap = JSON.parse(unpack(readFileSync(f)).toString("utf8")); } catch (e) { fail(`${f}: ${e.message}`); } const v = verifyCapsule(cap); if (!v.ok) fail(`${f}: not a valid state capsule: ${v.reason}`); return cap; };
    if (sub === "export") {
      const b = buildCapsule({ ledger: mem.path }); if (b.error) fail(b.error);
      const raw = Buffer.from(JSON.stringify(b.capsule)), packed = pack(raw), dir = join(root, ".pulse-agent", "state"); mkdirSync(dir, { recursive: true });
      const out = join(dir, `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z")}.rainz`); writeFileSync(out, packed);
      return console.log(`${b.capsule.rows} row(s) through t=${b.capsule.through}, capsule ${kb(raw.length)}, packed ${kb(packed.length)} (${(100 * packed.length / raw.length).toFixed(0)}%)\n${out}`);
    }
    if (sub === "verify") { const cap = open(file); return console.log(`verified: ${cap.rows} row(s) through t=${cap.through}, issued ${cap.issued}, head ${String(cap.head).slice(0, 12)}`); }
    if (sub === "import") {
      const cap = open(file), old = process.env.MEMORY_PULSE_LEDGER; process.env.MEMORY_PULSE_LEDGER = mem.path;
      const r = importCapsule(cap); if (old === undefined) delete process.env.MEMORY_PULSE_LEDGER; else process.env.MEMORY_PULSE_LEDGER = old;
      console.log(`${r.status}${r.appended ? `: ${r.appended} row(s)` : ""}${r.reason ? `: ${r.reason}` : ""}`); process.exit(r.code ? 1 : 0);
    }
    fail("usage: pulse-agent state export | verify <file> | import <file>");
  }
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
