import { workspace } from "./_helpers.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { onboard, detectCheck, loadConfig } from "../lib/onboard.mjs";

// a fake local model server: /v1/models lists ids; /v1/chat/completions calls the probe tool only for models named "*tools*"
const mk = (ids) => createServer((req, res) => {
  const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }));
    const body = JSON.parse(Buffer.concat(c).toString("utf8") || "{}");
    const message = /tools/.test(body.model) ? { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: body.tools[0].function.name, arguments: "{}" } }] } : { role: "assistant", content: "I would call the tool." };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});
const servers = { good: mk(["chat-only", "coder-tools-7b"]), prose: mk(["chat-only"]) }; const url = {};
before(async () => { for (const [k, s] of Object.entries(servers)) { await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); url[k] = `http://127.0.0.1:${s.address().port}/v1`; } });
after(() => { for (const s of Object.values(servers)) s.close(); });
const DEAD = "http://127.0.0.1:1/v1";

test("the check command is read from the project: npm test, pytest, cargo, go, make; a placeholder npm script is not a check", () => {
  const w = (files) => { const r = workspace(); for (const [f, t] of Object.entries(files)) { mkdirSync(join(r, f, ".."), { recursive: true }); writeFileSync(join(r, f), t); } return r; };
  assert.equal(detectCheck(w({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) })), "npm test");
  assert.equal(detectCheck(w({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })), null);
  assert.equal(detectCheck(w({ "pyproject.toml": "[tool.pytest.ini_options]\n" })), "python3 -m pytest -q");
  assert.equal(detectCheck(w({ "tests/test_a.py": "def test_a(): pass\n" })), "python3 -m pytest -q");
  assert.equal(detectCheck(w({ "Cargo.toml": "[package]\n" })), "cargo test");
  assert.equal(detectCheck(w({ "go.mod": "module x\n" })), "go test ./...");
  assert.equal(detectCheck(w({ Makefile: "build:\n\ttrue\ntest:\n\ttrue\n" })), "make test");
  assert.equal(detectCheck(w({ "README.md": "x" })), null);
});

test("onboarding finds a running local server, picks the first model that really calls a tool, and writes the config", async () => {
  const root = workspace(); writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const r = await onboard({ root, endpoints: [DEAD, url.good] });
  assert.equal(r.ok, true); assert.equal(r.config.baseUrl, url.good); assert.equal(r.config.model, "coder-tools-7b", "chat-only answered in prose and was passed over"); assert.equal(r.config.verify, "npm test");
  assert.deepEqual(loadConfig(root), r.config); assert.ok(existsSync(join(root, ".pulse-agent", "config.json")));
  assert.match(r.report, /coder-tools-7b/); assert.match(r.report, /calls tools/); assert.match(r.report, /npm test/); assert.match(r.report, /pulse-agent run/);
  assert.ok(r.tried.some((t) => t.model === "chat-only" && t.tools === false));
});

test("a model you name is used if it calls tools and refused, with the reason, if it does not; nothing is written on a refusal", async () => {
  const root = workspace();
  const named = await onboard({ root, endpoints: [url.good], model: "coder-tools-7b" }); assert.equal(named.config.model, "coder-tools-7b");
  const r2 = workspace(), no = await onboard({ root: r2, endpoints: [url.good], model: "chat-only" });
  assert.equal(no.ok, false); assert.match(no.report, /chat-only.*did not call the tool/s); assert.equal(existsSync(join(r2, ".pulse-agent", "config.json")), false);
});

test("no server, or a server with no model that calls tools, is said plainly with what to do next; an existing config is kept unless forced", async () => {
  const a = workspace(), none = await onboard({ root: a, endpoints: [DEAD] });
  assert.equal(none.ok, false); assert.match(none.report, /no local model server/i); assert.match(none.report, /ollama|LM Studio/); assert.equal(existsSync(join(a, ".pulse-agent", "config.json")), false);
  const b = workspace(), prose = await onboard({ root: b, endpoints: [url.prose] });
  assert.equal(prose.ok, false); assert.match(prose.report, /none of its models called a tool/i);
  const c = workspace(); await onboard({ root: c, endpoints: [url.good] }); writeFileSync(join(c, ".pulse-agent", "config.json"), JSON.stringify({ model: "mine", baseUrl: "http://x/v1", verify: "make test", mcpServers: { fs: { command: "x" } } }));
  const kept = await onboard({ root: c, endpoints: [url.good] }); assert.equal(kept.ok, true); assert.equal(loadConfig(c).model, "mine"); assert.match(kept.report, /already set up/);
  const forced = await onboard({ root: c, endpoints: [url.good], force: true }); assert.equal(loadConfig(c).model, "coder-tools-7b"); assert.deepEqual(loadConfig(c).mcpServers, { fs: { command: "x" } }, "connectors survive a re-run");
  assert.equal(forced.ok, true);
});
