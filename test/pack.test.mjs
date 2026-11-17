import "./_helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { pack, unpack } from "../lib/pack.mjs";

const jsonl = (n) => Buffer.from(Array.from({ length: n }, (_, i) => JSON.stringify({ t: i + 1, cause: `task-fix-the-parser-${i % 17}`, effect: i % 3 ? "verified-pass" : "verify-failed", tags: ["pulse-agent", "run"], note: `builder run: "fix the date parser for case ${i % 29}". Check \`npm test\` ${i % 3 ? "passed" : "failed"} after ${1 + (i % 3)} round(s); files changed: src/parse-${i % 7}.js`, hash: (i * 2654435761 >>> 0).toString(16).padStart(8, "0") })).join("\n") + "\n");

test("pack then unpack returns the same bytes, for every kind of input", () => {
  const inputs = { empty: Buffer.alloc(0), one: Buffer.from([0]), ff: Buffer.from([255]), text: Buffer.from("the quick brown fox ".repeat(200)), random: randomBytes(5000), ledger: jsonl(400), binary: Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37 + (i >> 3)) & 255)) };
  for (const [name, buf] of Object.entries(inputs)) {
    const p = pack(buf); assert.ok(Buffer.isBuffer(p), name);
    assert.ok(unpack(p).equals(buf), `${name}: ${buf.length} bytes do not come back`);
  }
});

test("the same bytes always pack to the same bytes, and a ledger packs smaller than gzip makes it", () => {
  const buf = jsonl(1500), a = pack(buf), b = pack(buf);
  assert.ok(a.equals(b), "deterministic");
  const gz = gzipSync(buf, { level: 9 }).length;
  assert.ok(a.length < gz, `packed ${a.length} bytes against gzip -9 ${gz}`);
  assert.ok(pack(randomBytes(4000)).length < 4000 * 1.05 + 64, "random bytes grow by a few percent at most");
});

test("a packed file that was changed, cut short or is not one fails loudly; nothing wrong is ever returned", () => {
  const buf = jsonl(200), p = pack(buf);
  const flipped = Buffer.from(p); flipped[flipped.length - 20] ^= 0x10; assert.throws(() => unpack(flipped), /does not match|corrupt/);
  const head = Buffer.from(p); head[30] ^= 1; assert.throws(() => unpack(head), /does not match|corrupt/);
  assert.throws(() => unpack(p.subarray(0, p.length - 40)), /does not match|corrupt|truncated/);
  assert.throws(() => unpack(Buffer.from("not a packed file at all")), /not a pulse-agent packed file/);
  assert.throws(() => unpack(Buffer.alloc(3)), /not a pulse-agent packed file/);
});
