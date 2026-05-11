# openclaw-mao

> 🌐 **Language**: [English](README.md) · **简体中文**

OpenClaw 的多 Agent 编排插件 —— 派发、跟踪、校验、审查多 agent 协作任务，
基于「branch-per-agent + worktree 隔离 + git 强校验 + Claude Code 契约 review」。

**版本**：v0.2.1（双模式：全自动 + 半自动），**16 个真实 CLI 子命令**，e2e 闭环验证。
完整安装/配置/使用流程见 [`ONBOARDING.zh-CN.md`](ONBOARDING.zh-CN.md)。

---

## 使用模型

本插件设计上以 **Claude Code 为主编排师**：

1. **你**：在 Claude Code 会话里用自然语言说「想做 X」
2. **Claude Code**：按 `~/.claude/CLAUDE.md` 的 ask-first-gate 规则**自动**判断
   `type` / `assignee` / `review_required`，组装完整 dispatch 命令，先发一行摘要让你拍板
3. **你**：回 `y/yes/确认`（或调整 description）
4. **Claude Code**：通过 ssh 真派 mao，跟踪状态机，进 `reviewing` 时主动拉 review-bundle
   并给契约审查 verdict 建议
5. **你**：确认 pass / fail
6. **Claude Code**：跑 `review-result` + `merge`，最后报结果

**人类是 confirm 步骤，不是 dispatch 步骤。** 你不需要记 task_id、不需要拼 ssh 命令、不需要
查子命令 flag——Claude Code 全替你做。

底下 CLI 表 + ONBOARDING §5 列的直接命令是**底层接口**：用于开发 / 调试 mao 自身，
或 Claude Code 不可用时的 fallback。

---

## 它做什么

`openclaw-mao` 让你（通过 Claude Code）**编排已经装在 VPS 上的两个独立 coding-agent CLI**：
- **`kimi`**（Kimi Code CLI，K2.6 模型 + 你 `~/.kimi/AGENTS.md` 的工作守则 + OAuth 计费套餐）
- **`opencode`**（OpenCode CLI，内含 sisyphus 17 内部 agent swarm + 5 LLM provider）

你派一个任务 → mao 创建独立的 git worktree（从配置的 baseBranch 切新分支）→ 调用对应外部 CLI
（bugfix 用 `kimi --quiet`，其他用 `opencode run`）→ 多 turn 循环直到 agent 回 `DONE:` 或
`CLARIFY:` → 三项 git 校验 → 可选 human review → fast-forward merge 到 baseBranch。

### v0.2.1 双派发模式

| 模式 | 触发 | 适合场景 | 谁开 LLM 对话 |
|------|------|---------|--------------|
| **全自动** | `mao dispatch --type bugfix ...` | 小修小补、bug、单文件改动 | mao 自动 spawn kimi/opencode |
| **半自动** | `mao dispatch --type plan-doc --manual ...` | 大事、设计文档、重构 | **你自己** ssh 进 opencode tui，TAB 切到 Prometheus / Hephaestus / etc，按你最佳实践写 |

半自动模式下 mao 输出一份 3 步指南（ssh -t / TAB / 粘贴 prompt），你 push 完成后 mao monitor
（每 5 分钟）自动检测完工并推进状态机。

> **v0.2.0 架构修正**：早期版本曾经用 `openclaw agents add kimi-bugfix --model moonshot/kimi-k2.5`
> 在 OpenClaw 内部注册 "agent"，然后通过 `openclaw agent --agent ...` 派发——但这实际上是让
> OpenClaw 自己的 Pi runtime 直连一个 LLM API，**完全绕过了**你在 VPS 上预配的 Kimi Code /
> OpenCode CLI（包括它们的 `AGENTS.md` 工作守则、OAuth 计费套餐、审计日志）。v0.2.0 改为
> 真正 spawn 外部 CLI 二进制。v0.2.0 之前的 sqlite 行里 `assignee` 列仍显示
> `kimi-bugfix / opencode-dev / orchestrator` 是历史数据，不影响当前。

```
[派任务]
  ├── 全自动 ──► pending → dispatch → running → verifying → pushed
  │                                                          │
  └── 半自动 ──► awaiting_human_work（你在 tui 写）           │
                            │ git push 后 monitor 检测       │
                            ▼                                ▼
                  ┌─ 不需 review (bugfix) → completed
                  │
                  └─ 需 review → reviewing
                                  ├─ pass → completed
                                  ├─ fail (1 次 retry) → running
                                  └─ needs-clarification → failed
                                          │
                                          ▼
                          mao merge / mao accept → ff-merge → push → cleanup
```

