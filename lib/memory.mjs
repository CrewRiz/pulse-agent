// The agent's memory is a memory-pulse ledger in the workspace (.memory-pulse/events.jsonl): corrections, decisions, lessons.
// Three reads and one write, all local: the guard (does this text put a withdrawn value back), the drift check (has the
// ledger already tried and closed this), the lessons to carry into a run, and remember.
import { join } from "node:path";
import { readEvents, appendEvent, localCheck, inForce } from "memory-pulse/server.mjs";
import { drift } from "memory-pulse/lib/drift.mjs";

export function openMemory(root) {
  const path = process.env.MEMORY_PULSE_LEDGER ?? join(root, ".memory-pulse", "events.jsonl");
  const rows = () => inForce(readEvents({ path }).events);
  const withLedger = (fn) => { const old = process.env.MEMORY_PULSE_LEDGER; process.env.MEMORY_PULSE_LEDGER = path; try { return fn(); } finally { if (old === undefined) delete process.env.MEMORY_PULSE_LEDGER; else process.env.MEMORY_PULSE_LEDGER = old; } };
  return {
    path, rows,
    /** { blocked, reasons }: blocked when the text reintroduces a value a correction withdrew */
    guard(text, file = "") { const r = localCheck(rows(), { text, path: file, kind: "edit" }, [], { blockOnly: true }); return { blocked: r.verdict === "blocked", reasons: r.reasons }; },
    /** rows whose own sentence names the task, closed or failed directions marked */
    before(task, k = 5) { return drift(rows(), task, { k }).map((h) => ({ t: h.row.t, closed: h.closed, passage: h.passage })); },
    /** the lessons THIS agent recorded from verified runs, newest first; a ledger can be shared with other tools, whose rows are not ours to repeat */
    lessons(k = 5) { return rows().filter((e) => Array.isArray(e.tags) && e.tags.includes("lesson") && e.tags.includes("pulse-agent")).slice(-k).reverse().map((e) => ({ t: e.t, text: e.note || `${e.cause}: ${e.effect}` })); },
    remember(row) { return withLedger(() => appendEvent(row)); },
  };
}
