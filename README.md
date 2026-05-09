# openclaw-mao

Multi-Agent Orchestrator plugin for OpenClaw — dispatch, track, verify, and review multi-agent
collaboration tasks with branch-per-agent + worktree isolation + git verification + Claude Code
contract review.

**Status**: 14 real CLI subcommands, e2e closed-loop validated. See `ONBOARDING.md` for setup
and usage.

---

## What it does

`openclaw-mao` lets you run several coding agents in parallel without them stomping on each
other. You dispatch a task; the plugin creates an isolated git worktree on a fresh branch,
spawns the assigned agent (`opencode-dev` / `kimi-bugfix` / `orchestrator`) in that worktree,
runs a multi-turn loop until the agent says `DONE:` or `CLARIFY:`, verifies the result with three
git checks, optionally hands off to a human reviewer, and finally fast-forward-merges into main.

```
dispatch → DONE → verifying → pushed → reviewing
                                           ├─ verdict pass → completed → merge → cleanup
                                           ├─ verdict fail (retry budget) → resume → DONE → reviewing
                                           └─ CLARIFY → awaiting_clarification → continue → DONE
```

Built on the OpenClaw plugin SDK (`definePluginEntry({register(api)})`), backed by a
plugin-owned sqlite database (`better-sqlite3` + WAL), with a Discord notification channel
and a 5-minute monitor cron for stuck/timed-out tasks.

---

## CLI surface (14 subcommands, zero stubs)

| Command | Purpose |
|---|---|
| `mao setup [--skip-cron]` | Register the 3 built-in agents and the monitor cron job. Idempotent. |
| `mao parse "TASK:..."` | Dry-run parse a structured-prefix dispatch line; no side effects. |
| `mao dispatch [--prefix \| --type --description] [--priority] [--branch] [--plan-doc] [--parent-task] [--review]` | Create a task, allocate worktree, spawn agent. |
| `mao continue <id> --message <text>` | Reply to an `awaiting_clarification` task. |
| `mao status <id>` | Full task row from sqlite. |
| `mao list [--filter ...]` | JSON list of all tracked tasks. |
| `mao dashboard [--all] [--agent] [--type]` | Human-readable table. |
| `mao cancel <id>` | Cancel an active task. |
| `mao cleanup <id>` | Remove worktree + branch (terminal tasks only). |
| `mao review-bundle <id>` | Output review bundle JSON (task row + git diff + plan-doc + agent result + contract-check hints). |
| `mao review-result <id> --verdict pass\|fail\|needs-clarification --feedback <text>` | Write back review verdict; pass→completed, fail+retry→resume, needs-clarification→failed. |
| `mao merge <id> [--dry-run] [--no-cleanup]` | Fast-forward merge to main + push + cleanup. |
| `mao monitor-tick` | One-shot monitor pass: scan stuck running/verifying tasks + worktree disk usage. (Cron also calls this.) |
| `mao prune [--apply]` | Find orphan worktrees + branches; default dry-run. |

---

## Quick start

### Prerequisites

- Node.js ≥ 20
- An OpenClaw installation (`openclaw --version` works)
- A git workspace (a real git repo with an `origin` remote and a `main` branch) that mao
  will create worktrees inside

### Install

```bash
git clone https://github.com/<you>/openclaw-mao.git ~/.openclaw/extensions/openclaw-mao
cd ~/.openclaw/extensions/openclaw-mao
npm install
npm run build

openclaw plugins install ~/.openclaw/extensions/openclaw-mao/ \
  --force --dangerously-force-unsafe-install
systemctl --user restart openclaw-gateway.service
```

> **Why `--dangerously-force-unsafe-install`** — OpenClaw's plugin loader statically scans for
> `child_process` and refuses to load plugins that spawn host CLIs. mao has to spawn
> `openclaw agent` / `openclaw agents add` / `git` / `openclaw message send` and so requires
> this flag. Audit `dispatcher.ts` / `setup.ts` / `merger.ts` / `notifier.ts` if you need to
> verify what gets executed.

### Configure

```bash
openclaw config set plugins.entries.openclaw-mao.config.workspaceRoot /path/to/your/workspace
openclaw config set plugins.entries.openclaw-mao.config.discordChannel <discord-channel-id>  # optional
openclaw config set plugins.entries.openclaw-mao.config.verifyMode git                       # or "skip" for dev
systemctl --user restart openclaw-gateway.service
```

### One-time setup

```bash
openclaw mao setup
```

Registers the 3 built-in agents (`opencode-dev` / `kimi-bugfix` / `orchestrator`) and the
5-minute monitor cron job. Idempotent.

---

## Typical workflow

```bash
# Dispatch a feature task (review_required defaults to true for non-bugfix)
openclaw mao dispatch --type feature --description "Add /v2/users/search endpoint with rate-limit"

# Watch progress
openclaw mao dashboard

# When status reaches `reviewing`, pull the bundle
openclaw mao review-bundle <task-id>     # → JSON: task row, git diff, plan-doc, agent result, contract checks

# Decide
openclaw mao review-result <task-id> --verdict pass --feedback "shipped"
# or:
openclaw mao review-result <task-id> --verdict fail --feedback "missing input validation; add Joi schema for query params"
# fail with retry budget triggers a resume turn that addresses the feedback;
# the agent may reply DONE or CLARIFY → awaiting_clarification → mao continue

# Once completed, merge
openclaw mao merge <task-id>             # ff-only + push + cleanup worktree+branch
```