基于 OpenClaw plugin SDK（`definePluginEntry({register(api)})`），插件自有 sqlite 数据库
（`better-sqlite3` + WAL + schema 迁移），可选 Discord 通知通道，monitor cron 5 分钟扫一次
stuck/timeout 任务 + 半自动完成检测 + worktree retention 清理。

---

## 16 个 CLI 子命令（零 stub）

| 命令 | 用途 |
|------|------|
| `mao setup [--skip-cron]` | 验证外部 CLI（kimi/opencode）二进制可达 + 注册 monitor cron。幂等。 |
| `mao parse "TASK:..."` | Dry-run 解析结构化前缀派发行，无副作用。 |
| `mao dispatch [--manual] [--prefix \| --type --description] [--priority] [--branch] [--plan-doc] [--parent-task] [--review]` | 创建任务，分配 worktree。`--manual` 不 spawn LLM，输出 ssh+prompt 三步指南。 |
| `mao continue <id> --message <text>` | 回复处于 `awaiting_clarification` 的任务。 |
| `mao status <id>` | 完整任务行 + 自动生成的 `resume_command` 字段。 |
| `mao list [--filter ...]` | 所有任务 JSON 列表。 |
| `mao dashboard [--all] [--agent] [--type]` | 人类可读表格（含 mode/resume 列）。 |
| `mao open <id>` | 打印一行 ssh -t 命令，复制粘贴即可进 tui resume session。 |
| `mao cancel <id>` | 取消活跃任务。 |
| `mao cleanup <id>` | 删除 worktree + branch（仅终态任务）。 |
| `mao review-bundle <id>` | 输出 review bundle JSON（task row + git diff + plan-doc + agent result + 契约检查 hint）。 |
| `mao review-result <id> --verdict pass\|fail\|needs-clarification --feedback <text>` | 写回 review 结果；pass→completed，fail+retry→resume，needs-clarification→failed。 |
| `mao merge <id> [--dry-run] [--no-cleanup]` | Fast-forward merge 到 baseBranch + push + cleanup。 |
| `mao accept <id>` | 强制 ff-merge（绕过 sub_status 检查，cancelled 仍 hard-block）。状态机卡死时的逃生口。 |
| `mao monitor-tick` | 一次性扫描：stuck 任务 + 半自动完成检测 + worktree 磁盘占用 + retention 清理。（cron 也调它。） |
| `mao prune [--apply]` | 找孤儿 worktree + branch，默认 dry-run。 |

---

## 快速开始

### 前置依赖

- Node.js ≥ 20
- 安装好的 OpenClaw（`openclaw --version` 能跑）
- 一个 git 工作仓库（有 `origin` 和 `main` 分支）—— mao 会在里面建 worktree
- VPS 上装好 `kimi`（Kimi Code CLI）和 `opencode`（OpenCode CLI）

### 安装

```bash
git clone https://github.com/<你>/openclaw-mao.git ~/.openclaw/extensions/openclaw-mao
cd ~/.openclaw/extensions/openclaw-mao
npm install
npm run build

openclaw plugins install ~/.openclaw/extensions/openclaw-mao/ \
  --force --dangerously-force-unsafe-install
systemctl --user restart openclaw-gateway.service
```

> **为什么需要 `--dangerously-force-unsafe-install`** —— OpenClaw 插件加载器会静态扫描
> `child_process` 调用，对 spawn host CLI 的插件直接拒绝加载。mao 必须 spawn `kimi` /
> `opencode` / `git` / `openclaw message send`，所以这个 flag 是必需的。需要审计的话看
> `dispatcher.ts` / `setup.ts` / `merger.ts` / `notifier.ts`。

### 配置

```bash
# 工作仓库根目录
openclaw config set plugins.entries.openclaw-mao.config.workspaceRoot /path/to/your/repo

# mao 长期分支（推荐用专门的分支，不直接动 main）
openclaw config set plugins.entries.openclaw-mao.config.baseBranch mao-main

# 真实 git 校验
openclaw config set plugins.entries.openclaw-mao.config.verifyMode git

# 可选：Discord 通知
openclaw config set plugins.entries.openclaw-mao.config.discordChannel <你的-channel-id>

systemctl --user restart openclaw-gateway.service
```

### 一次性 setup

```bash
openclaw mao setup
```

