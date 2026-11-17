// A role is a name, a brief, and the tools it may call. The limit is enforced where tools run (lib/tools.mjs), so a role
// cannot be talked out of it: an evaluator has no tool that writes, and the one command it can run is the check a person
// configured, never one the model wrote.
export const ROLES = {
  builder: {
    name: "builder",
    tools: ["read_file", "write_file", "edit_file", "run", "propose_skill"],
    brief: "You build and fix code in this workspace. Read before you edit. Make the smallest change that does the job, then run the project's own checks. You do not decide whether the task succeeded: a check command the person configured decides that after you stop.",
  },
  evaluator: {
    name: "evaluator",
    tools: ["read_file", "run_check"],
    brief: "You did not build this. Read the code and run the configured check. Report what the check shows, what you verified by running and what only by reading, and any defect you found. You cannot change files.",
  },
};
