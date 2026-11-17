// Recoverable context. A model's window is bounded; a long session is not. When the conversation passes its budget, what
// leaves the window is not thrown away or trusted to a summary: it is written verbatim into a hash-chained store on disk,
// the window keeps a line saying what went where, and one tool (recall_context) brings any of it back exactly, by id or by
// a search. Two stages. First, with no model call, old bulky tool results are swapped for such a line. Then, only if that
// is not enough, old turns leave whole and a note stands in for them: the model's own summary when it can write one, a
// plain index of what was stored when it cannot. Either way nothing is lost. A session is this store plus its live window,
// both on disk, so a new process resumes where the last one stopped.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const size = (messages) => JSON.stringify(messages).length;
const STUB = /^\[stored as (ctx-\d+): /;
const STOP = new Set("the a an and or of to in on at for is are was it its this that with from by as be says said per".split(" "));
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n / 2)}\n[... ${t.length - n} characters cut ...]\n${t.slice(-n / 2)}` : t; };

const NOTE = "Earlier turns were moved out of the window to keep it small.", DONE = "Work already done in those turns. Do not repeat it; recall a result if you need it again:";
export const RECALL_TOOL = { type: "function", function: { name: "recall_context", description: "Bring back, word for word, something that was moved out of the conversation to save space. Give the id from a [stored as ctx-N: ...] line, or a query to search everything stored.", parameters: { type: "object", properties: { id: { type: "string" }, query: { type: "string" } }, required: [] } } };

export function openContext(root, session, { budget = 200000, keep = 8, minBody = 600 } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(session))) throw new Error("a session name is letters, digits, - and _");
  const dir = join(root, ".pulse-agent", "sessions", session), file = join(dir, "context.jsonl"), live = join(dir, "session.json");
  const entries = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { id: "?", broken: true }; } }) : [];
  const link = (e, prev) => sha(`${prev}\n${e.id}\n${e.label}\n${e.sha}`);
  const sound = (e) => !e.broken && typeof e.content === "string" && sha(e.content) === e.sha;
  const put = (label, content) => {
    const same = entries.find((x) => x.sha === sha(content) && sound(x)); if (same) return same.id;       // the same bytes are stored once
    const prev = entries.at(-1)?.hash ?? "", e = { id: `ctx-${entries.length + 1}`, label: String(label).replace(/\s+/g, " ").slice(0, 160), sha: sha(content), prev, content };
    e.hash = link(e, prev); mkdirSync(dir, { recursive: true }); appendFileSync(file, JSON.stringify(e) + "\n"); entries.push(e); return e.id;
  };
  const labelOf = (messages, m) => { for (const a of messages) for (const c of a.tool_calls ?? []) if (c.id === m.tool_call_id) { let x = {}; try { x = JSON.parse(c.function.arguments || "{}"); } catch { /* label without arguments */ } return `${c.function.name} ${x.path ?? x.command ?? x.query ?? x.pattern ?? x.task ?? ""}`.trim(); } return "tool result"; };

  return {
    session, dir,
    status() { return { stored: entries.length, head: entries.at(-1)?.hash ?? "", characters: entries.reduce((a, e) => a + (e.content?.length ?? 0), 0) }; },
    /** walk the chain: every entry's content matches its hash and every link matches the one before */
    verify() { let prev = ""; for (const e of entries) { if (!sound(e)) return { ok: false, reason: `${e.id} does not match its hash` }; if (e.prev !== prev || e.hash !== link(e, prev)) return { ok: false, reason: `the chain is broken at ${e.id}` }; prev = e.hash; } return { ok: true, entries: entries.length }; },
    /** the model's tool: by id the exact text; by query the best matches, each word for word */
    recall({ id, query } = {}) {
      if (id) { const e = entries.find((x) => x.id === String(id).trim()); if (!e) return { ok: false, output: `nothing is stored as ${id}` }; return sound(e) ? { ok: true, output: e.content } : { ok: false, output: `${e.id} does not match its hash: the store was changed on disk, so it is not returned` }; }
      const q = [...new Set(words(query))]; if (!q.length) return { ok: false, output: "give an id (ctx-N) or a query" };
      const docs = entries.filter(sound).map((e) => ({ e, w: new Set(words(`${e.label} ${e.content}`)) })), N = docs.length || 1;
      const idf = new Map(q.map((t) => { const n = docs.filter((d) => d.w.has(t)).length; return [t, Math.log(1 + (N - n + 0.5) / (n + 0.5))]; })), total = q.reduce((a, t) => a + idf.get(t), 0) || 1;
      const hits = docs.map((d) => ({ e: d.e, s: q.reduce((a, t) => a + (d.w.has(t) ? idf.get(t) : 0), 0) / total })).filter((h) => h.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, 3);
      if (!hits.length) return { ok: false, output: `nothing stored matches "${String(query).slice(0, 80)}" (${entries.length} item(s) stored)` };
      return { ok: true, output: hits.map((h) => `--- ${h.e.id} (${h.e.label}) ---\n${clip(h.e.content, 6000)}`).join("\n\n") };
    },
    /** keep the window under budget; returns the same array untouched when it already is */
    async fit(messages, { model } = {}) {
      if (size(messages) <= budget) return { changed: false, messages, stored: 0 };
      const out = messages.slice(), before = entries.length, target = budget * 0.8;
      let start = Math.max(2, out.length - keep); while (start > 2 && out[start].role === "tool") start--;
      // stage 1: bulky old tool results become a line and their bytes go to the store; no model is asked
      const elide = (from, to, goal) => { for (let i = from; i < to && size(out) > goal; i++) {
        const m = out[i]; if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= minBody || STUB.test(m.content)) continue;
        const label = labelOf(out, m), id = put(label, m.content);
        out[i] = { ...m, content: `[stored as ${id}: ${label}, ${m.content.length.toLocaleString("en-US")} characters. recall_context brings it back]` };
      } };
      elide(2, start, target);
      if (size(out) > budget && start > 2) {
        // stage 2: old turns leave whole. Whatever is not already in the store goes in; a note with an index stands in for them
        const middle = out.slice(2, start), index = []; let old = "", fresh = 0;
        for (const m of middle) {
          // an earlier note is bookkeeping, not a turn: its record is carried into the new note and it is not stored
          if (m.role === "user" && typeof m.content === "string" && m.content.startsWith(NOTE)) { const i = m.content.indexOf(DONE); if (i >= 0) index.push(...m.content.slice(i + DONE.length).split("\n").filter((l) => /-> ctx-\d+/.test(l))); const n = /\n\nNotes on those turns:\n([\s\S]*?)\n\n/.exec(m.content); if (n) old = n[1]; continue; }
          const stub = typeof m.content === "string" && STUB.exec(m.content);
          if (stub) { index.push(`${entries.find((e) => e.id === stub[1])?.label ?? "stored result"} -> ${stub[1]}`); fresh++; continue; }
          if (typeof m.content !== "string" || !m.content.trim()) continue;
          const label = m.role === "tool" ? labelOf(out, m) : m.role === "assistant" ? `assistant: ${m.content.slice(0, 60)}` : `user: ${m.content.slice(0, 60)}`;
          index.push(`${label} -> ${put(label, m.content)}`); fresh++;
        }
        // the model writes notes only when there is enough new to summarise; a small eviction is indexed and costs no call
        let notes = old;
        if (model && fresh >= 6) { try { const r = await model({ tools: [], messages: [
          { role: "system", content: "You write short working notes for a coding agent whose older turns are being moved out of its window. Keep what was asked, what was found (file names, values, error messages), what was changed, what failed and why, and what remains. Plain notes, no preamble." },
          { role: "user", content: `${old ? `Notes so far:\n${old}\n\nNewer turns:\n` : ""}${middle.filter((m) => !(typeof m.content === "string" && m.content.startsWith(NOTE))).map((m) => `${m.role.toUpperCase()}: ${clip(m.content, 1500)}${(m.tool_calls ?? []).map((c) => `\n  called ${c.function.name}(${clip(c.function.arguments, 300)})`).join("")}`).join("\n\n")}` }] }); notes = String(r?.content ?? "").trim() || old; } catch { /* the record below stands in */ } }
        const lines = [...new Set(index)].slice(-200);
        const note = `${NOTE} Nothing was lost: recall_context returns any stored result word for word, by id or by a search.${notes ? `\n\nNotes on those turns:\n${notes}` : ""}\n\n${DONE}\n${lines.join("\n")}`;
        out.splice(2, start - 2, { role: "user", content: note });
      }
      // stage 3: the recent turns are protected only while they fit. If they alone pass the budget, their bulky results go
      // too, oldest first, all but the newest message (the model has not acted on that one yet)
      if (size(out) > budget) elide(2, out.length - 1, budget);
      return { changed: true, messages: out, stored: entries.length - before };
    },
    save(messages) { mkdirSync(dir, { recursive: true }); writeFileSync(live, JSON.stringify({ session, saved: new Date().toISOString(), messages })); },
    load() { try { const s = JSON.parse(readFileSync(live, "utf8")); return Array.isArray(s.messages) ? s.messages : null; } catch { return null; } },
  };
}
