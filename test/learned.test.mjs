import { workspace, scripted } from "./_helpers.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { learnedBefore } from "../lib/learned.mjs";
import { runTask } from "../lib/loop.mjs";
import { openMemory } from "../lib/memory.mjs";

const seen = []; let respond, api;
const fake = createServer((req, res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => { let b = Buffer.concat(c); if (req.headers["content-encoding"] === "gzip") b = gunzipSync(b); seen.push({ url: req.url, key: req.headers["x-mp-key"], body: JSON.parse(b.toString("utf8")) }); const r = respond(); res.writeHead(r.status, { "content-type": "application/json" }); res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body)); }); });
before(async () => { await new Promise((ok) => fake.listen(0, "127.0.0.1", ok)); api = `http://127.0.0.1:${fake.address().port}`; });
after(() => fake.close());
const HIT = { rung: "associative", hits: [{ t: 2, cause: "price-set-49", effect: "price-corrected-to-29", withdrawn: ["$49"], replacement: ["$29"], why: "4.2σ over 2 registers" }], learned: { events: 2, vocab: 9, registers: 1 } };
const sys = (m) => m.seen[0].messages[0].content;

test("the learned read asks the engine with the ledger rows and the task, under the key, and returns its hits", async () => {
  respond = () => ({ status: 200, body: HIT }); seen.length = 0;
  const r = await learnedBefore({ events: [{ t: 1, cause: "a", effect: "b" }], operation: "write the pricing page", key: "k1", api });
  assert.equal(r.rung, "associative"); assert.equal(r.hits[0].t, 2);
  assert.equal(seen[0].url, "/v1/before"); assert.equal(seen[0].key, "k1"); assert.equal(seen[0].body.operation, "write the pricing page"); assert.equal(seen[0].body.events.length, 1);
});

test("it never throws and never guesses: no key, an error status, a dead endpoint and a body that is not JSON each say why it is unavailable", async () => {
  seen.length = 0;
  assert.match((await learnedBefore({ events: [], operation: "x", key: "", api })).unavailable, /no key/); assert.equal(seen.length, 0, "without a key nothing is sent");
  respond = () => ({ status: 401, body: { error: "unknown license key" } });
  assert.match((await learnedBefore({ events: [], operation: "x", key: "k", api })).unavailable, /401.*unknown license key/);
  respond = () => ({ status: 200, body: "<html>oops" });
  assert.match((await learnedBefore({ events: [], operation: "x", key: "k", api })).unavailable, /did not answer in JSON/);
  assert.match((await learnedBefore({ events: [], operation: "x", key: "k", api: "http://127.0.0.1:1" })).unavailable, /could not reach/);
});

test("a run uses the learned read only when a key is set; its corrections are in the prompt, and a failure leaves the local check standing", async () => {
  const root = workspace(), mem = openMemory(root);
  mem.remember({ cause: "price-set-49", effect: "price-corrected-to-29", kind: "correction", withdrawn: ["$49"], replacement: ["$29"], note: "WTP is $29" });
  seen.length = 0; respond = () => ({ status: 200, body: HIT });
  const off = scripted([{ content: "ok" }]); const r0 = await runTask({ root, task: "write the pricing page", model: off });
  assert.equal(seen.length, 0, "no key: the ledger never leaves the machine"); assert.equal(r0.learned, null); assert.ok(!/learned read/i.test(sys(off)));
  const on = scripted([{ content: "ok" }]); const r1 = await runTask({ root, task: "write the pricing page", model: on, learned: { key: "k1", api } });
  assert.equal(seen.length, 1); assert.equal(r1.learned.rung, "associative");
  assert.match(sys(on), /learned read/i); assert.match(sys(on), /t2.*price-set-49.*price-corrected-to-29/); assert.match(sys(on), /\$29/);
  respond = () => ({ status: 500, body: "error code: 1101" });
  const down = scripted([{ content: "ok" }]); const r2 = await runTask({ root, task: "write the pricing page", model: down, learned: { key: "k1", api } });
  assert.match(r2.learned.unavailable, /500/); assert.ok(!/learned read/i.test(sys(down)), "an unavailable read adds nothing to the prompt"); assert.equal(r2.answer, "ok");
});
