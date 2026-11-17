// The agent works inside one directory. Every path a tool receives is resolved here, and a path that leaves the workspace,
// directly or through a link, is refused before anything is read or written.
import { realpathSync, existsSync } from "node:fs";
import { resolve, sep, dirname } from "node:path";

const real = (p) => { let cur = p; while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) break; cur = up; } return realpathSync(cur) + p.slice(cur.length); };

export function resolveIn(root, path) {
  if (typeof path !== "string" || !path.trim()) throw new Error("empty path");
  const base = realpathSync(root), full = real(resolve(base, path));
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`${path} is outside the workspace`);
  return full;
}
