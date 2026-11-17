// Connectors. A connector is a Model Context Protocol server: the open standard other agents use for their tools, so a
// server written for any of them works here unchanged. This is a small stdio client: start the server, initialize, list
// its tools, call them. Each tool is offered to the model as mcp__<server>__<tool>. A connector runs outside the workspace
// boundary with your user's permissions, so it is opt-in per project and can be limited to named tools.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const text = (content) => (Array.isArray(content) ? content.map((c) => (c?.type === "text" ? c.text : `[${c?.type ?? "content"}]`)).join("\n") : String(content ?? ""));

export function connect(name, { command, args = [], env = {}, tools: allow = null }, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let child; try { child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] }); } catch (e) { return reject(new Error(String(e.message))); }
    const waiting = new Map(); let id = 0, dead = null;
    const fail = (why) => { dead = why; for (const w of waiting.values()) w.reject(new Error(why)); waiting.clear(); };
    child.on("error", (e) => { fail(`could not start ${command}: ${e.message}`); reject(new Error(dead)); });
    child.on("exit", (code) => fail(`the connector exited (code ${code})`));
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); clearTimeout(w.timer); m.error ? w.reject(new Error(m.error.message ?? "connector error")) : w.resolve(m.result); });
    const rpc = (method, params) => new Promise((ok, no) => {
      if (dead) return no(new Error(dead));
      const n = ++id, timer = setTimeout(() => { waiting.delete(n); no(new Error(`the connector did not answer ${method} within ${timeoutMs} ms`)); }, timeoutMs);
      waiting.set(n, { resolve: ok, reject: no, timer }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
    const close = () => { try { child.kill(); } catch { /* already gone */ } };
    (async () => {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pulse-agent", version: "0.4.0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = (await rpc("tools/list", {})).tools ?? [], offered = listed.filter((t) => !allow || allow.includes(t.name));
      resolve({
        name, close, names: new Set(offered.map((t) => t.name)),
        tools: offered.map((t) => ({ type: "function", function: { name: `mcp__${name}__${t.name}`, description: String(t.description ?? "").slice(0, 600), parameters: t.inputSchema ?? { type: "object", properties: {} } } })),
        async call(tool, a) { try { const r = await rpc("tools/call", { name: tool, arguments: a ?? {} }); return { ok: !r?.isError, output: text(r?.content).slice(0, 12000) }; } catch (e) { return { ok: false, output: String(e.message) }; } },
      });
    })().catch((e) => { close(); reject(e); });
  });
}

/** Start every configured connector. One that fails is listed in `failed` and the rest carry on. */
export async function connectAll(servers = {}, opts) {
  const live = new Map(), failed = [];
  await Promise.all(Object.entries(servers).map(async ([name, cfg]) => { try { if (!/^[a-zA-Z0-9_-]+$/.test(name) || !cfg?.command) throw new Error("a connector needs a simple name and a command"); live.set(name, await connect(name, cfg, opts)); } catch (e) { failed.push({ name, reason: String(e.message) }); } }));
  return {
    failed, tools: [...live.values()].flatMap((c) => c.tools),
    async call(full, args) { const m = /^mcp__([a-zA-Z0-9_-]+?)__(.+)$/.exec(full), c = m && live.get(m[1]); if (!c || !c.names.has(m[2])) return { ok: false, refused: true, output: `there is no connector tool named ${full}` }; return c.call(m[2], args); },
    close() { for (const c of live.values()) c.close(); },
  };
}