---

## Architecture

```
extensions/openclaw-mao/
├── openclaw.plugin.json     # manifest: id, commandAliases, contracts.tools, configSchema
├── index.ts                 # definePluginEntry — register CLI + 14 subcommands
├── tracker.ts               # sqlite schema + CRUD (better-sqlite3, WAL, schema migrations)
├── sqlite-resilience.ts     # WAL/busy_timeout pragmas + version-based migrations
├── dispatcher.ts            # state machine: dispatch → running (multi-turn) → verifying → pushed → reviewing/completed
├── worktree.ts              # `git worktree add/remove`, branch handling
├── verifier.ts              # 3-check git verification (clean / pushed / on origin); verifyMode=skip|git
├── parser.ts                # `TASK:<type> | <desc> | priority:high | branch:... | plan-doc:... | parent:<id>` parser
├── plan-gate.ts             # refactor keyword + type=refactor block without --plan-doc
├── chain.ts                 # parentTaskId BLOCKED state, cycle detection, cascade unblock/cancel
├── reviewer-bridge.ts       # review bundle assembly + verdict recording + retry budget
├── merger.ts                # ff-only merge + push + best-effort `npm test` + cleanup
├── monitor.ts               # tick: scan stuck/verifying tasks + disk usage; ensureCronRegistered
├── notifier.ts              # Discord push via `openclaw message send` (silent skip if unconfigured)
├── dashboard.ts             # human-readable table renderer
├── prune.ts                 # orphan worktree + branch scan/cleanup
└── setup.ts                 # idempotent agents registration via spawn `openclaw agents add`
```

### Sub-status state machine

```
                       ┌──────────┐
                       │ BLOCKED  │  awaiting parent task
                       └────┬─────┘
                            │ parent pushed/completed
                            ▼
              ┌──────────┐      ┌──────────┐
       ┌──── │ PENDING  │ ◄──── │  queue   │  (active >= concurrencyLimit)
       │     └────┬─────┘
       │          ▼
       │     ┌──────────┐
       │     │ DISPATCH │  worktree create
       │     └────┬─────┘
       │          ▼
       │     ┌──────────┐
       │     │ RUNNING  │ ◄──── multi-turn loop (DONE/CLARIFY/timeout/max-turns)
       │     └────┬─────┘
       │          │ DONE
       │          ▼
       │     ┌────────────┐    CLARIFY    ┌──────────────────────────┐
       │     │ VERIFYING  │ ───────────► │ AWAITING_CLARIFICATION   │
       │     └─────┬──────┘               └────────────┬─────────────┘
       │           │ pass                              │ mao continue
       │           ▼                                   ▼
       │     ┌──────────┐                        (back to RUNNING)
       │     │  PUSHED  │
       │     └────┬─────┘
       │          │ review_required
       │          ▼
       │     ┌────────────┐ verdict=fail+retry  ┌──────────┐
       │     │ REVIEWING  │ ──────────────────► │ RUNNING  │ (resume)
       │     └─────┬──────┘                     └──────────┘
       │           │ verdict=pass
       │           ▼
       │     ┌──────────┐
       └────►│COMPLETED │  (terminal — eligible for `mao merge`)
             └──────────┘
```

Failed/cancelled are terminal too. `mao merge` requires `completed` (or `pushed`).

---

## Configuration reference

All keys live under `plugins.entries.openclaw-mao.config`:

| Key | Default | Purpose |
|---|---|---|
| `concurrencyLimit` | `3` | Max simultaneously-running tasks (BLOCKED tasks don't count) |
| `branchPrefix` | `agent` | Prefix for auto-generated branch names |
| `workspaceRoot` | `~/.openclaw/workspace` | Root git repo where worktrees are created (tilde expanded) |
| `verifyMode` | `git` | `git` runs the 3-check; `skip` bypasses (use only for dev) |
| `timeouts.bugfix/feature/refactor/planDoc` | `15/60/120/30` minutes | Per-type runtime ceiling |
| `highPriorityMultiplier` | `1.5` | `priority=high` extends timeouts by this factor |
| `verifyingTimeoutMin` | `5` | Verifying state timeout, then auto-fail |
| `stuckHeartbeatMin` | `30` | Running > N minutes flips to failed (TaskFlow.lost) |
| `planGateKeywords` | `["重构","迁移","替换","refactor","migrate","replace","框架替换"]` | Description triggers requiring `--plan-doc` |
| `reviewRequiredTypes` | `["feature","refactor","plan-doc"]` | Types that default to `review_required=true` |
| `retry.running/review/verifying` | `3/1/0` | Retry budgets per phase |
| `discordChannel` | (unset) | Discord channel id for notifications; unset = silent |
| `diskAlertGiB` | `5` | Worktrees total bytes ≥ this triggers Discord disk alert; `0` disables |

---

## Known gotchas

See `ONBOARDING.md` for the full list. The two that bite first:

- **OpenClaw cold start ≈ 14s.** Test scripts need ≥30s timeouts; `mao setup` itself takes
  multiple host CLI invocations and runs ~60s.
- **Never call `spawnSync` from `register(api)`.** Spawning a child `openclaw` process during
  plugin registration triggers infinite fork recursion (the child loads this plugin and
  spawns again). All host-CLI calls must be inside subcommand actions, not in the
  `register(api)` body. That's why `mao setup` is a subcommand, not an `onInstall` hook.

---

## License

MIT (see `LICENSE`).
