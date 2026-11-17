// One task, start to finish. The model works through tools until it answers. Then, if a check command is configured, the
// HARNESS runs it: the check's exit code is the verdict, never the model's own claim. A failed check goes back to the model
// with its output. What the run teaches is recorded only from that evidence: fail-then-pass becomes a lesson in the ledger,
// and a proposed skill survives only a passing check and then waits for a person.
import { openMemory } from "./memory.mjs";
import { openSkills } from "./skills.mjs";
import { ROLES, DELEGABLE } from "./roles.mjs";
import { openContext, RECALL_TOOL } from "./context.mjs";
import { execute, toolsFor, shell } from "./tools.mjs";
import { learnedBefore } from "./learned.mjs";
import { connectAll } from "./mcp.mjs";
import { createJobs } from "./jobs.mjs";
import { createWorkspaces } from "./worktree.mjs";
import { runScript, scriptAvailable } from "./script.mjs";

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// usage a run can vouch for: totals when the endpoint reported them, null (unknown) when it did not
const tally = (u) => (u.reported ? { ...u } : { input: null, output: null, calls: u.calls, reported: 0 });
export function systemPrompt({ role, root, drift, lessons, skills, verify, learned, instructions, projectSkills = [] }) {
  const out = [`You are pulse-agent, working as the ${role.name}. ${role.brief}`, `Workspace: ${root}. Every path is relative to it; nothing outside it can be read or written.`,
    verify ? "When you stop, a check command decides whether the task succeeded. If it fails you will get its output." : "No check command is configured, so this run cannot be verified and will teach nothing."];
  if (instructions) out.push(`Project instructions (the person chose to trust this project's files):\n${instructions}`);
  if (projectSkills.length) out.push(`Project skills. Read one with read_skill before you follow it:\n${projectSkills.map((k) => `- ${k.name}: ${k.description}`).join("\n")}`);
  if (lessons.length) out.push(`Lessons from verified runs in this workspace:\n${lessons.map((l) => `- ${clip(l.text, 300)}`).join("\n")}`);
  if (drift.length) out.push(`The ledger suggests this may have been already tried. Read these before you build; a row marked ✗ records a closed or failed direction:\n${drift.map((d) => `${d.closed ? "✗" : "·"} (t${d.t}) ${clip(d.passage, 240)}${d.closed ? ` [${d.closed}]` : ""}`).join("\n")}`);
  if (learned?.hits?.length) out.push(`The learned read of the ledger names these corrections as bearing on this task. Follow them:\n${learned.hits.map((h) => `! (t${h.t}) ${clip(`${h.cause} -> ${h.effect}`, 160)}${h.withdrawn?.length ? ` — withdrawn ${h.withdrawn.map((w) => JSON.stringify(clip(w, 60))).join(", ")}${h.replacement?.length ? `, use ${h.replacement.map((w) => clip(w, 60)).join(" / ")}` : ""}` : ""}${h.why ? ` (${clip(h.why, 80)})` : ""}`).join("\n")}`);
  if (skills.length) out.push(`Accepted skills that bear on this task:\n${skills.map((s) => `## ${s.name}\nWhen: ${s.when}\n${s.steps}`).join("\n\n")}`);
  return out.join("\n\n");
}

export async function runTask({ root, task, model, role = "builder", verify, maxSteps = 30, maxRounds = 3, timeoutMs, learned = null, mcpServers = null, onEvent = () => {}, sub = false, stream = false, contextBudget = 200000, sessionId = null, resume = false, quiet = false, policy = null, hooks = null, instructions = null, projectSkills = [], signal = null, jobs = null, memory: given = null, connectors = null, connectorBudget = 6000, script = true }) {
  const R = ROLES[role]; if (!R) throw new Error(`no role named ${role}`);
  const memory = given ?? openMemory(root), skills = openSkills(root), changed = new Set();           // a worker in its own worktree still answers to the project's ledger
  const work = sub ? null : createWorkspaces(root);
  // a subagent starts clean: only its role and the task it was handed
  const drift = sub ? [] : memory.before(task), lessons = sub ? [] : memory.lessons(5), matched = sub ? [] : skills.matching(task);
  // the learned read runs on the engine and only when the caller configured a key; without one the ledger stays on this machine
  const read = !sub && learned?.key ? await learnedBefore({ events: memory.rows(), operation: task, key: learned.key, api: learned.api }) : null;
  // the session: a recoverable store for what leaves the window, and the live window itself, both on disk (lib/context.mjs)
  const session = sub ? null : (sessionId ?? `s-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`);
  const store = sub ? null : openContext(root, session, { budget: contextBudget });
  const earlier = resume && store ? store.load() : null;
  if (resume && !earlier) throw new Error(`no session named ${sessionId} in this project`);
  // background commands live for this run unless the caller (a chat) passed its own set to keep across turns
  const ownJobs = !jobs && !sub ? createJobs({ cwd: root }) : null;
  const ctx = { root, role: R, memory, skills, changed, check: verify, timeoutMs, signal, jobs: jobs ?? ownJobs, work };
  const messages = earlier ? [...earlier, { role: "user", content: task }] : [{ role: "system", content: systemPrompt({ role: R, root, drift, lessons, skills: matched, verify, learned: read, instructions: sub ? null : instructions, projectSkills: sub ? [] : projectSkills }) }, { role: "user", content: task }];
  // connectors (MCP servers) are started only for a role that may use them; one that fails to start is reported and skipped
  const mcp = sub || !R.mcp ? null : connectors ?? (mcpServers && Object.keys(mcpServers).length ? await connectAll(mcpServers) : null);
  // connector tools cost tokens in every request. A few are sent as they are; a large set is found on demand instead
  const mcpNames = new Set((mcp?.tools ?? []).map((t) => t.function.name)), deferred = !!mcp && (mcp.tools.length > 12 || JSON.stringify(mcp.tools).length > connectorBudget);
  const usage = { input: 0, output: 0, calls: 0, reported: 0 };
  for (const f of mcp?.failed ?? []) onEvent({ type: "connector", name: f.name, ok: false, reason: f.reason });
  // subagents: a builder may hand a self-contained question to a read-only role. The child gets a fresh context, its role's
  // tools and nothing else, cannot delegate further, and writes nothing to the ledger. Its answer comes back as the tool result.
  let delegated = 0;
  ctx.delegate = sub ? null : async ({ role: r, task: t }) => {
    if (!DELEGABLE.includes(r)) return { ok: false, output: `a ${R.name} can delegate only to: ${DELEGABLE.join(", ")}` };
    if (!String(t ?? "").trim()) return { ok: false, output: "delegate needs a task" };
    if (r === "worker") {
      // a worker writes, so it gets its own worktree; with no isolation to give it is refused, never run in the shared checkout
      if (!work.available()) return { ok: false, output: "a worker needs a git repository with at least one commit, so that it can work in its own worktree. It is never run in the shared checkout. Do the change yourself, or commit first." };
      const w = work.open(); if (w.error) return { ok: false, output: w.error };
      delegated++; let c = null, err = null;
      try { c = await runTask({ root: w.dir, task: String(t), model, role: "worker", sub: true, memory, policy, hooks, signal, maxSteps: Math.min(maxSteps, 20), timeoutMs, onEvent: (e) => onEvent({ ...e, who: `worker ${w.id}` }) }); } catch (e) { err = e; }
      const fin = work.finish(w.id);
      if (err) return { ok: false, output: `the worker failed: ${err.message}` };
      return { ok: true, output: `${c.answer || "(the worker gave no report)"}\n\nwork ${w.id}: ${fin.files.length ? `changed ${fin.files.join(", ")}\n${fin.stat}\nNothing has been applied to the project yet. apply_work {"id":"${w.id}"} applies all of it.` : "no files changed"}` };
    }
    delegated++;
    try { const c = await runTask({ root, task: String(t), model, role: r, verify: r === "evaluator" ? verify : undefined, sub: true, policy, hooks, signal, maxSteps: Math.min(maxSteps, 15), timeoutMs, onEvent: (e) => onEvent({ ...e, who: r }) }); return { ok: true, output: c.answer || `(the ${r} gave no answer${c.stopped ? `; it stopped at the ${c.stopped}` : ""})` }; }
    catch (e) { return { ok: false, output: `the ${r} failed: ${e.message}` }; }
  };
  const SKILL_TOOL = { type: "function", function: { name: "read_skill", description: "Read a project skill's full text by name.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } };
  let refused = 0;
  // every call that changes something passes the project's pre-tool hook (if the project is trusted) and the approval policy
  const gate = async (c) => {
    if (hooks?.preToolUse) { const h = await shell(hooks.preToolUse, { cwd: root, timeoutMs: 30000, input: JSON.stringify({ tool: c.name, args: c.args ?? {} }) }); if (!h.ok) return `refused by the project's pre-tool hook: ${h.output.trim() || `exit ${h.code}`}`; }
    if (policy) { const d = await policy.check(c.name, c.args ?? {}); if (!d.allow) return `not done: ${d.reason}`; }
    return null;
  };
  const FIND_TOOL = { type: "function", function: { name: "find_tool", description: `Search the ${mcpNames.size} connector tools by what you need. Returns the best matches with their parameters; then use call_tool.`, parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } };
  const CALL_TOOL = { type: "function", function: { name: "call_tool", description: "Call a connector tool found with find_tool, by its full name.", parameters: { type: "object", properties: { name: { type: "string" }, args: { type: "object" } }, required: ["name"] } } };
  const findTool = (query) => { const q = new Set((String(query).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2)); const hits = mcp.tools.map((t) => ({ t, s: [...new Set((`${t.function.name} ${t.function.description}`.toLowerCase().match(/[a-z0-9]+/g) ?? []))].filter((w) => q.has(w)).length })).filter((h) => h.s > 0).sort((a, b) => b.s - a.s).slice(0, 5).filter((h, _i, all) => h.s * 2 > all[0].s);        // a weak match beside a strong one is noise
    return hits.length ? { ok: true, output: hits.map((h) => `${h.t.function.name}: ${clip(h.t.function.description, 240)}\n  parameters: ${clip(JSON.stringify(h.t.function.parameters), 400)}`).join("\n") } : { ok: false, output: `no connector tool matches "${clip(query, 80)}"; try other words` }; };
  // the script tool is offered only where its confinement is confirmed; a script may call the role's plain tools and the connectors, never itself or another agent
  const canScript = script && R.tools.includes("script") && (await scriptAvailable()).ok;
  const scriptable = R.tools.filter((n) => !["script", "delegate", "apply_work", "propose_skill", "run_background", "read_output", "kill_command"].includes(n)).concat([...mcpNames]);
  const tools = toolsFor(R).filter((t) => t.function.name !== "script" || canScript).concat(deferred ? [FIND_TOOL, CALL_TOOL] : mcp?.tools ?? [], !sub && projectSkills.length ? [SKILL_TOOL] : []); let steps = 0, rounds = 0, answer = "", stopped = null, verdict = "unverified", firstFailure = null;
  // one tool call, whoever makes it: the model directly, or a script it wrote. The same limits apply to both
  const dispatch = async (c, who = null) => {
    if (c.error) return { ok: false, output: c.error };
    if (c.name === "recall_context" && store) return store.recall(c.args);
    if (c.name === "read_skill" && projectSkills.length) { const k = projectSkills.find((x) => x.name === String(c.args?.name ?? "").trim()); return k ? { ok: true, output: k.body } : { ok: false, output: `no project skill named ${c.args?.name}; there are: ${projectSkills.map((x) => x.name).join(", ")}` }; }
    if (c.name === "find_tool" && deferred) return findTool(c.args?.query ?? "");
    if (c.name === "call_tool" && deferred) { const name = String(c.args?.name ?? ""); if (!mcpNames.has(name)) return { ok: false, output: `no connector tool named ${name}; use find_tool to search for one` }; return dispatch({ ...c, name, args: c.args?.args ?? {} }, who); }
    if (c.name === "script" && canScript && !who) {
      const res = await runScript(c.args?.code, { names: scriptable, call: async (name, args) => { const x = await dispatch({ name, args }, "script"); onEvent({ type: "tool", name, args, ok: x.ok, refused: !!x.refused, who: "script" }); return x; } });
      return { ok: res.ok, output: res.output };
    }
    const no = await gate(c); if (no) { refused++; return { ok: false, refused: true, output: no }; }
    return mcp && mcpNames.has(c.name) ? mcp.call(c.name, c.args) : execute(c.name, c.args, ctx);
  };
  try {
  outer: for (;;) {
    for (;;) {                                                                  // the model works until it answers without a tool call
      if (steps >= maxSteps) { stopped = "step limit"; break outer; }
      if (store) {
        const f = await store.fit(messages, { model });
        if (f.changed) {
          messages.splice(0, messages.length, ...f.messages); const st = store.status(); onEvent({ type: "context", stored: f.stored, total: st.stored });
          memory.remember({ cause: `session-${session}`, effect: "context-checkpoint", tags: ["pulse-agent", "context"], note: `session ${session}: ${f.stored} item(s) moved out of the window into the recoverable store, ${st.stored} stored in all, head ${st.head.slice(0, 12)}` });
        }
      }
      const offered = store && store.status().stored ? tools.concat(RECALL_TOOL) : tools;
      if (signal?.aborted) { stopped = "interrupted"; break outer; }
      let m; try { m = await model({ messages, tools: offered, signal, ...(stream ? { onDelta: (text) => onEvent({ type: "delta", text }) } : {}) }); } catch (e) { if (signal?.aborted || e?.interrupted) { stopped = "interrupted"; break outer; } throw e; }
      steps++; usage.calls++; if (m.usage) { usage.reported++; usage.input += m.usage.input; usage.output += m.usage.output; }
      messages.push({ role: "assistant", content: m.content || "", ...(m.tool_calls.length ? { tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}) });
      if (!m.tool_calls.length) { answer = m.content; break; }
      // delegations in one turn start together; every other tool runs in the order the model gave
      const started = new Map(m.tool_calls.filter((c) => c.name === "delegate" && !c.error && R.tools.includes("delegate")).map((c) => [c.id, execute(c.name, c.args, ctx)]));
      for (const c of m.tool_calls) {
        const r = signal?.aborted ? { ok: false, output: "not run: the turn was interrupted" } : started.has(c.id) ? await started.get(c.id) : await dispatch(c);
        onEvent({ type: "tool", name: c.name, args: c.args, ok: r.ok, refused: !!r.refused });
        messages.push({ role: "tool", tool_call_id: c.id, content: `${r.ok ? "ok" : "failed"}${r.code != null ? ` (exit ${r.code})` : ""}\n${r.output ?? ""}` });
      }
    }
    if (signal?.aborted) { stopped = "interrupted"; break; }
    if (!verify || sub || (quiet && !changed.size)) break;                  // in a chat, a turn that changed nothing has nothing to check
    const v = await shell(verify, { cwd: root, timeoutMs }); rounds++; onEvent({ type: "check", ok: v.ok, code: v.code });
    if (v.ok) { verdict = "pass"; break; }
    verdict = "fail"; firstFailure ??= v.output;
    if (rounds >= maxRounds) { stopped = "round limit"; break; }
    messages.push({ role: "user", content: `The check failed (exit ${v.code}):\n${v.output}\nFind the cause and fix it. The check will run again when you stop.` });
  }
    if (stopped === "interrupted" && !sub) messages.push({ role: "user", content: "[The person interrupted the previous turn before it finished. Anything not confirmed above may not have happened.]" });
  } finally { mcp?.close(); ownJobs?.killAll(); work?.cleanup(); store?.save(messages); }
  if (sub) return { answer, steps, rounds, verdict, stopped, changed: [...changed].sort(), drift, proposed: [], learned: null, delegated, refused, usage: tally(usage) };
  const files = [...changed].sort(), proposed = skills.settle(verdict === "pass"), cause = `task-${slug(task)}`;
  if (!quiet || files.length) memory.remember({ cause, effect: verdict === "pass" ? "verified-pass" : verdict === "fail" ? "verify-failed" : "unverified-run", tags: ["pulse-agent", "run"],
    note: clip(`${R.name} run: "${task}". ${verify ? `Check \`${verify}\` ${verdict === "pass" ? "passed" : "failed"} after ${rounds} round(s)` : "No check configured"}; ${steps} step(s); files changed: ${files.join(", ") || "none"}${stopped ? `; stopped at the ${stopped}` : ""}.`, 600) });
  if (verdict === "pass" && firstFailure !== null)
    memory.remember({ cause, effect: `check-passed-after-${rounds - 1}-failed-round${rounds - 1 === 1 ? "" : "s"}`, tags: ["pulse-agent", "lesson"],
      note: clip(`On "${clip(task, 120)}" the check \`${clip(verify, 80)}\` first failed with: ${clip(firstFailure, 220)} It passed after editing ${files.join(", ") || "no files"}.`, 600) });
  return { answer, steps, rounds, verdict, stopped, changed: files, drift, proposed, learned: read, delegated, session, refused, usage: tally(usage) };
}
