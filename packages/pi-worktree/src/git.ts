import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

/** Branch names become directory names, so keep them to one safe path segment. */
export function slug(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

export interface Worktree {
  branch: string;
  dir: string;
  /** The main checkout the worktree belongs to. */
  root: string;
  /** False when the directory already existed and was reused. */
  created: boolean;
}

/**
 * The main checkout, even when `cwd` is itself a linked worktree,
 * so worktrees made from worktrees still land side by side.
 */
async function mainRoot(cwd: string): Promise<string> {
  const common = path.resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"]));
  return path.basename(common) === ".git" ? path.dirname(common) : await git(cwd, ["rev-parse", "--show-toplevel"]);
}

/** `<parent>/<repo>.worktrees/<branch>`, created from HEAD when the branch is new. */
export async function ensureWorktree(cwd: string, branch: string): Promise<Worktree> {
  const root = await mainRoot(cwd);
  const dir = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, slug(branch));
  if (fs.existsSync(dir)) return { branch, dir, root, created: false };
  await git(root, ["check-ref-format", "--branch", branch]);
  const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
  await git(cwd, exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { branch, dir, root, created: true };
}

/** Fails, leaving everything in place, when the worktree has uncommitted changes. */
export async function removeWorktree(worktree: Worktree): Promise<void> {
  await git(worktree.root, ["worktree", "remove", worktree.dir]);
}