v0.2.0+: 验证外部 CLI 二进制 `kimi` 和 `opencode` 在 PATH 上可达且 `--version` 有响应。
（不再注册 OpenClaw 内部 agent —— 那是 v0.1 的架构错误。）Cron 注册当前 **跳过**——
OpenClaw cron 只支持 `--agent --message`，不支持 raw shell command 如 `openclaw mao
monitor-tick`。要周期检测，请手动加到 host crontab：

```cron
*/5 * * * * /home/admin/.npm-global/bin/openclaw mao monitor-tick >/dev/null 2>&1
```

---

## 典型工作流

### A. 全自动（小修小补）

```bash
# bugfix 默认不需 review，跑完直接 completed
openclaw mao dispatch --type bugfix --description "修 src/foo.ts:42 的空指针 bug"

# 看进度
openclaw mao dashboard

# 接受到 baseBranch
openclaw mao merge <task-id>
```

### B. 半自动（plan-doc / 大 feature / refactor）

```bash
# 派任务但不 spawn LLM
openclaw mao dispatch --type plan-doc --manual \
  --description "为 antalpha-agent 加可热加载的 skill 系统 MVP"

# mao 输出 3 步指南：
#   Step 1: ssh -t admin@vps "cd <worktree> && opencode"
#   Step 2: TAB 切到 Prometheus（Plan Builder）
#   Step 3: 粘贴预设的 prompt（按 type 派生不同模板）

# 你在 tui 里完成工作 → commit + push

# 5 分钟内 monitor 自动检测完成；不想等：
openclaw mao monitor-tick

# 进 reviewing 后：
openclaw mao review-bundle <task-id>
openclaw mao review-result <task-id> --verdict pass --feedback "ok"
openclaw mao merge <task-id>
```

### C. 状态机卡住强制接受

```bash
# 任务 state=failed 但你看了 diff 觉得 OK
openclaw mao accept <task-id>
# 等价于强制 ff-merge + push + cleanup，绕过 sub_status 检查（cancelled 仍 hard-block）
```

---

## 架构

```
extensions/openclaw-mao/
├── openclaw.plugin.json     # manifest：id / commandAliases / contracts.tools / configSchema
├── index.ts                 # definePluginEntry — 注册 CLI + 16 个子命令
├── tracker.ts               # sqlite schema + CRUD（better-sqlite3 + WAL + schema 迁移 v5）
├── sqlite-resilience.ts     # WAL/busy_timeout pragma + 版本化迁移
├── dispatcher.ts            # 状态机驱动：dispatch → running（多 turn 循环）→ verifying → pushed → reviewing/completed
├── prompt-templates.ts      # 半自动模式 prompt 模板（按 type 派生）
├── worktree.ts              # `git worktree add/remove` + branch 处理
├── verifier.ts              # 三项 git 校验（status clean / pushed / on origin）；verifyMode=skip|git
├── parser.ts                # 结构化前缀解析 `TASK:<type> | <desc> | priority:... | branch:... | plan-doc:... | parent:<id>`
├── plan-gate.ts             # refactor 关键词 + type=refactor 时强制要求 --plan-doc
├── chain.ts                 # parentTaskId 的 BLOCKED 状态 / 环检测 / 级联 unblock 或 cancel
├── reviewer-bridge.ts       # review bundle 组装 + verdict 写库 + retry 预算
├── merger.ts                # ff-only merge + push + best-effort `npm test` + cleanup（支持 --force）
├── monitor.ts               # tick：扫 stuck + 半自动完成检测 + retention 清理 + 磁盘占用
├── notifier.ts              # 通过 `openclaw message send` 发 Discord（未配则 silent）
├── dashboard.ts             # 人类可读表格渲染
├── prune.ts                 # 孤儿 worktree + branch 扫描/清理
└── setup.ts                 # 验证 kimi/opencode CLI 二进制可达（不再注册 OpenClaw 内部 agent）
```

### 业务子状态机

