// Connectors. A connector is a Model Context Protocol server: the open standard other agents use for their tools, so a
// server written for any of them works here unchanged. This is a small stdio client: start the server, initialize, list
// its tools, call them. Each tool is offered to the model as mcp__<server>__<tool>. A connector runs outside the workspace
// boundary with your user's permissions, so it is opt-in per project and can be limited to named tools.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// a server may list its tools in pages; read them all (bounded, so a server that never stops cannot hold the agent)
async function listAll(ask) { const out = []; let cursor; for (let i = 0; i < 50; i++) { const r = await ask(cursor ? { cursor } : {}); out.push(...(r?.tools ?? [])); cursor = r?.nextCursor; if (!cursor) break; } return out; }
const text = (content) => (Array.isArray(content) ? content.map((c) => (c?.type === "text" ? c.text : `[${c?.type ?? "content"}]`)).join("\n") : String(content ?? ""));

export function connect(name, { command, args = [], env = {}, passEnv = [], tools: allow = null }, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    // a connector gets a minimal environment, not the agent's: no API keys or tokens unless the project's config names them
    const base = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", ...passEnv].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    let child; try { child = spawn(command, args, { env: { ...base, ...env }, stdio: ["pipe", "pipe", "ignore"] }); } catch (e) { return reject(new Error(String(e.message))); }
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
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pulse-agent", version: "0.10.0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = await listAll((params) => rpc("tools/list", params)), offered = listed.filter((t) => !allow || allow.includes(t.name));
      resolve({
        name, close, names: new Set(offered.map((t) => t.name)),
        tools: offered.map((t) => ({ type: "function", function: { name: `mcp__${name}__${t.name}`, description: String(t.description ?? "").slice(0, 600), parameters: t.inputSchema ?? { type: "object", properties: {} } } })),
        async call(tool, a) { try { const r = await rpc("tools/call", { name: tool, arguments: a ?? {} }); return { ok: !r?.isError, output: text(r?.content).slice(0, 12000) }; } catch (e) { return { ok: false, output: String(e.message) }; } },
      });
    })().catch((e) => { close(); reject(e); });
  });
}

/** A connector reached over HTTP (MCP's streamable HTTP transport): each request is a POST; the reply is JSON or an event stream. */
export async function connectHttp(name, { url, headers = {}, tools: allow = null }, { timeoutMs = 15000 } = {}) {
  let id = 0, session = null;
  const post = async (method, params, notify = false) => {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), ...headers },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }) });
    session = res.headers.get("mcp-session-id") ?? session;
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    if (notify) return null;
    const body = await res.text(), want = id;
    const msgs = /text\/event-stream/i.test(res.headers.get("content-type") ?? "") ? body.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean) : [JSON.parse(body)];
    const m = msgs.find((x) => x.id === want); if (!m) throw new Error(`${url} did not answer ${method}`);
    if (m.error) throw new Error(m.error.message ?? "connector error"); return m.result;
  };
  await post("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pulse-agent", version: "0.10.0" } });
  await post("notifications/initialized", undefined, true).catch(() => {});
  const listed = await listAll((params) => post("tools/list", params)), offered = listed.filter((t) => !allow || allow.includes(t.name));
  return { name, close() {}, names: new Set(offered.map((t) => t.name)),
    tools: offered.map((t) => ({ type: "function", function: { name: `mcp__${name}__${t.name}`, description: String(t.description ?? "").slice(0, 600), parameters: t.inputSchema ?? { type: "object", properties: {} } } })),
    async call(tool, a) { try { const r = await post("tools/call", { name: tool, arguments: a ?? {} }); return { ok: !r?.isError, output: text(r?.content).slice(0, 12000) }; } catch (e) { return { ok: false, output: String(e.message) }; } } };
}

// ${NAME} in a header or an env value is filled from the environment when the connector starts, so a token never has to be
// written into a project's config file. A name that is not set stops that connector; the placeholder is never sent as it is.
function expand(cfg) {
  const fill = (v) => String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n) => { if (process.env[n] === undefined) throw new Error(`the environment variable ${n} is not set`); return process.env[n]; });
  const map = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v)])) : o);
  return { ...cfg, ...(cfg.headers ? { headers: map(cfg.headers) } : {}), ...(cfg.env ? { env: map(cfg.env) } : {}) };
}

/** Start every configured connector. One that fails is listed in `failed` and the rest carry on. */
export async function connectAll(servers = {}, opts) {
  const live = new Map(), failed = [];
  await Promise.all(Object.entries(servers).map(async ([name, cfg]) => { try { if (!/^[a-zA-Z0-9_-]+$/.test(name) || !(cfg?.command || cfg?.url)) throw new Error("a connector needs a simple name and a command or a url"); const c = expand(cfg); live.set(name, c.url ? await connectHttp(name, c, opts) : await connect(name, c, opts)); } catch (e) { failed.push({ name, reason: String(e.message) }); } }));
  return {
    // in name order, whatever order the servers answered in: the same bytes every session, which a prompt cache needs
    failed, tools: [...live.values()].flatMap((c) => c.tools).sort((a, b) => (a.function.name < b.function.name ? -1 : 1)),
    async call(full, args) { const m = /^mcp__([a-zA-Z0-9_-]+?)__(.+)$/.exec(full), c = m && live.get(m[1]); if (!c || !c.names.has(m[2])) return { ok: false, refused: true, output: `there is no connector tool named ${full}` }; return c.call(m[2], args); },
    close() { for (const c of live.values()) c.close(); },
  };
}
