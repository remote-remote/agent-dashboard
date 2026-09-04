import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

const cache = new Map<string, string>();

/**
 * Resolve a cwd to the git repo root that contains it, falling back to the cwd
 * itself when there is none (a bare `~` session, a `mktemp -d` run). This
 * collapses sessions started in different subdirectories of one repo into a
 * single project without special-casing throwaway directories.
 */
export function resolveProject(cwd: string): string {
  if (cwd === "") return "";

  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;

  const root = parse(cwd).root;
  let dir = cwd;

  while (true) {
    if (existsSync(join(dir, ".git"))) {
      cache.set(cwd, dir);
      return dir;
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cache.set(cwd, cwd);
  return cwd;
}

export function clearProjectCache(): void {
  cache.clear();
}