```
                       ┌──────────┐
                       │ BLOCKED  │  等父任务
                       └────┬─────┘
                            │ 父 pushed/completed
                            ▼
              ┌──────────┐      ┌──────────┐
       ┌──── │ PENDING  │ ◄──── │   排队   │  （活跃 >= concurrencyLimit）
       │     └────┬─────┘
       │          ▼
       │     ┌──────────┐
       │     │ DISPATCH │  创建 worktree
       │     └────┬─────┘
       │          │
       │          ├──── auto 模式 ──┐
       │          │                ▼
       │          │           ┌──────────┐
       │          │           │ RUNNING  │ ◄── 多 turn 循环（DONE/CLARIFY/超时/max-turns）
       │          │           └────┬─────┘
       │          │                │ DONE
       │          │                ▼
       │          │           ┌────────────┐    CLARIFY    ┌──────────────────────────┐
       │          │           │ VERIFYING  │ ───────────► │ AWAITING_CLARIFICATION   │
       │          │           └─────┬──────┘               └────────────┬─────────────┘
       │          │                                                     │ mao continue
       │          │                                                     ▼
       │          │                                              （回到 RUNNING）
       │          │
       │          └── manual 模式 ──► AWAITING_HUMAN_WORK
       │                                  │ 你在 tui 里 git push
       │                                  │ monitor 5 min 检测到完成
       │                                  ▼
       │                              VERIFYING
       │                                  │ pass
       │                                  ▼
       │                             ┌──────────┐
       │                             │  PUSHED  │
       │                             └────┬─────┘
       │                                  │
       │       ┌── 不需 review (bugfix) → COMPLETED
       │       │
       │       └── 需 review ──► REVIEWING
       │                              ├─ pass → COMPLETED
       │                              ├─ fail (1 次 retry) → RUNNING (resume)
       │                              └─ needs-clarification → FAILED
       ▼
   终态：COMPLETED / FAILED / CANCELLED
   `mao merge` 要求 completed 或 pushed；`mao accept` 可绕过（cancelled 除外）。
```

---

## 配置参考

所有键在 `plugins.entries.openclaw-mao.config` 下：

| 键 | 默认 | 用途 |
|----|------|------|
| `concurrencyLimit` | `3` | 同时跑的活跃任务上限（BLOCKED 不计） |
| `branchPrefix` | `agent` | 自动生成 branch 名的前缀 |
| `workspaceRoot` | `~/.openclaw/workspace` | mao 在里面建 worktree 的 git 仓库根（自动展开 `~`） |
| `baseBranch` | `main` | 切 worktree 的基准分支 + merge 的目标分支。推荐用专门分支（如 `mao-main`），不动你的 main |
| `verifyMode` | `git` | `git` = 跑三项校验；`skip` = 跳过（仅 dev 用） |
| `timeouts.bugfix/feature/refactor/planDoc` | `15/60/120/30` 分钟 | 各 type runtime 上限 |
| `highPriorityMultiplier` | `1.5` | `priority=high` 时 timeout 乘这个系数 |
| `verifyingTimeoutMin` | `5` | verifying 状态超时（自动 fail） |
| `stuckHeartbeatMin` | `30` | running 超过 N 分钟视为 stuck → failed |
| `worktreeRetentionHours` | `24` | 终态任务的 worktree 保留多久（让你能进 tui resume），超期 monitor 自动清。0 = 不保留立即清 |
| `planGateKeywords` | `["重构","迁移","替换","refactor","migrate","replace","框架替换"]` | description 含这些关键词必须带 `--plan-doc` |
| `reviewRequiredTypes` | `["feature","refactor","plan-doc"]` | 默认 `review_required=true` 的 type |
| `retry.running/review/verifying` | `3/1/0` | 各阶段 retry 预算 |
| `discordChannel` | (未设) | Discord 通知 channel id；未设 = silent |
| `diskAlertGiB` | `5` | worktrees 目录总字节超过此值触发 Discord 告警；0 = 禁用 |
| `agentBinaries.kimi / .opencode` | `kimi` / `opencode` | 覆盖外部 CLI 二进制路径（默认靠 PATH 解析） |

---

## 已知踩坑

完整列表见 [`ONBOARDING.zh-CN.md`](ONBOARDING.zh-CN.md)。最常见两个：

- **OpenClaw 冷启动 ≈ 14 秒**。测试脚本 timeout ≥ 30s；`mao setup` 因为要跑多次 host CLI，
  约 60s。
- **`register(api)` 内绝不可调 `spawnSync`**。spawn 子 `openclaw` 进程会让插件再加载一次并
  再 spawn —— 无限 fork 死循环。所有 host-CLI 调用必须在 subcommand `.action()` 回调内
  （只在 CLI 被触发时跑）。这就是为什么 `mao setup` 是个子命令而不是 `onInstall` hook
  （SDK 本来也没这个 hook）。

---

## 许可

MIT（见 `LICENSE`）。
