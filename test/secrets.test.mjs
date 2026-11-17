// No extra steps: a connector's token can be kept in a personal secrets file (outside every project, readable by you alone)
// so nothing has to be exported in a shell profile, and an approval rule can be personal and global so it does not have to
// be repeated in every project. The environment still wins over the file, and a project can never read or set either.
import { workspace } from "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { connectAll } from "../lib/mcp.mjs";
import { setSecret, secretNames, removeSecret, globalRules, addGlobalRule } from "../lib/trust.mjs";

const CLI = join(fileURLToPath(new URL(".", import.meta.url)), "..", "cli.mjs");
const run = (cwd, args, { input = "", env = {} } = {}) => new Promise((done) => { const c = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env } }); let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); c.on("close", (code) => done({ code, out })); c.stdin.end(input); });

test("a secret is set from standard input, kept in a file only you can read, listed by name only, and removable", async () => {
  const root = workspace();
  const s = await run(root, ["secret", "set", "MY_TOKEN"], { input: "tok-12345\n" }); assert.equal(s.code, 0, s.out); assert.ok(!s.out.includes("tok-12345"), "the value is never printed");
  const file = join(process.env.PULSE_AGENT_HOME, "secrets.json"); assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(JSON.parse(readFileSync(file, "utf8")).MY_TOKEN, "tok-12345");
  const l = await run(root, ["secret", "list"]); assert.match(l.out, /MY_TOKEN/); assert.ok(!l.out.includes("tok-12345"));
  assert.equal((await run(root, ["secret", "set", "bad name"], { input: "x" })).code, 1); assert.equal((await run(root, ["secret", "set", "EMPTY"], { input: "\n" })).code, 1);
  const onArgv = await run(root, ["secret", "set", "ARGV", "value-on-argv"], { input: "piped" }); assert.equal(onArgv.code, 1, "a value on the command line would land in shell history"); assert.match(onArgv.out, /shell history/); assert.ok(!secretNames().includes("ARGV"));
  assert.ok(!readdirSync(root).some((f) => /secret/.test(f)) && !existsSync(join(root, ".pulse-agent", "secrets.json")), "nothing is written into the project");
  assert.equal((await run(root, ["secret", "remove", "MY_TOKEN"])).code, 0); assert.deepEqual(secretNames(), []);
});

test("a connector header is filled from the environment first, then from the personal secrets; with neither, the connector stops and the placeholder is never sent", async () => {
  const seen = []; const srv = createServer((req, res) => { seen.push(req.headers.authorization); const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { const m = JSON.parse(Buffer.concat(c).toString() || "{}"); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "tools/list" ? { tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }] } : {} })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); const cfg = { c: { url: `http://127.0.0.1:${srv.address().port}/mcp`, headers: { authorization: "Bearer ${PA_TEST_SECRET}" } } };
  delete process.env.PA_TEST_SECRET; removeSecret("PA_TEST_SECRET");
  try {
  const none = await connectAll(cfg); assert.equal(none.failed.length, 1); assert.match(none.failed[0].reason, /PA_TEST_SECRET is not set.*pulse-agent secret set PA_TEST_SECRET/); assert.equal(seen.length, 0);
  setSecret("PA_TEST_SECRET", "from-file"); const f = await connectAll(cfg); assert.equal(f.failed.length, 0); assert.equal(seen.at(-1), "Bearer from-file"); f.close();
  process.env.PA_TEST_SECRET = "from-env"; const e = await connectAll(cfg); assert.equal(seen.at(-1), "Bearer from-env", "the environment wins"); e.close();
  } finally { delete process.env.PA_TEST_SECRET; removeSecret("PA_TEST_SECRET"); srv.closeAllConnections(); srv.close(); }
});

test("a personal rule can be global: it applies in every project, and adding a connector can allow named tools in the same command", async () => {
  const a = workspace(), b = workspace();
  const g = await run(a, ["allow", "--global", "mcp:cloud__inbox"]); assert.equal(g.code, 0, g.out); assert.match(g.out, /every project/);
  assert.deepEqual(globalRules(), ["mcp:cloud__inbox"]); addGlobalRule("mcp:cloud__inbox"); assert.equal(globalRules().length, 1, "no duplicates");
  assert.equal((await run(a, ["allow", "--global", "run:*"])).code, 1, "a global rule that allows every command is refused"); assert.equal((await run(a, ["allow", "--global", "edit:*"])).code, 1);
  const add = await run(b, ["connectors", "add", "svc", "--global", "--url", "http://127.0.0.1:1/mcp", "--allow", "read_thing,list_things"]); assert.equal(add.code, 0, add.out); assert.match(add.out, /allowed without asking: read_thing, list_things/);
  assert.deepEqual(globalRules().sort(), ["mcp:cloud__inbox", "mcp:svc__list_things", "mcp:svc__read_thing"]);
  const shown = await run(b, ["allow"]); assert.match(shown.out, /mcp:svc__read_thing/, "the usage text lists the global rules in force");
});
