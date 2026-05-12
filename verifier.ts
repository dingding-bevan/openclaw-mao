import { spawnSync } from "node:child_process";

export type VerifyMode = "skip" | "git";

export interface VerifyResult {
  ok: boolean;
  reason?: "uncommitted_changes" | "commits_not_pushed" | "branch_not_on_origin" | "skipped";
  detail?: string;
}

function gitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const Verifier = {
  verify(worktreePath: string, branch: string, mode: VerifyMode = "git"): VerifyResult {
    if (mode === "skip") {
      return { ok: true, reason: "skipped" };
    }

    // 1. Working tree clean
    const status = gitSync(worktreePath, ["status", "--porcelain"]);
    if (status.stdout.trim()) {
      return { ok: false, reason: "uncommitted_changes", detail: status.stdout.trim() };
    }

    // 2. Local commits all pushed
    const ahead = gitSync(worktreePath, ["rev-list", `origin/${branch}..HEAD`]);
    if (ahead.stdout.trim()) {
      return { ok: false, reason: "commits_not_pushed", detail: ahead.stdout.trim() };
    }

    // 3. Branch exists on origin
    const remote = gitSync(worktreePath, ["ls-remote", "origin", branch]);
    if (!remote.stdout.trim()) {
      return { ok: false, reason: "branch_not_on_origin", detail: `origin has no branch ${branch}` };
    }

    return { ok: true };
  },
};
