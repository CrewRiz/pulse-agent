// Two agents, two jobs. The builder does the task. Then an evaluator that did not build it, has no tool that writes, and is
// not shown the builder's own account of its work reads the change and runs the check. The check is still the verdict; the
// review is what a second reader found, kept in the ledger. There is nothing to review when no file changed or the check failed.
import { runTask } from "./loop.mjs";
import { openMemory } from "./memory.mjs";

export async function runTeam({ root, task, model, evalModel = model, verify, onEvent = () => {}, ...rest }) {
  const build = await runTask({ root, task, model, verify, onEvent: (e) => onEvent({ ...e, who: "builder" }), ...rest });
  if (build.verdict === "fail" || !build.changed.length) return { verdict: build.verdict, build, review: null };
  const brief = `Review the change that was made for this task: "${task}"\nFiles changed: ${build.changed.join(", ")}\nRead them and run the check. Report what the check shows, what you verified by running and what only by reading, and any defect you found.`;
  const ev = await runTask({ root, task: brief, model: evalModel, role: "evaluator", verify, maxRounds: 1, maxSteps: rest.maxSteps, timeoutMs: rest.timeoutMs, onEvent: (e) => onEvent({ ...e, who: "evaluator" }) });
  const review = ev.answer || "(the evaluator gave no report)";
  openMemory(root).remember({ cause: `review-${String(task).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`, effect: "evaluator-report", tags: ["pulse-agent", "review"], note: review.replace(/\s+/g, " ").slice(0, 600) });
  return { verdict: build.verdict, build, review };
}
