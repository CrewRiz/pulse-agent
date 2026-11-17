// Code over tools. Instead of calling tools one at a time and carrying every result in the conversation, the model writes a
// short script that calls them, works on the results, and prints only what it needs. The files it read and the lists it
// filtered never enter the model's window.
// The script has no more rights than the tools. It runs in a separate Node process under the permission model: it cannot
// write files, read outside its own folder, start processes, use workers or reach the network. Its only way to act is to
// ask the parent for a tool call, and each of those goes through the same role limits, hook and approval rules as a call
// the model makes directly. If that confinement cannot be confirmed on this Node, the tool is not offered at all.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CAP = 6000, MAX_CALLS = 200;
const RUNNER = (names, code) => `import { createInterface } from "node:readline";
const __rl = createInterface({ input: process.stdin }), __pending = new Map(); let __n = 0;
const __out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
__rl.on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; } const p = __pending.get(m.id); if (!p) return; __pending.delete(m.id); m.ok ? p.res(m.output) : p.rej(new Error(m.output)); });
const tools = Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, (args = {}) => new Promise((res, rej) => { const id = ++__n; __pending.set(id, { res, rej }); __out({ t: "call", id, name, args }); })]));
const print = (...v) => __out({ t: "print", text: v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
try { await (async () => {
${code}
})(); __out({ t: "done" }); } catch (e) { __out({ t: "error", text: String(e?.stack ?? e).split("\\n").slice(0, 3).join("\\n") }); }
__rl.close();
`;

/** Run model-written code. `call(name, args)` performs one tool call for it and returns { ok, output }. */
export function runScript(code, { call, names = [], timeoutMs = 60000 } = {}) {
  return new Promise((done) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pa-script-"))); writeFileSync(join(dir, "runner.mjs"), RUNNER(names, String(code ?? "")));
    const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${dir}`, "--max-old-space-size=256", join(dir, "runner.mjs")], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
    let printed = "", err = "", stderr = "", calls = 0, timedOut = false, finished = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdin.on("error", () => {}); child.stderr.on("data", (d) => { stderr += d; });
    createInterface({ input: child.stdout }).on("line", async (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.t === "print") { if (printed.length < CAP) printed += `${m.text}\n`; }
      else if (m.t === "error") err = m.text;
      else if (m.t === "done") finished = true;
      else if (m.t === "call") {
        let r; if (++calls > MAX_CALLS) r = { ok: false, output: `a script may make at most ${MAX_CALLS} tool calls` };
        else if (!names.includes(m.name)) r = { ok: false, output: `no tool named ${m.name} is available to a script` };
        else { try { r = await call(m.name, m.args ?? {}); } catch (e) { r = { ok: false, output: String(e?.message ?? e) }; } }
        child.stdin.write(JSON.stringify({ id: m.id, ok: !!r.ok, output: String(r.output ?? "") }) + "\n");
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
      const text = printed.length > CAP ? `${printed.slice(0, CAP)}\n[output cut at ${CAP} characters]` : printed;
      if (timedOut) return done({ ok: false, calls, output: `${text}[the script was stopped at its time limit of ${timeoutMs} ms]` });
      if (err || !finished) return done({ ok: false, calls, output: `${text}${err || `the script did not finish (exit ${code}): ${stderr.trim().split("\n").slice(-3).join("\n").slice(0, 400)}`}` });
      done({ ok: true, calls, output: text || "(the script printed nothing; use print(...) for what you need)" });
    });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, calls, output: String(e.message) }); });
  });
}

let probe = null;
/** Is the confinement real on this Node? Asked once: a script tries to write, read elsewhere, spawn and connect, and every attempt must be denied. */
export function scriptAvailable() {
  probe ??= runScript(`const r = {};
try { (await import("node:fs")).writeFileSync(${JSON.stringify(join(tmpdir(), "pa-probe-should-not-exist"))}, "x"); r.write = "allowed"; } catch (e) { r.write = e.code; }
try { (await import("node:fs")).readFileSync(${JSON.stringify(process.execPath)}); r.read = "allowed"; } catch (e) { r.read = e.code; }
try { (await import("node:child_process")).spawnSync("true"); r.spawn = "allowed"; } catch (e) { r.spawn = e.code; }
try { await (await import("node:net")).default.connect; const s = (await import("node:net")).connect(9, "127.0.0.1"); await new Promise((ok, no) => { s.on("error", no); s.on("connect", ok); }); r.network = "allowed"; } catch (e) { r.network = e.code; }
print(JSON.stringify(r));`, { call: async () => ({ ok: false, output: "" }), timeoutMs: 15000 }).then((res) => {
    let r = {}; try { r = JSON.parse(res.output.trim().split("\n")[0]); } catch { return { ok: false, denied: [], reason: `this Node (${process.version}) could not run a confined script: ${res.output.slice(0, 160)}` }; }
    const denied = Object.keys(r).filter((k) => r[k] === "ERR_ACCESS_DENIED"), open = Object.keys(r).filter((k) => r[k] !== "ERR_ACCESS_DENIED");
    return open.length ? { ok: false, denied, reason: `this Node (${process.version}) does not confine: ${open.map((k) => `${k} (${r[k]})`).join(", ")}` } : { ok: true, denied };
  });
  return probe;
}
