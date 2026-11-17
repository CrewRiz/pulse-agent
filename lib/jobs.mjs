// Background commands: start one, keep working, read what it has printed since you last looked, stop it. Each runs in its
// own process group so stopping it stops everything it started. At most four at once, output held to a cap, and whatever is
// still running when the run (or the chat) ends is stopped: nothing outlives the agent by accident.
import { spawn } from "node:child_process";

const MAX = 4, CAP = 200000;

export function createJobs({ cwd }) {
  const jobs = new Map(); let n = 0;
  const stop = (j) => { try { process.kill(-j.child.pid, "SIGKILL"); } catch { try { j.child.kill("SIGKILL"); } catch { /* already gone */ } } };
  return {
    running() { return [...jobs.values()].filter((j) => j.code === undefined).length; },
    start(command) {
      if (this.running() >= MAX) return { ok: false, output: `at most ${MAX} background commands at once; stop one with kill_command first` };
      const id = `bg-${++n}`, child = spawn("/bin/sh", ["-c", String(command)], { cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const j = { id, command: String(command), child, out: "", read: 0, code: undefined, cut: 0 }; jobs.set(id, j);
      const take = (d) => { j.out += d; if (j.out.length > CAP) { const drop = j.out.length - CAP; j.out = j.out.slice(drop); j.read = Math.max(0, j.read - drop); j.cut += drop; } };
      child.stdout.on("data", take); child.stderr.on("data", take); child.on("close", (code) => { j.code = code; }); child.on("error", (e) => { j.out += `\n${e.message}`; j.code = -1; });
      return { ok: true, output: `started ${id}: ${j.command}\nread_output {"id":"${id}"} shows what it prints; kill_command stops it. It is stopped when this run ends.` };
    },
    read(id) {
      const j = jobs.get(id); if (!j) return { ok: false, output: `no background command ${id}` };
      const fresh = j.out.slice(j.read); j.read = j.out.length;
      return { ok: true, output: `${fresh || "(nothing new)"}\n[${id} ${j.code === undefined ? "still running" : j.code === null ? "was stopped" : `exited with code ${j.code}`}${j.cut ? `; ${j.cut} earlier characters dropped` : ""}]` };
    },
    kill(id) { const j = jobs.get(id); if (!j) return { ok: false, output: `no background command ${id}` }; if (j.code !== undefined) return { ok: true, output: `${id} had already finished` }; stop(j); return { ok: true, output: `stopped ${id}` }; },
    killAll() { for (const j of jobs.values()) if (j.code === undefined) stop(j); },
  };
}
