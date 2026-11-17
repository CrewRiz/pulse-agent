// Trust. A project can ship things that act on your machine or steer the model: instruction files, hooks, connectors,
// skills, approval rules. None of it is loaded until a person says this project is trusted, and that statement is kept
// OUTSIDE the project (PULSE_AGENT_HOME, default ~/.local/share/pulse-agent), so a checkout cannot trust itself. A person's
// own "always allow" answers are kept there too, per project.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./onboard.mjs";

const home = () => process.env.PULSE_AGENT_HOME ?? join(homedir(), ".local", "share", "pulse-agent");
const file = () => join(home(), "trust.json");
const read = () => { try { const d = JSON.parse(readFileSync(file(), "utf8")); return d && typeof d.projects === "object" ? d : { projects: {} }; } catch { return { projects: {} }; } };
const write = (d) => { mkdirSync(home(), { recursive: true }); writeFileSync(file(), JSON.stringify(d, null, 2) + "\n"); };
const key = (root) => realpathSync(root);
const entry = (d, root) => (d.projects[key(root)] ??= { trusted: false, allow: [] });

export const isTrusted = (root) => read().projects[key(root)]?.trusted === true;
export function trust(root, yes = true) { const d = read(); entry(d, root).trusted = !!yes; if (yes) entry(d, root).at = new Date().toISOString(); write(d); return yes; }
export const personalRules = (root) => [...(read().projects[key(root)]?.allow ?? [])];
export function addRule(root, rule) { const d = read(), e = entry(d, root); if (!e.allow.includes(rule)) e.allow.push(rule); write(d); return e.allow; }

// Personal connectors: yours, kept beside the trust store and outside every project, so they apply everywhere and need no
// project to be trusted. The file may hold tokens, so it is readable by you alone.
const personalFile = () => join(home(), "connectors.json");
export const personalConnectors = () => { try { const d = JSON.parse(readFileSync(personalFile(), "utf8")); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; } catch { return {}; } };
export function savePersonalConnectors(all) { mkdirSync(home(), { recursive: true }); writeFileSync(personalFile(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 }); chmodSync(personalFile(), 0o600); }

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"], SKILL_DIRS = [".agents/skills", ".claude/skills"];
function skillsIn(root) {
  const out = [];
  for (const dir of SKILL_DIRS) { let names = []; try { names = readdirSync(join(root, dir)).sort(); } catch { continue; }
    for (const n of names) { let text; try { text = readFileSync(join(root, dir, n, "SKILL.md"), "utf8"); } catch { continue; }
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text), head = m ? m[1] : "", body = (m ? m[2] : text).trim();
      const get = (k) => (new RegExp(`^${k}:\\s*(.+)$`, "m").exec(head)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
      out.push({ name: (get("name") || n).toLowerCase().replace(/[^a-z0-9-]+/g, "-"), description: get("description").slice(0, 300), body: body.slice(0, 20000) }); } }
  return out;
}

/** What the project ships. Loaded when the project is trusted; otherwise named in `held` and left alone. */
export function projectExtras(root) {
  const cfg = loadConfig(root), trusted = isTrusted(root);
  const files = INSTRUCTION_FILES.filter((f) => existsSync(join(root, f))), skills = skillsIn(root);
  const hooks = cfg.hooks && typeof cfg.hooks === "object" && Object.keys(cfg.hooks).length ? cfg.hooks : null;
  const mcpServers = cfg.mcpServers && Object.keys(cfg.mcpServers).length ? cfg.mcpServers : null;
  const approvals = cfg.approvals && typeof cfg.approvals === "object" ? cfg.approvals : null;
  const mine = personalConnectors(), both = (proj) => { const all = { ...(proj ?? {}), ...mine }; return Object.keys(all).length ? all : null; };          // a personal connector wins a name clash
  if (!trusted) return { trusted, instructions: null, skills: [], hooks: null, mcpServers: both(null), approvals: null,
    held: [...files, ...(skills.length ? ["skills"] : []), ...(hooks ? ["hooks"] : []), ...(mcpServers ? ["connectors"] : []), ...(approvals ? ["approval rules"] : [])] };
  const instructions = files.length ? files.map((f) => `From ${f}:\n${readFileSync(join(root, f), "utf8").slice(0, 20000)}`).join("\n\n") : null;
  return { trusted, instructions, skills, hooks, mcpServers: both(mcpServers), approvals, held: [] };
}
