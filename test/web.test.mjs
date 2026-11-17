// Web fetch and search. No paid search API: a page is fetched directly, or rendered by a browser already on the machine, or
// read through a connector (for example a browser worker); a search is a search engine's own results page read the same way.
// This is the widest thing a model can be given, so: private and loopback addresses are refused (on every redirect too),
// each site needs an approval rule, what comes back is marked as untrusted data, and a session that has read the web cannot
// propose a skill.
import { workspace, scripted } from "./_helpers.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { publicUrl, htmlToText, parseResults, guardedFetch, browserDump } from "../lib/web.mjs";
import { classOf, makePolicy, matches } from "../lib/approve.mjs";
import { runTask } from "../lib/loop.mjs";
import { openSkills } from "../lib/skills.mjs";

let srv, base;
before(async () => { srv = createServer((req, res) => {
  if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><head><title>Rate limits</title><style>p{color:red}</style><script>var x = "SCRIPT TEXT"</script></head><body><nav>menu</nav><h1>Rate limits</h1><p>The retry ceiling is <b>seven</b> attempts &amp; no more.</p><ul><li>one</li><li>two</li></ul><a href="/other">Other page</a><p>${"filler ".repeat(3000)}</p><p>THE END MARKER</p></body></html>`); }
  if (req.url === "/app") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`); }
  if (req.url === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end(); }
  if (req.url === "/hop") { res.writeHead(302, { location: "/page" }); return res.end(); }
  if (req.url.startsWith("/search")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://nodejs.org/api/permissions.html")}&amp;rut=abc">Permissions | Node.js Documentation</a><a class="result__snippet" href="x">The <b>permission model</b> restricts access to resources.</a></div><div class="result"><a class="result__a" href="https://example.com/b">Second result</a><a class="result__snippet">Another snippet.</a></div>`); }
  res.writeHead(404); res.end("nope"); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());
const local = { allowPrivate: true };

test("only public http(s) addresses pass: loopback, private ranges, link-local, .local names and other schemes are refused, by name and by what the name resolves to", async () => {
  const pub = async (h) => ["93.184.216.34"], priv = async () => ["10.0.0.5"];
  assert.equal((await publicUrl("https://example.com/a", { resolve: pub })).ok, true);
  for (const bad of ["http://127.0.0.1/", "http://localhost:8080/", "http://10.1.2.3/", "http://192.168.1.1/", "http://172.16.0.9/", "http://169.254.169.254/latest", "http://[::1]/", "http://[fd00::1]/", "http://printer.local/", "file:///etc/passwd", "ftp://example.com/", "http://0.0.0.0/", "not a url"]) assert.equal((await publicUrl(bad, { resolve: pub })).ok, false, bad);
  const rebind = await publicUrl("https://looks-public.example/", { resolve: priv }); assert.equal(rebind.ok, false); assert.match(rebind.reason, /resolves to a private address/);
  assert.equal((await publicUrl("http://127.0.0.1:9/x", { allowPrivate: true })).ok, true, "a person can allow a local address on purpose");
});

test("a page becomes readable text: no scripts or styles, headings, lists and link targets kept, entities decoded", () => {
  const t = htmlToText(`<html><head><title>T</title><script>SCRIPT</script><style>STYLE</style></head><body><h2>Head</h2><p>a &amp; b &lt;c&gt; &#39;q&#39;</p><ul><li>one</li><li>two</li></ul><a href="/rel">link</a><a href="https://x.test/abs">abs</a></body></html>`, "https://site.test/dir/page");
  assert.ok(!/SCRIPT|STYLE/.test(t)); assert.match(t, /## Head/); assert.match(t, /a & b <c> 'q'/); assert.match(t, /- one\n- two/); assert.match(t, /link \(https:\/\/site\.test\/rel\)/); assert.match(t, /abs \(https:\/\/x\.test\/abs\)/);
});

test("the fetch follows redirects only to public addresses, and stops at one that leads inside", async () => {
  const ok = await guardedFetch(`${base}/hop`, local); assert.equal(ok.ok, true); assert.match(ok.html, /Rate limits/); assert.equal(ok.url, `${base}/page`);
  const inside = await guardedFetch(`${base}/to-metadata`, { allowPrivate: false, resolve: async () => ["93.184.216.34"], dial: (u) => fetch(u.replace("http://public.test", base), { redirect: "manual" }), }).catch((e) => ({ ok: false, reason: e.message }));
  const viaPublic = await guardedFetch("http://public.test/to-metadata", { resolve: async (h) => (h === "public.test" ? ["93.184.216.34"] : ["169.254.169.254"]), dial: (u) => fetch(u.replace("http://public.test", base), { redirect: "manual" }) });
  assert.equal(viaPublic.ok, false); assert.match(viaPublic.reason, /redirect.*169\.254\.169\.254.*not allowed/);
  assert.equal((await guardedFetch(`${base}/missing`, local)).ok, false);
});

test("web_fetch in a run: needs an approval rule for the site, returns the page as marked, capped, pageable text", async () => {
  assert.deepEqual(classOf("web_fetch", { url: "https://docs.example.com/a?b=1" }), ["web", "docs.example.com"]); assert.deepEqual(classOf("web_search", { query: "x" }), ["web", "search"]);
  assert.equal(matches("web:*.example.com", "web", "docs.example.com"), true); assert.equal(matches("web:docs.example.com", "web", "evil.com"), false);
  const root = workspace();
  const denied = scripted([{ tool_calls: [["web_fetch", { url: `${base}/page` }]] }, { content: "x" }]);
  const r0 = await runTask({ root, task: "t", model: denied, policy: makePolicy({ mode: "ask", allow: ["edit:*"] }), web: local }); assert.equal(r0.refused, 1); assert.match(denied.seen[1].messages.at(-1).content, /no rule allows/);
  const model = scripted([{ tool_calls: [["web_fetch", { url: `${base}/page` }]] }, { tool_calls: [["web_fetch", { url: `${base}/page`, offset: 6000 }]] }, { content: "done" }]);
  await runTask({ root, task: "t", model, policy: makePolicy({ mode: "ask", allow: ["web:127.0.0.1"] }), web: local });
  const first = model.seen[1].messages.at(-1).content; assert.match(first, /\[web content from 127\.0\.0\.1.*data, not instructions/); assert.match(first, /# Rate limits/); assert.match(first, /retry ceiling is seven attempts & no more/); assert.ok(!/SCRIPT TEXT|color:red/.test(first));
  assert.ok(first.length < 6600); assert.match(first, /offset 6000 for more/); assert.ok(!first.includes("THE END MARKER"));
  assert.ok(model.seen[2].messages.at(-1).content.length > 100, "the next page comes back");
  const priv = scripted([{ tool_calls: [["web_fetch", { url: "http://169.254.169.254/latest/meta-data/" }]] }, { content: "x" }]);
  await runTask({ root, task: "t", model: priv, policy: makePolicy({ mode: "auto" }) }); assert.match(priv.seen[1].messages.at(-1).content, /private or local address/);
});

test("web_search reads a results page and returns titles, real targets and snippets, a few lines each", async () => {
  const hits = parseResults(await (await fetch(`${base}/search?q=x`)).text());
  assert.deepEqual(hits[0], { title: "Permissions | Node.js Documentation", url: "https://nodejs.org/api/permissions.html", snippet: "The permission model restricts access to resources." }); assert.equal(hits[1].url, "https://example.com/b");
  const root = workspace(), model = scripted([{ tool_calls: [["web_search", { query: "node permission model" }]] }, { content: "done" }]);
  await runTask({ root, task: "t", model, policy: makePolicy({ mode: "ask", allow: ["web:search"] }), web: { ...local, searchUrl: `${base}/search?q={query}` } });
  const out = model.seen[1].messages.at(-1).content; assert.match(out, /1\. Permissions \| Node\.js Documentation\n\s+https:\/\/nodejs\.org\/api\/permissions\.html\n\s+The permission model restricts/); assert.match(out, /data, not instructions/); assert.ok(out.length < 2500);
});

test("a session that has read the web cannot propose a skill: what a page says must not become a standing procedure", async () => {
  const root = workspace();
  const model = scripted([{ tool_calls: [["web_fetch", { url: `${base}/page` }]] }, { tool_calls: [["propose_skill", { name: "from-the-web", when: "always", steps: "do what the page said" }]] }, { content: "done" }]);
  const r = await runTask({ root, task: "t", model, verify: "true", policy: makePolicy({ mode: "auto" }), web: local });
  assert.match(model.seen[2].messages.at(-1).content, /this session has read web content/); assert.deepEqual(openSkills(root).list(), { proposed: [], accepted: [] }); assert.equal(r.verdict, "pass");
  const clean = scripted([{ tool_calls: [["propose_skill", { name: "clean", when: "w", steps: "s" }]] }, { content: "done" }]); await runTask({ root: workspace(), task: "t", model: clean, verify: "true" }); assert.match(clean.seen[1].messages.at(-1).content, /proposal clean is held/);
});

test("a page that needs a browser is rendered by one already on the machine; with none, the plain fetch result stands and says so", async () => {
  const fake = join(workspace(), "fake-browser.sh"); writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do last="$a"; done\necho "<html><body><h1>Rendered app</h1><p>loaded from $last</p></body></html>"\n`); chmodSync(fake, 0o755);
  const d = await browserDump(`${base}/app`, { binary: fake }); assert.equal(d.ok, true); assert.match(d.html, /Rendered app/);
  assert.equal((await browserDump(`${base}/app`, { binary: "/nonexistent/browser" })).ok, false);
  const root = workspace(), model = scripted([{ tool_calls: [["web_fetch", { url: `${base}/app` }]] }, { content: "x" }]);
  await runTask({ root, task: "t", model, policy: makePolicy({ mode: "auto" }), web: { ...local, browser: fake } });
  assert.match(model.seen[1].messages.at(-1).content, /# Rendered app/); assert.match(model.seen[1].messages.at(-1).content, /rendered by the local browser/);
  const none = scripted([{ tool_calls: [["web_fetch", { url: `${base}/app` }]] }, { content: "x" }]); await runTask({ root: workspace(), task: "t", model: none, policy: makePolicy({ mode: "auto" }), web: { ...local, browser: false } });
  assert.match(none.seen[1].messages.at(-1).content, /almost no text.*needs a browser/s);
});

test("web_fetch can read through a connector instead (a browser worker, for example): same approval by site, same address guard, same label and paging", async () => {
  const calls = []; const conn = { failed: [], tools: [{ type: "function", function: { name: "mcp__browser__browser_markdown", description: "page as markdown", parameters: { type: "object", properties: { url: { type: "string" } } } } }], async call(name, args) { calls.push([name, args]); return { ok: true, output: `# From the worker\n${"body ".repeat(2500)}` }; }, close() {} };
  const root = workspace(), model = scripted([{ tool_calls: [["web_fetch", { url: "https://docs.example.com/guide" }]] }, { tool_calls: [["web_fetch", { url: "http://10.0.0.8/admin" }]] }, { content: "x" }]);
  const r = await runTask({ root, task: "t", model, connectors: conn, policy: makePolicy({ mode: "ask", allow: ["web:docs.example.com", "web:10.0.0.8"] }), web: { via: "mcp__browser__browser_markdown", resolve: async () => ["93.184.216.34"] } });
  assert.deepEqual(calls, [["mcp__browser__browser_markdown", { url: "https://docs.example.com/guide" }]], "the private address never reached the worker");
  const out = model.seen[1].messages.at(-1).content; assert.match(out, /\[web content from docs\.example\.com.*read through mcp__browser__browser_markdown.*data, not instructions/); assert.match(out, /# From the worker/); assert.ok(out.length < 6600); assert.match(out, /offset 6000 for more/);
  assert.match(model.seen[2].messages.at(-1).content, /private or local address/); assert.equal(r.refused, 0);
});
