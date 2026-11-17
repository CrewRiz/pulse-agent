// Onboarding without questions. `pulse-agent init` looks for a model server already running on this machine, asks each
// model to call a tool (a model that answers in prose cannot drive an agent, whatever its card says), finds the project's
// own test command, and writes .pulse-agent/config.json. It reports what it chose and how to change it.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openaiCompatible } from "./provider.mjs";

export const LOCAL_ENDPOINTS = [
  ["Ollama", "http://127.0.0.1:11434/v1"], ["LM Studio", "http://127.0.0.1:1234/v1"], ["llama.cpp or MLX server", "http://127.0.0.1:8080/v1"], ["vLLM", "http://127.0.0.1:8000/v1"],
];
const cfgPath = (root) => join(root, ".pulse-agent", "config.json");
export function loadConfig(root) { try { const c = JSON.parse(readFileSync(cfgPath(root), "utf8")); return c && typeof c === "object" && !Array.isArray(c) ? c : {}; } catch { return {}; } }
export function saveConfig(root, config) { mkdirSync(join(root, ".pulse-agent"), { recursive: true }); writeFileSync(cfgPath(root), JSON.stringify(config, null, 2) + "\n"); }

/** the project's own test command, or null: never a guess that would pass or fail for the wrong reason */
export function detectCheck(root) {
  const has = (f) => existsSync(join(root, f)), read = (f) => { try { return readFileSync(join(root, f), "utf8"); } catch { return ""; } };
  if (has("package.json")) { try { const t = JSON.parse(read("package.json")).scripts?.test; if (t && !/no test specified/.test(t)) return "npm test"; } catch { /* not JSON */ } }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pytest.ini") || /\[tool\.pytest/.test(read("pyproject.toml")) || ["tests", "test"].some((d) => { try { return readdirSync(join(root, d)).some((f) => /^test_.*\.py$|_test\.py$/.test(f)); } catch { return false; } })) return "python3 -m pytest -q";
  if (/^test:/m.test(read("Makefile"))) return "make test";
  return null;
}

async function models(baseUrl) { try { const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) return null; const d = await r.json(); return (d.data ?? []).map((m) => m.id).filter((x) => typeof x === "string"); } catch { return null; } }

/** does this model actually emit a tool call when asked to? */
export async function callsTools(baseUrl, model, apiKey) {
  const tool = { type: "function", function: { name: "report_ready", description: "Report that you are ready.", parameters: { type: "object", properties: {}, required: [] } } };
  try { const m = await openaiCompatible({ baseUrl, model, apiKey, timeoutMs: 120000 })({ messages: [{ role: "user", content: "Call the report_ready tool now. Do not write anything else." }], tools: [tool] }); return m.tool_calls.some((c) => c.name === "report_ready"); } catch { return false; }
}

export async function onboard({ root, endpoints, model, apiKey, force = false, maxTry = 6 }) {
  const existing = loadConfig(root);
  if (existing.model && !force) return { ok: true, config: existing, tried: [], report: `already set up: model ${existing.model} at ${existing.baseUrl ?? "the default endpoint"}${existing.verify ? `, check \`${existing.verify}\`` : ""}.\nRun \`pulse-agent init --force\` to detect again.` };
  const list = endpoints ?? LOCAL_ENDPOINTS.map(([, u]) => u), tried = [], lines = []; let chosen = null, sawServer = false;
  for (const baseUrl of list) {
    const ids = await models(baseUrl); if (!ids) continue; sawServer = true;
    const name = LOCAL_ENDPOINTS.find(([, u]) => u === baseUrl)?.[0] ?? "a model server"; lines.push(`found ${name} at ${baseUrl} with ${ids.length} model(s)`);
    for (const id of (model ? [model] : ids).slice(0, maxTry)) { const ok = await callsTools(baseUrl, id, apiKey); tried.push({ baseUrl, model: id, tools: ok }); lines.push(`  ${id}: ${ok ? "calls tools" : "did not call the tool"}`); if (ok) { chosen = { baseUrl, model: id }; break; } }
    if (chosen) break;
  }
  if (!chosen) {
    const why = !sawServer ? `No local model server is running (looked at ${list.join(", ")}).\nStart one: install Ollama (https://ollama.com) or LM Studio (https://lmstudio.ai), pull a model that supports tool calls, then run \`pulse-agent init\` again.\nFor a hosted endpoint instead: pulse-agent init --base-url <url> --model <name> (with PULSE_AGENT_API_KEY set).`
      : model ? `${model} did not call the tool when asked, so it cannot drive the agent. Name another with --model, or run init without --model to try each one.`
        : "A server answered, but none of its models called a tool when asked. Pull one that supports tool calls and run `pulse-agent init` again.";
    return { ok: false, tried, report: [...lines, why].join("\n") };
  }
  const verify = existing.verify ?? detectCheck(root), config = { ...existing, model: chosen.model, baseUrl: chosen.baseUrl, ...(verify ? { verify } : {}) };
  saveConfig(root, config);
  lines.push(`\nmodel: ${config.model}\nendpoint: ${config.baseUrl}`, verify ? `check: \`${verify}\` (decides whether a task succeeded)` : "check: none found. Pass --verify \"<command>\" on a run, or set \"verify\" in .pulse-agent/config.json; without one, runs are unverified and teach nothing.",
    `saved .pulse-agent/config.json\n\nnext: pulse-agent run "<what you want done>"`);
  return { ok: true, config, tried, report: lines.join("\n") };
}
