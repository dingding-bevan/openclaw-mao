import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface WorktreeRef {
  worktreePath: string;
  branch: string;
}

function gitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const Worktree = {
  create(workspaceRoot: string, agentId: string, taskId: string, branch: string, baseBranch: string = "main"): WorktreeRef {
    if (!existsSync(`${workspaceRoot}/.git`)) {
      throw new Error(`workspace is not a git repo: ${workspaceRoot}`);
    }
    const worktreePath = `${workspaceRoot}/worktrees/${agentId}-${taskId}`;

    // 1. branch from origin/<baseBranch> if exists, else local <baseBranch>
    const baseRef = gitSync(workspaceRoot, ["rev-parse", "--verify", `origin/${baseBranch}`]).ok
      ? `origin/${baseBranch}`
      : baseBranch;

    const branchExists = gitSync(workspaceRoot, ["rev-parse", "--verify", branch]).ok;
    if (!branchExists) {
      const b = gitSync(workspaceRoot, ["branch", branch, baseRef]);
      if (!b.ok) throw new Error(`git branch failed: ${b.stderr}`);
    }

    // 2. worktree add (idempotent: skip if path already a worktree)
    const wtList = gitSync(workspaceRoot, ["worktree", "list", "--porcelain"]);
    if (!wtList.stdout.includes(`worktree ${worktreePath}\n`)) {
      const wt = gitSync(workspaceRoot, ["worktree", "add", worktreePath, branch]);
      if (!wt.ok) throw new Error(`git worktree add failed: ${wt.stderr}`);
    }

    return { worktreePath, branch };
  },

  remove(workspaceRoot: string, agentId: string, taskId: string, branch: string): void {
    const worktreePath = `${workspaceRoot}/worktrees/${agentId}-${taskId}`;
    if (existsSync(worktreePath)) {
      gitSync(workspaceRoot, ["worktree", "remove", worktreePath, "--force"]);
    }
    // Branch deletion is best-effort; only delete if not on a tracked remote.
    gitSync(workspaceRoot, ["branch", "-D", branch]);
  },
};
