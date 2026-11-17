// Approvals. Reading is free. Changing files, running commands and calling connectors each pass a policy first: a deny rule
// refuses, an allow rule permits, and what no rule covers is decided by the mode: ask a person, allow (auto), or refuse.
// With nobody to ask, the answer is no. A person answers; a model's text or a tool's output never does.
// A rule is "<class>:<pattern>" with * as a wildcard: run:npm test, run:git *, edit:src/*, mcp:files__*.
const FREE = new Set(["read_file", "list_files", "search", "run_check", "recall_context", "read_skill", "delegate", "propose_skill"]);
const OPERATORS = /[;&|`$><\n\r]/;                         // anything that chains, substitutes or redirects in a shell

export function classOf(tool, args = {}) {
  if (FREE.has(tool)) return null;
  if (tool === "write_file" || tool === "edit_file") return ["edit", String(args.path ?? "")];
  if (tool === "run") return ["run", String(args.command ?? "").trim()];
  if (tool.startsWith("mcp__")) return ["mcp", tool.slice(5)];
  return ["other", tool];
}

export function matches(rule, cls, target) {
  const i = String(rule).indexOf(":"); if (i < 0 || rule.slice(0, i) !== cls) return false;
  const pattern = rule.slice(i + 1); if (pattern === target) return true;
  if (!pattern.includes("*")) return false;
  // a wildcard never covers a command that chains, pipes, substitutes or redirects: `npm *` must not allow `npm test; rm -rf x`
  if (cls === "run" && OPERATORS.test(target)) return false;
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(target);
}

export function makePolicy({ mode = "ask", allow = [], deny = [], approver = null, onRule = () => {} } = {}) {
  const allowed = [...allow];
  return {
    mode, get allow() { return [...allowed]; },
    async check(tool, args) {
      const c = classOf(tool, args); if (!c) return { allow: true };
      const [cls, target] = c, rule = `${cls}:${target}`;
      const no = deny.find((r) => matches(r, cls, target)); if (no) return { allow: false, reason: `denied by the rule ${no}` };
      if (allowed.some((r) => matches(r, cls, target)) || mode === "auto") return { allow: true };
      if (mode === "ask" && approver) {
        const a = String(await approver({ tool, cls, target, text: `${cls}: ${target}` }) ?? "").trim().toLowerCase();
        if (a === "always" || a === "a") { allowed.push(rule); onRule(rule); return { allow: true }; }
        if (a === "yes" || a === "y") return { allow: true };
        return { allow: false, reason: "the person declined this" };
      }
      return { allow: false, reason: `no rule allows this${mode === "ask" ? " and there is nobody to ask in this run" : ""}. A person can allow it by adding the rule "${rule}" (pulse-agent allow "${rule}"), or by running with --yes. Do not retry it; continue without it or say what you could not do.` };
    },
  };
}
