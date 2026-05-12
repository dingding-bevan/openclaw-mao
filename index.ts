// openclaw-mao plugin entry.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}
import { Tracker } from "./tracker.ts";
import { Dispatcher, type DispatchInput } from "./dispatcher.ts";
import { runSetup } from "./setup.ts";
import { parsePrefix } from "./parser.ts";
import { PlanGate } from "./plan-gate.ts";
import { ReviewerBridge, type Verdict } from "./reviewer-bridge.ts";
import { Merger } from "./merger.ts";
import { Monitor } from "./monitor.ts";
import { Dashboard } from "./dashboard.ts";
import { Pruner } from "./prune.ts";

const PHASE_NOT_IMPLEMENTED = "Phase 2-4";

function notImplemented(subcommand: string, opts: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ok: false, status: "not_implemented", subcommand, phase: PHASE_NOT_IMPLEMENTED, received: opts }, null, 2));
}

const maoPlugin = definePluginEntry({
  id: "openclaw-mao",
  name: "Multi-Agent Orchestrator",
  description: "Dispatch, track, verify, review multi-agent collaboration tasks on OpenClaw.",

  register(api: OpenClawPluginApi) {
    api.logger.info("openclaw-mao: register() called (Phase 1 day 2)");

    Tracker.init(api.resolvePath("data/tasks.db"));
    api.logger.info("openclaw-mao: sqlite tracker ready");

    // IMPORTANT: never spawn host CLI from register(api) — child openclaw process re-loads
    // this plugin and triggers infinite fork recursion. Setup is only run via `mao setup`.

    api.registerCli(
      ({ program }) => {
        const mao = program
          .command("mao")
          .description("Multi-Agent Orchestrator commands")
          .configureHelp({ sortSubcommands: false });

        mao
          .command("setup")
          .description("Verify external CLI binaries (kimi, opencode) are reachable + register monitor cron. Idempotent.")
          .option("--json", "JSON output")
          .option("--skip-cron", "do not register the monitor cron job")
          .action((opts: { skipCron?: boolean }) => {
            const workspaceRoot = api.resolvePath("data");
            const cli = runSetup(api, workspaceRoot);
            const cron = opts.skipCron ? { ok: true, existed: true } : Monitor.ensureCronRegistered(api);
            console.log(JSON.stringify({ ok: cli.ok && cron.ok, cli, cron }, null, 2));
            if (!cli.ok || !cron.ok) process.exitCode = 1;
          });

        mao
          .command("parse")
          .description("Parse a structured TASK: prefix line into a DispatchInput JSON (no side effects)")
          .argument("<text...>", "TASK:<type> | <desc> | priority:high | branch:... | plan-doc:... | parent:...")
          .action((parts: string[]) => {
            const text = parts.join(" ");
            const r = parsePrefix(text);
            console.log(JSON.stringify(r, null, 2));
            if (!r.ok) process.exitCode = 2;
          });

        mao
          .command("dispatch")
          .description("Dispatch a task to an agent (--prefix wins over --type/--description)")
          .option("--prefix <text>", 'structured input "TASK:<type> | <desc> | ..." (replaces --type/--description)')
          .option("--type <type>", "bugfix | feature | refactor | plan-doc | review")
          .option("--priority <level>", "low | medium | high", "medium")
          .option("--description <text>", "task description")
          .option("--branch <name>", "branch name override")
          .option("--plan-doc <path>", "required for refactor / plan-mode-gated tasks")
          .option("--parent-task <id>", "parent task id (chain)")
          .option("--review", "force review even for bugfix")
          .option("--manual", "do not spawn LLM; prepare worktree + prompt and let user drive opencode/kimi tui")
          .option("--json", "JSON output instead of human-readable manual plan")
          .action((opts: Record<string, string | boolean | undefined>) => {
            // 1. Resolve DispatchInput: prefer --prefix if given, else assemble from flags.
            let input: DispatchInput | null = null;
            if (opts.prefix) {
              const parsed = parsePrefix(opts.prefix as string);
              if (!parsed.ok) {
                console.log(JSON.stringify({ ok: false, error: `parse: ${parsed.error}` }, null, 2));
                process.exitCode = 2;
                return;
              }
              input = parsed.input;
              // Allow flag overlays for fields parser didn't fill
              if (opts.priority && !input.priority) input.priority = opts.priority as DispatchInput["priority"];
              if (opts.branch && !input.branch) input.branch = opts.branch as string;
              if (opts.planDoc && !input.planDoc) input.planDoc = opts.planDoc as string;
              if (opts.parentTask && !input.parentTask) input.parentTask = opts.parentTask as string;
              if (opts.review) input.reviewRequired = true;
            } else {
              if (!opts.type || !opts.description) {
                console.log(JSON.stringify({ ok: false, error: "--type and --description (or --prefix) are required" }, null, 2));
                process.exitCode = 2;
                return;
              }
              const validTypes = ["bugfix", "feature", "refactor", "plan-doc", "review"] as const;
              if (!validTypes.includes(opts.type as (typeof validTypes)[number])) {
                console.log(JSON.stringify({ ok: false, error: `invalid --type, expected one of ${validTypes.join("|")}` }, null, 2));
                process.exitCode = 2;
                return;
              }
              input = {
                type: opts.type as DispatchInput["type"],
                priority: (opts.priority as DispatchInput["priority"]) ?? "medium",
                description: opts.description as string,
                branch: opts.branch as string | undefined,
                planDoc: opts.planDoc as string | undefined,
                parentTask: opts.parentTask as string | undefined,
                reviewRequired: opts.review ? true : undefined,
              };
            }
            if (opts.manual) input.mode = "manual";

            // 2. Plan-mode gate
            const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
            const gateCfg = { keywords: (cfg.planGateKeywords as string[] | undefined) ?? [] };
            const verdict = PlanGate.check(input, gateCfg);
            if (verdict.gated) {
              console.log(
                JSON.stringify(
                  {
                    ok: false,
                    error: "plan-mode gate triggered",
                    reason: verdict.reason,
                    matched_keywords: verdict.matchedKeywords,
                    hint: "first dispatch a `plan-doc` task, then re-run with --plan-doc <path>",
                  },
                  null,
                  2,
                ),
              );
              process.exitCode = 2;
              return;
            }

            // 3. Hand off to Dispatcher (chain validation happens inside)
            const result = Dispatcher.create(api, input);
            if (!result.ok) {
              console.log(JSON.stringify({ ok: false, error: result.error }, null, 2));
              process.exitCode = 2;
              return;
            }
            const row = result.row;
            const manualPlan = result.manual_plan;

            // Manual mode: human-readable 3-step guide, unless --json
            if (manualPlan && !opts.json) {
              const sep = "─".repeat(72);
              console.log(`✓ Task ${row.task_id} tracked (sub_status=${row.sub_status}, mode=manual)`);
              console.log(`✓ Worktree:  ${row.worktree_path}`);
              console.log(`✓ Branch:    ${row.branch} (forked from mao-main)`);
              console.log("");
              console.log(`${sep}\nStep 1: Open opencode/kimi tui\n${sep}`);
              console.log("");
              console.log(`  ${manualPlan.ssh_command}`);
              console.log("");
              console.log(`${sep}\nStep 2: Switch agent profile\n${sep}`);
              console.log("");
              console.log(`  ${manualPlan.recommended_agent}`);
              console.log(`  ${manualPlan.next_step_hint}`);
              console.log("");
              console.log(`${sep}\nStep 3: Paste this prompt\n${sep}`);
              console.log("");
              console.log(manualPlan.prompt_to_paste);
              console.log("");
              console.log(`${sep}\nStep 4: When agent finishes (commit + push)\n${sep}`);
              console.log("");
              console.log(`  mao monitor will auto-detect within 5 min and move task to verifying.`);
              console.log(`  To trigger immediately on host:`);
              console.log(`     openclaw mao monitor-tick`);
              console.log("");
              return;
            }

            console.log(
              JSON.stringify(
                {
                  ok: true,
                  task_id: row.task_id,
                  assignee: row.assignee,
                  branch: row.branch,
                  sub_status: row.sub_status,
                  mode: row.mode,
                  parent_task: row.openclaw_parent_task_id,
                  worktree: row.worktree_path,
                  created_at: row.created_at,
                  ...(manualPlan ? { manual_plan: manualPlan } : {}),
                },
                null,
                2,
              ),
            );
          });

        mao
          .command("status")
          .description("Show task status by id (also prints resume command if tui session is recoverable)")
          .argument("<task-id>", "mao task id")
          .option("--json", "JSON output")
          .action((taskId: string) => {
            const row = Tracker.get(taskId);
            if (!row) {
              console.log(JSON.stringify({ ok: false, error: "task not found", task_id: taskId }, null, 2));
              process.exitCode = 1;
              return;
            }
            // Build resume hint when worktree is still on disk (regardless of state — user may want to inspect)
            const fs = require("node:fs") as typeof import("node:fs");
            let resume_command: string | null = null;
            if (row.worktree_path && fs.existsSync(row.worktree_path)) {
              const cli = row.assignee === "kimi" ? "kimi" : "opencode";
              const sidPart = row.external_session_id
                ? row.assignee === "kimi"
                  ? `kimi -r ${row.external_session_id}`
                  : `opencode --session ${row.external_session_id}`
                : `${cli} -c`;
              resume_command = `ssh -t admin@47.85.199.78 "cd ${row.worktree_path} && ${sidPart}"`;
            }
            console.log(JSON.stringify({ ok: true, ...row, resume_command }, null, 2));
          });

        mao
          .command("list")
          .description("List tracked tasks")
          .option("--filter <expr>", "filter, e.g. 'sub_status=running'")
          .option("--json", "JSON output")
          .action((opts: { filter?: string }) => {
            const filter: { sub_status?: string; assignee?: string; type?: string } = {};
            if (opts.filter) {
              for (const part of opts.filter.split(/[, ]+/)) {
                const [k, v] = part.split("=");
                if (k && v) (filter as Record<string, string>)[k.trim()] = v.trim();
              }
            }
            const rows = Tracker.list(filter as Parameters<typeof Tracker.list>[0]);
            console.log(JSON.stringify({ ok: true, count: rows.length, tasks: rows }, null, 2));
          });

        mao
          .command("continue")
          .description("Reply to an awaiting_clarification task or retry a failed task with a corrective message")
          .argument("<task-id>", "mao task id (must be in sub_status=awaiting_clarification)")
          .requiredOption("--message <text>", "your reply to the agent's CLARIFY question")
          .action(async (taskId: string, opts: { message: string }) => {
            const result = await Dispatcher.continue(api, taskId, opts.message);
            console.log(JSON.stringify({ ...result, task_id: taskId }, null, 2));
            if (!result.ok) process.exitCode = 1;
          });

        mao
          .command("cancel")
          .description("Cancel a running task")
          .argument("<task-id>", "mao task id")
          .action((taskId: string) => {
            const ok = Dispatcher.cancel(api, taskId);
            console.log(JSON.stringify({ ok, task_id: taskId }, null, 2));
            if (!ok) process.exitCode = 1;
          });

        mao
          .command("cleanup")
          .description("Clean up worktree + branch for a finished task")
          .argument("<task-id>", "mao task id")
          .action((taskId: string) => {
            const result = Dispatcher.cleanup(api, taskId);
            console.log(JSON.stringify({ ...result, task_id: taskId }, null, 2));
            if (!result.ok) process.exitCode = 1;
          });

        mao
          .command("merge")
          .description("Fast-forward merge a completed task into main + push + cleanup")
          .argument("<task-id>", "mao task id (sub_status must be completed or pushed)")
          .option("--dry-run", "only show diff stat + commits, do not merge")
          .option("--no-cleanup", "keep worktree + branch after merge")
          .action((taskId: string, opts: { dryRun?: boolean; cleanup?: boolean }) => {
            const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
            const workspaceRoot = expandHome((cfg.workspaceRoot as string) ?? "~/.openclaw/workspace");
            const baseBranch = (cfg.baseBranch as string) ?? "main";
            const result = Merger.merge(api, taskId, {
              dryRun: opts.dryRun,
              noCleanup: opts.cleanup === false, // commander auto-converts --no-cleanup to cleanup:false
              workspaceRoot,
              baseBranch,
            });
            console.log(JSON.stringify(result, null, 2));
            if (!result.ok) process.exitCode = 1;
          });

        mao
          .command("accept")
          .description("Force ff-merge a task into baseBranch even if sub_status is failed/awaiting_*/reviewing. Use when you've manually reviewed the diff. Common case: agent reported DONE but verify failed on uncommitted_changes (zero-commit antipattern) — first `git add . && git commit && git push` on the task branch, then `mao accept` to advance the state machine and run CI.")
          .argument("<task-id>", "mao task id")
          .option("--no-cleanup", "keep worktree+branch after merge")
          .option("--json", "JSON output")
          .action((taskId: string, opts: { cleanup?: boolean; json?: boolean }) => {
            const row = Tracker.get(taskId);
            if (!row) {
              console.log(JSON.stringify({ ok: false, error: `task ${taskId} not found` }, null, 2));
              process.exitCode = 1;
              return;
            }
            const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
            const workspaceRoot = expandHome((cfg.workspaceRoot as string) ?? "~/.openclaw/workspace");
            const baseBranch = (cfg.baseBranch as string) ?? "main";
            const result = Merger.merge(api, taskId, {
              dryRun: false,
              noCleanup: opts.cleanup === false,
              workspaceRoot,
              baseBranch,
              force: true,
            });
            if (result.ok && result.merged) {
              // force the sub_status to completed (escape hatch out of stuck states)
              Tracker.update(taskId, {
                sub_status: "completed",
                completed_at: new Date().toISOString(),
              });
            }
            console.log(JSON.stringify(result, null, 2));
            if (!result.ok) process.exitCode = 1;
          });

        mao
          .command("monitor-tick")
          .description("One-shot monitor pass: scan stuck tasks + auto-detect manual completions + worktree disk usage")
          .option("--json", "JSON output")
          .action(() => {
            const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
            const bins = (cfg.agentBinaries as { kimi?: string; opencode?: string } | undefined) ?? {};
            const lh = (cfg.loopHealth ?? {}) as Record<string, number>;
            const result = Monitor.tick(api, {
              stuckHeartbeatMin: (cfg.stuckHeartbeatMin as number) ?? 30,
              verifyingTimeoutMin: (cfg.verifyingTimeoutMin as number) ?? 5,
              workspaceRoot: cfg.workspaceRoot as string | undefined,
              baseBranch: (cfg.baseBranch as string | undefined) ?? "main",
              verifyMode: (cfg.verifyMode as "skip" | "git" | undefined) ?? "git",
              diskAlertGiB: (cfg.diskAlertGiB as number | undefined) ?? 5,
              worktreeRetentionHours: (cfg.worktreeRetentionHours as number | undefined) ?? 24,
              agentBinaries: { kimi: bins.kimi ?? "kimi", opencode: bins.opencode ?? "opencode" },
              unhealthyStepThreshold: lh.unhealthyStepThreshold,
              unhealthyNoMtimeMin: lh.unhealthyNoMtimeMin,
              loopHealthWarmupMin: lh.loopHealthWarmupMin,
              tmuxRetentionMin: (cfg.tmuxRetentionMin as number) ?? 60,
            });
            console.log(JSON.stringify(result, null, 2));
          });

        mao
          .command("open")
          .description("Print a one-line ssh -t command to attach the task's tmux session (copy-paste from your mac or VPS workbench)")
          .argument("<task-id>", "mao task id")
          .option("--json", "JSON output")
          .option("--vps <user@host>", "override default VPS host", "admin@47.85.199.78")
          .action((taskId: string, opts: { json?: boolean; vps?: string }) => {
            const row = Tracker.get(taskId);
            if (!row) {
              console.log(JSON.stringify({ ok: false, error: `task ${taskId} not found` }, null, 2));
              process.exitCode = 1;
              return;
            }
            if (!row.tmux_session_name) {
              console.log(JSON.stringify({
                ok: false,
                error: "task has no tmux session (likely created before Wave 3, or session was killed)",
                hint: "Use `mao status` to inspect; if worktree still exists, ssh directly: " +
                      `ssh -t ${opts.vps} "cd ${row.worktree_path}"`,
              }, null, 2));
              process.exitCode = 1;
              return;
            }
            const hasSession = spawnSync("tmux", ["has-session", "-t", row.tmux_session_name], { encoding: "utf8" });
            const alive = hasSession.status === 0;

            const sshCmd = `ssh -t ${opts.vps} "tmux attach -t ${row.tmux_session_name}"`;
            if (opts.json) {
              console.log(JSON.stringify({ ok: true, task_id: taskId, tmux_session_name: row.tmux_session_name, alive, ssh_command: sshCmd }, null, 2));
              return;
            }
            console.log(`Attach to ${taskId} (tmux session: ${row.tmux_session_name}, ${alive ? "alive" : "dead"}):`);
            console.log("");
            console.log(`  ${sshCmd}`);
            console.log("");
            if (!alive) {
              console.log(`  WARNING: tmux session not currently running. The agent process has exited.`);
              console.log(`  You may still attach to a detached session if it hasn't been swept by monitor.`);
            }
            console.log("");
            console.log(`Detach inside tmux: Ctrl-b then d   (session keeps running)`);
            console.log(`Kill from outside:  ssh ${opts.vps} "tmux kill-session -t ${row.tmux_session_name}"`);
          });

        mao
          .command("dashboard")
          .description("Render an active-task table (use --all to include terminal states)")
          .option("--all", "include completed/failed/cancelled tasks")
          .option("--agent <id>", "filter by assignee")
          .option("--type <t>", "filter by type")
          .option("--json", "JSON output instead of table")
          .action((opts: { all?: boolean; agent?: string; type?: string; json?: boolean }) => {
            if (opts.json) {
              const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
              void cfg; // not needed, just to mirror dispatch
              const rows = Tracker.list();
              const filtered = opts.all ? rows : rows.filter((r) => !["completed", "failed", "cancelled"].includes(r.sub_status));
              const agent = opts.agent;
              const type = opts.type;
              const out = filtered
                .filter((r) => !agent || r.assignee === agent)
                .filter((r) => !type || r.type === type);
              console.log(JSON.stringify({ ok: true, count: out.length, tasks: out }, null, 2));
              return;
            }
            console.log(Dashboard.render({ showAll: opts.all, filterAgent: opts.agent, filterType: opts.type }));
          });

        mao
          .command("prune")
          .description("Scan for orphan worktrees + branches (terminal/missing tasks). Default dry-run.")
          .option("--apply", "actually remove orphans (default is dry-run)")
          .action((opts: { apply?: boolean }) => {
            const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
            const workspaceRoot = expandHome((cfg.workspaceRoot as string) ?? "~/.openclaw/workspace");
            const result = Pruner.prune(api, { workspaceRoot, dryRun: !opts.apply });
            console.log(JSON.stringify(result, null, 2));
          });

        mao
          .command("review-bundle")
          .description("Prepare review bundle for Claude Code: task row + git diff + plan-doc + agent result")
          .argument("<task-id>", "mao task id")
          .option("--json", "JSON output (always JSON)")
          .action((taskId: string) => {
            const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
            const baseBranch = (cfg.baseBranch as string) ?? "main";
            const bundle = ReviewerBridge.prepareBundle(api, taskId, baseBranch);
            console.log(JSON.stringify(bundle, null, 2));
            if (!bundle.ok) process.exitCode = 1;
          });

        mao
          .command("review-result")
          .description("Write back review verdict; pass→completed, fail→retry once or failed, needs-clarification→failed")
          .argument("<task-id>", "mao task id")
          .requiredOption("--verdict <v>", "pass | fail | needs-clarification")
          .option("--feedback <text>", "feedback text (required for fail; included in retry prompt)")
          .action((taskId: string, opts: { verdict: string; feedback?: string }) => {
            const valid: Verdict[] = ["pass", "fail", "needs-clarification"];
            if (!valid.includes(opts.verdict as Verdict)) {
              console.log(JSON.stringify({ ok: false, error: `invalid --verdict, expected one of ${valid.join("|")}` }, null, 2));
              process.exitCode = 2;
              return;
            }
            const result = ReviewerBridge.recordVerdict(api, taskId, opts.verdict as Verdict, opts.feedback);
            console.log(JSON.stringify({ ...result, task_id: taskId }, null, 2));
            if (!result.ok) {
              process.exitCode = 1;
              return;
            }
            // If review feedback triggered a retry, fire the resume run async.
            if (result.retried) {
              void Dispatcher.resumeAfterReviewFail(api, taskId).catch((err) =>
                api.logger.error(`openclaw-mao: resumeAfterReviewFail task=${taskId}: ${(err as Error).message}`),
              );
            } else if (result.new_sub_status === "completed" || result.new_sub_status === "failed") {
              // Notify chain (unblock children on pass, cascade-cancel on fail).
              const row = Tracker.get(taskId);
              if (row) Dispatcher.afterTerminal(api, row);
            }
          });

        api.logger.info("openclaw-mao: 16 subcommands registered (+ open + accept — v0.2.1 wave 2 — all real)");
      },
      {
        descriptors: [
          { name: "mao", description: "Multi-Agent Orchestrator commands", hasSubcommands: true },
        ],
      },
    );
  },
});

export default maoPlugin;
