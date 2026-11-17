// Skills are procedures the agent proposes after doing a task. Self-written procedures are where a self-improving agent
// goes wrong, so here a proposal passes two gates before the model ever sees it again: the run's check must pass (else the
// proposal is deleted), and a person must accept it. pending/ = this run; proposed/ = verified, waiting for a person;
// accepted/ = shown to the model for tasks they bear on.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";
const STOP = new Set("the and for with from that this into when then than have has are was were not you your our its can will task make".split(" "));
const words = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, "")));
const parse = (text) => { const m = /^# (.*)\n\nWhen: (.*)\n\n([\s\S]*)$/.exec(text); return m ? { title: m[1], when: m[2], steps: m[3].trim() } : { title: "", when: "", steps: text.trim() }; };

export function openSkills(root) {
  const base = join(root, ".pulse-agent", "skills"), dir = (k) => join(base, k);
  const names = (k) => (existsSync(dir(k)) ? readdirSync(dir(k)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort() : []);
  const move = (name, from, to) => { const n = slug(name), src = join(dir(from), `${n}.md`); if (n !== name || !existsSync(src)) return { ok: false, output: `no ${from} skill named ${name}` }; mkdirSync(dir(to), { recursive: true }); renameSync(src, join(dir(to), `${n}.md`)); return { ok: true, output: `${n}: ${from} -> ${to}` }; };
  return {
    /** the model's tool: write this run's proposal to pending/ under a safe name */
    propose({ name, when, steps }) {
      const n = slug(name); mkdirSync(dir("pending"), { recursive: true });
      writeFileSync(join(dir("pending"), `${n}.md`), `# ${n}\n\nWhen: ${String(when ?? "").replace(/\s+/g, " ").trim()}\n\n${String(steps ?? "").trim()}\n`);
      return { ok: true, name: n, output: `proposal ${n} is held: it is kept only if this task's check passes, and used only after a person accepts it` };
    },
    /** the run ended: a passing check promotes this run's proposals to proposed/, anything else deletes them */
    settle(passed) { const out = []; for (const n of names("pending")) { if (passed) { move(n, "pending", "proposed"); out.push(n); } else rmSync(join(dir("pending"), `${n}.md`)); } return out; },
    list() { return { proposed: names("proposed"), accepted: names("accepted") }; },
    accept(name) { return move(name, "proposed", "accepted"); },
    reject(name) { const n = slug(name), p = join(dir("proposed"), `${n}.md`); if (n !== name || !existsSync(p)) return { ok: false, output: `no proposed skill named ${name}` }; rmSync(p); return { ok: true, output: `${n}: rejected and removed` }; },
    read(kind, name) { return readFileSync(join(dir(kind), `${slug(name)}.md`), "utf8"); },
    /** accepted skills that share at least two content words with the task */
    matching(task) {
      const t = words(task);
      return names("accepted").map((n) => ({ name: n, ...parse(readFileSync(join(dir("accepted"), `${n}.md`), "utf8")) })).filter((s) => [...words(`${s.name} ${s.when}`)].filter((w) => t.has(w)).length >= 2);
    },
  };
}
