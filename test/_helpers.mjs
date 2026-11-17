// Every test gets its own workspace, ledger, trust store and data dir, and none of the developer's own memory-pulse settings.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const k of Object.keys(process.env)) if (k.startsWith("MEMORY_PULSE_") || k.startsWith("PULSE_AGENT_")) delete process.env[k];
process.env.MEMORY_PULSE_TRUST_DIR = mkdtempSync(join(tmpdir(), "pa-trust-"));
process.env.MEMORY_PULSE_DATA_DIR = mkdtempSync(join(tmpdir(), "pa-data-"));
process.env.PULSE_AGENT_HOME = mkdtempSync(join(tmpdir(), "pa-home-"));        // the trust store lives outside every workspace
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
export const workspace = () => { const root = mkdtempSync(join(tmpdir(), "pa-ws-")); mkdirSync(join(root, ".memory-pulse")); return root; };
/** A model that answers from a script: each entry is a message ({content} or {tool_calls: [[name, args], ...]}) or a function of the messages so far. */
export const scripted = (script) => {
  const seen = []; let i = 0;
  const model = async ({ messages, tools }) => {
    seen.push({ messages: structuredClone(messages), tools: (tools ?? []).map((t) => t.function.name) });
    const step = script[Math.min(i, script.length - 1)]; i++;
    const m = typeof step === "function" ? step(messages) : step;
    return { content: m.content ?? "", tool_calls: (m.tool_calls ?? []).map(([name, args], k) => ({ id: `call_${i}_${k}`, name, args })) };
  };
  model.seen = seen; return model;
};
