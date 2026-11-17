// A role is a name, a brief, and the tools it may call. The limit is enforced where tools run (lib/tools.mjs), so a role
// cannot be talked out of it: an evaluator has no tool that writes, and the one command it can run is the check a person
// configured, never one the model wrote.
export const ROLES = {
  builder: {
    name: "builder",
    mcp: true,                                                  // may use the connectors a project configured
    tools: ["read_file", "list_files", "search", "script", "write_file", "edit_file", "run", "run_background", "read_output", "kill_command", "propose_skill", "delegate", "apply_work"],
    brief: "You build and fix code in this workspace. Read before you edit. Make the smallest change that does the job, then run the project's own checks. You do not decide whether the task succeeded: a check command the person configured decides that after you stop.",
  },
  scout: {
    name: "scout",
    tools: ["read_file", "list_files", "search", "script"],
    brief: "You answer one question about this workspace by reading it. You cannot change anything or run anything. Answer with what you found and where (file and line). If you did not find it, say so.",
  },
  worker: {
    name: "worker",
    tools: ["read_file", "list_files", "search", "write_file", "edit_file", "run"],
    brief: "You do one self-contained piece of work in your own copy of the project. Nothing you change reaches the shared project until the builder applies it. Make the change, check it as far as you can, and report exactly what you changed and anything you could not finish.",
  },
  evaluator: {
    name: "evaluator",
    tools: ["read_file", "run_check"],
    brief: "You did not build this. Read the code and run the configured check. Report what the check shows, what you verified by running and what only by reading, and any defect you found. You cannot change files.",
  },
};
// the roles a builder may hand a sub-task to. scout and evaluator are read-only; a worker writes, in its own worktree. None can delegate further
export const DELEGABLE = ["scout", "evaluator", "worker"];
