// Isolation for writing subagents. A worker edits in its own git worktree, cut from the project's current commit, so two
// workers cannot collide and nothing a worker does reaches the shared checkout. When it finishes, its changes are kept as a
// patch and the worktree is removed. The builder applies a patch on purpose; one that no longer fits is refused whole.
// With no repository or no commit there is no isolation to give, and the worker is refused rather than run in place.
import { execFileSync } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX = 3;

export function createWorkspaces(root) {
  const git = (cwd, args, input) => execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const patches = new Map(), live = new Map(); let n = 0;
  const remove = (dir) => { try { git(root, ["worktree", "remove", "--force", dir]); } catch { /* already gone */ } };
  return {
    available() { try { git(root, ["rev-parse", "--verify", "-q", "HEAD"]); return git(root, ["rev-parse", "--show-toplevel"]).trim().length > 0; } catch { return false; } },
    open() {
      if (live.size >= MAX) return { error: `at most ${MAX} workers at once; wait for one to finish` };
      const id = `w-${++n}`, dir = join(root, ".pulse-agent", "worktrees", id); live.set(id, dir);
      try {
        mkdirSync(join(root, ".pulse-agent", "worktrees"), { recursive: true });
        const ex = join(git(root, ["rev-parse", "--git-common-dir"]).trim().replace(/^(?!\/)/, `${root}/`), "info", "exclude");
        try { if (!existsSync(ex) || !readFileSync(ex, "utf8").includes(".pulse-agent/")) { mkdirSync(join(ex, ".."), { recursive: true }); appendFileSync(ex, "\n.pulse-agent/\n"); } } catch { /* a read-only repository: the worktree is removed afterwards anyway */ }
        git(root, ["worktree", "add", "-q", "--detach", dir, "HEAD"]);
      } catch (e) { live.delete(id); return { error: `could not make a worktree: ${String(e.stderr ?? e.message).trim().slice(0, 200)}` }; }
      return { id, dir };
    },
    /** the worker is done: keep its changes as a patch, remove its worktree */
    finish(id) {
      const dir = live.get(id); if (!dir) return { files: [], stat: "" };
      let files = [], stat = "";
      try {
        git(dir, ["add", "-A"]); const patch = git(dir, ["diff", "--cached", "--binary", "HEAD"]);
        if (patch.trim()) { patches.set(id, patch); files = git(dir, ["diff", "--cached", "--name-only", "HEAD"]).trim().split("\n").filter(Boolean); stat = git(dir, ["diff", "--cached", "--stat", "HEAD"]).trim(); }
      } catch { /* reported as no changes */ }
      remove(dir); live.delete(id); return { files, stat };
    },
    /** put a worker's patch into the shared checkout, all of it or none of it */
    apply(id) {
      const patch = patches.get(String(id)); if (!patch) return { ok: false, output: `there is no unapplied work named ${id}` };
      try { git(root, ["apply", "--check", "-"], patch); } catch (e) { return { ok: false, output: `work ${id} no longer fits the project as it is now, so none of it was applied (${String(e.stderr ?? e.message).trim().split("\n")[0].slice(0, 160)}). Have a worker redo it on the current files.` }; }
      git(root, ["apply", "-"], patch); const files = git(root, ["apply", "--numstat", "-"], patch).trim().split("\n").filter(Boolean).map((l) => l.split("\t")[2]);
      patches.delete(String(id)); return { ok: true, files, output: `applied work ${id}: ${files.join(", ")}` };
    },
    cleanup() { for (const dir of live.values()) remove(dir); live.clear(); try { git(root, ["worktree", "prune"]); } catch { /* not a repository */ } },
  };
}
