# openclaw-mao 上手指南

> 🌐 **Language**: [English](ONBOARDING.md) · **简体中文**

最少摩擦的安装、配置、日常使用指南——适合在一台全新 OpenClaw 主机上从零跑起来。
回头来翻文档的话，直接跳到 [日常使用](#5-日常使用)。

---

## 1. 前置依赖

- **OpenClaw** ≥ 2026.4.24（`openclaw --version` 验证）。本插件用了 `definePluginEntry` SDK
  接口和 `--dangerously-force-unsafe-install` 选项，都从该版本起才有。
- **Node.js** ≥ 20（`better-sqlite3` 预编译二进制要求）。验证：`node --version`。
- **Git** ≥ 2.20 且支持 `worktree`。验证：`git worktree --help`。
- **`kimi` 和 `opencode` CLI** 已在 VPS 上装好。验证：
  ```bash
  kimi --version
  opencode --version
  ```
- **一个 git 工作仓库** —— mao 会在里面创建 worktree。它必须：
  - 有 `main` 分支（或你配的 `baseBranch`）
  - 有 `origin` remote（`verifyMode=git` 必需）
  - 对运行 OpenClaw gateway 的用户可写
  - dev/e2e 用途：一个 bare 本地 repo + 一个 clone 就够，见
    [搭测试 workspace](#搭一个测试-workspace仅-dev)。

---

## 2. 安装

```bash
# 1. clone 到 OpenClaw extensions 目录（或任意路径都行，关键是后面 install 指对）
git clone <repo-url> ~/.openclaw/extensions/openclaw-mao
cd ~/.openclaw/extensions/openclaw-mao

# 2. 装依赖 + build
npm install                           # ~10s
npm run build                         # tsup → dist/index.js (~80KB)

# 3. 注册到 OpenClaw
openclaw plugins install ~/.openclaw/extensions/openclaw-mao/ \
  --force --dangerously-force-unsafe-install

# 4. 重启 gateway 让插件加载
systemctl --user restart openclaw-gateway.service     # USER 级 systemd，不是 system
sleep 4 && systemctl --user is-active openclaw-gateway.service     # 应该输出：active

# 5. 验证
openclaw mao --help                   # 应列出 16 个子命令
openclaw plugins doctor               # mao 应该出现且无 diagnostic
```

> ❗ `--dangerously-force-unsafe-install` flag **必须**加。mao 通过 `child_process` spawn
> `kimi` / `opencode` / `git` / `openclaw message send`，OpenClaw 插件加载器会静态扫描这些
> 调用。不加 flag 就会被拒绝加载。这是 OpenClaw 的有意设计——你需要明确声明信任这个插件
> 的源码。如果你需要审计，看 `dispatcher.ts` / `setup.ts` / `merger.ts` / `notifier.ts`。

---

## 3. 配置

配置在 `~/.openclaw/openclaw.json` 的 `plugins.entries.openclaw-mao.config` 下。用
`openclaw config set` 设置：

```bash
# 必须：工作仓库根目录
openclaw config set plugins.entries.openclaw-mao.config.workspaceRoot /path/to/your/repo

# 强烈推荐：用专门的 long-term branch（不动你日常的 main）
openclaw config set plugins.entries.openclaw-mao.config.baseBranch mao-main

# 推荐：开真实 git 校验（dev 测试时可用 skip）
openclaw config set plugins.entries.openclaw-mao.config.verifyMode git

# 可选：Discord 通知
openclaw config set plugins.entries.openclaw-mao.config.discordChannel <你的-channel-id>

# 可选：并发上限
openclaw config set plugins.entries.openclaw-mao.config.concurrencyLimit 3

# 让插件重新读 config
systemctl --user restart openclaw-gateway.service
```

完整配置键列表 + 默认值：见 `README.zh-CN.md` → "配置参考"。

### 搭一个测试 workspace（仅 dev）

```bash
mkdir -p /tmp/mao-test-origin.git && (cd /tmp/mao-test-origin.git && git init --bare -b main)
cd /tmp && git clone /tmp/mao-test-origin.git mao-test-workspace
cd mao-test-workspace
git config user.email mao-e2e@local && git config user.name mao-e2e
echo "# test workspace" > README.md
git add . && git commit -m "init" && git push -u origin main

# 让 mao 指向它 + 跳过 verify（测试时没真实 origin push）
openclaw config set plugins.entries.openclaw-mao.config.workspaceRoot /tmp/mao-test-workspace
openclaw config set plugins.entries.openclaw-mao.config.verifyMode skip
systemctl --user restart openclaw-gateway.service
```

### 关于 antalpha-agent .gitignore

如果 mao 的 baseBranch 是 antalpha-agent 内的分支，给 `.gitignore` 加上几行屏蔽
sisyphus / opencode runtime 副作用，避免 mao verifier false-failed：

```bash
cat >> /path/to/antalpha-agent/.gitignore <<'EOF'

# mao plugin / opencode-sisyphus / kimi-cli runtime side-effects
.sisyphus/
.opencode/cache/
worktrees/
EOF

cd /path/to/antalpha-agent
git add .gitignore && git commit -m "chore: ignore mao/sisyphus/opencode runtime artifacts"
git push origin <你的-baseBranch>
```

---

## 4. 一次性 setup

```bash
openclaw mao setup
```

这一步：
1. 验证外部 CLI `kimi` 和 `opencode` 在 PATH 上可达，且 `--version` 有响应
   （PATH 在 spawn 时会自动补 `/home/admin/.local/bin:/home/admin/.npm-global/bin`）。
2. **Cron 目前会跳过**，原因明确：OpenClaw 的 cron 只支持 `--agent --message` 调度，不支持
   `openclaw mao monitor-tick` 这种 raw shell command。要周期检测 stuck 任务和半自动完成，
   请手动加到 host crontab：

   ```cron
   */5 * * * * /home/admin/.npm-global/bin/openclaw mao monitor-tick >/dev/null 2>&1
   ```

验证：
```bash
openclaw mao setup                    # cli.ok=true 和 cron.skipped=true
kimi --version                        # 确认 Kimi Code CLI 可用
opencode --version                    # 确认 OpenCode CLI 可用
```

---

## 5. 日常使用

### 5.0 推荐工作流：以 Claude Code 为主编排师

**人类不直接写 ssh 命令派任务。** 设计上的主要使用模式：

| 角色 | 做什么 |
|------|--------|
| **你** | 在 Claude Code 会话里用自然语言说「想做 X」 |
| **Claude Code** | 按 `~/.claude/CLAUDE.md` 的 ask-first gate 规则自动判断 `type` / `assignee` / `review_required`，组装完整 dispatch 命令，输出一行摘要：<br>「准备派 `<type>` 任务给 `<assignee>`：`<one-line description>`，review_required=`<y\|n>`，plan-doc=`<path\|none>`。**OK 就 y，改要改我。**」 |
| **你** | 回 `y/yes/确认`，或回应调整 |
| **Claude Code** | 用 Bash tool 通过 ssh 派 mao，记下 task_id 给你 |
| **你** | 问「任务咋样？」 |
| **Claude Code** | 主动跑 `mao dashboard` / `mao status` 给摘要 |
| **任务进 `reviewing`** | Claude Code **主动**拉 `mao review-bundle` → 给契约审查 verdict 建议（pass / fail / needs-clarification + 理由） |
| **你** | 确认 verdict |
| **Claude Code** | 跑 `mao review-result --verdict ...`，然后问「merge 吗？」 |
| **你** | y / n |
| **Claude Code** | 跑 `mao merge` 或留着 |

**人类的真实工作 = 用自然语言描述目标 + 在 ask-first 摘要时 y/n + 关键 review 决策。**
不需要记 task_id、ssh 命令、子命令 flag。

下面 §5.1 - §5.8 列的直接 CLI 命令是**底层接口**——主要用于：

- 开发 / 调试 / 排查 mao 自身 bug
- Claude Code 不可用时的手动 fallback
- 一次性运维操作（清磁盘、看历史 task）

### 5.1 派任务（全自动模式）

```bash
# flag 形式
openclaw mao dispatch --type feature --description "加 /v2/users/search endpoint，带 rate-limit" --priority high

# 或者用结构化前缀（适合 orchestrator agent 自动派）
openclaw mao dispatch --prefix "TASK:feature | 加 /v2/users/search endpoint | priority:high"
```

前缀支持 `priority:` / `branch:` / `plan-doc:` / `parent:` / `review:1`。不真派只解析：

```bash
openclaw mao parse "TASK:refactor | 抽 auth 到独立模块 | priority:high | plan-doc:docs/auth-refactor.md"
```

### 5.2 派任务（半自动模式，**v0.2.1 新增**）

> 适合 plan-doc、大 feature、refactor 等你想自己用 prometheus / hephaestus 等 sub-agent 的场景。
> mao **不 spawn LLM**，只准备 worktree + 给你 3 步 ssh 指南，你自己进 tui 工作。

```bash
openclaw mao dispatch --type plan-doc --manual \
  --description "为 antalpha-agent 加可热加载的 skill 系统 MVP"
```

mao 输出长这样：

```
✓ Task task-XXX tracked (sub_status=awaiting_human_work, mode=manual)
✓ Worktree:  /path/to/repo/worktrees/opencode-task-XXX
✓ Branch:    agent/opencode/task-XXX (forked from mao-main)

────── Step 1: Open opencode/kimi tui ──────

  ssh -t admin@vps "cd /path/to/.../worktrees/opencode-task-XXX && opencode"

────── Step 2: Switch agent profile ──────

  Prometheus (Plan Builder — K2.6, 4000-step coordination)
  Inside opencode tui, press TAB to switch the active agent profile.

────── Step 3: Paste this prompt ──────

  [MAO TASK task-XXX]
  Type: plan-doc
  ...预设好的 prompt（按 type 派生：plan-doc / feature / refactor / bugfix / review 五种）...

────── Step 4: When agent finishes ──────

  mao monitor will auto-detect within 5 min and move task to verifying.
  To trigger immediately on host:
     openclaw mao monitor-tick
```

各 type 推荐的 sub-agent：

| type | 推荐 TAB 切到 |
|------|---------------|
| `bugfix` | `kimi`（无需 TAB，kimi 用 `~/.kimi/AGENTS.md` 作为工作守则） |
| `feature` | **Hephaestus**（代码生成 SOTA，GLM-5.1） |
| `refactor` | **Deep**（长任务自主，8h continuous，GLM-5.1） |
| `plan-doc` | **Prometheus**（Plan Builder，K2.6） |
| `review` | **Momus**（质量审查，Qwen3.6+） |

你在 tui 里完成工作并 `git push` 后：

```bash
# 5 分钟内 monitor 自动检测；不想等：
openclaw mao monitor-tick
```

任务自动转 `reviewing`（如果 `review_required=true`）或 `completed`。

### 5.3 查看进度

```bash
openclaw mao dashboard                # 只看活跃任务（表格）
openclaw mao dashboard --all          # 含终态
openclaw mao dashboard --agent kimi --json
openclaw mao status <task-id>         # 完整 sqlite 行 + 自动生成的 resume_command 字段
```

dashboard 的 `resume` 列读法：
- `tui-ready` —— worktree 在 + session id 已记录，能直接进 tui resume
- `wt-only` —— worktree 在但还没 session id（manual 任务还没真进过 tui）
- `-` —— worktree 已被 prune，无法 resume

### 5.4 进 tui resume session（**v0.2.1 新增**）

```bash
openclaw mao open <task-id>
```

输出一行 ssh -t 命令，复制粘贴即可进 tui 继续该 session 的对话。worktree 已被 prune 时
会告诉你；session_id 缺失时 fallback 用 `-c`（continue cwd 上一个）。

### 5.5 Review（任务进入 `reviewing` 时）

```bash
openclaw mao review-bundle <task-id>  # → JSON：task row + git diff + plan-doc + agent result + 契约检查 hint
# 看完后选一个：
openclaw mao review-result <task-id> --verdict pass --feedback "shipped"
openclaw mao review-result <task-id> --verdict fail --feedback "缺输入校验，加个 Joi schema"
openclaw mao review-result <task-id> --verdict needs-clarification --feedback "你说的 edge-case A 具体是什么？"
```

`fail` 且还有 retry 预算 → 自动 resume turn，把 feedback 前置给 agent；agent 可能
回 `DONE:`（回 `reviewing`）或 `CLARIFY:`（进 `awaiting_clarification`）。后者
用 `mao continue <id> --message "..."` 答复。

### 5.6 Merge

```bash
openclaw mao merge <task-id> --dry-run    # 只显 diff stat + commit 列表，不真合
openclaw mao merge <task-id>              # ff-only + push + cleanup worktree+branch
openclaw mao merge <task-id> --no-cleanup # 合并但保留 worktree+branch
```

worktree 里有 `package.json` 时会尝试跑 `npm test`（60s timeout）。CI 失败会中止 merge。

### 5.7 强制接受（**v0.2.1 新增**）

`mao merge` 要求 `sub_status` 是 `completed` 或 `pushed`。状态机卡在 `failed` /
`reviewing` / `awaiting_*` 时但你已经亲自看过 diff 觉得 OK：

```bash
openclaw mao accept <task-id>
```

绕过状态检查直接 ff-merge + push + cleanup。**唯一硬限制**：`cancelled` 任务不能 accept。

### 5.8 housekeeping

```bash
openclaw mao monitor-tick             # 一次性扫；cron 也每 5min 跑一次
openclaw mao prune                    # dry-run：列孤儿 worktree + branch
openclaw mao prune --apply            # 真删
openclaw mao cancel <task-id>         # 取消活跃任务
openclaw mao cleanup <task-id>        # 删 worktree+branch（仅终态任务）
```

---

## 6. 已知踩坑

这些是 Phase 0–5 + v0.2.0/v0.2.1 开发中踩出来的坑，遇到反常先查这里。

### 冷启动延迟

- `openclaw <任何命令>` 首次调用约 14 秒（插件加载）。所有测试脚本 timeout 设 ≥ 30s。
  `mao setup` 因为要 spawn 多个 host CLI，约 60s。

### `register(api)` 纪律

- **绝不可在 `register(api)` 内调 `spawnSync`（或任何阻塞操作）**。OpenClaw 在进程内
  加载插件；如果 `register` spawn 一个子 `openclaw` 进程，它会再次加载本插件并递归
  spawn 下去——**无限 fork**。所有 host-CLI 调用必须在 subcommand `.action()` 回调内
  （只在 CLI 被显式调用时跑）。这就是为什么 `mao setup` 是个子命令而不是 `onInstall`
  hook（OpenClaw SDK 本来也没这个 hook）。

### `descriptors` 必填

- `api.registerCli(handler, { descriptors: [{ name, description, hasSubcommands }] })`
  —— 第二个参数必传。不传 `descriptors` 的话，handler 会被静默跳过，`mao` 命令变成
  "unknown command"。诊断：`openclaw plugins doctor` 会报 `cli registration missing
  explicit commands metadata`。mem0 插件用的是旧版 SDK 有 back-compat 路径不用传，新
  插件必须传。

### `agents add` 真实 flag 集

- `openclaw agents add` 接受 `--non-interactive --workspace --model`（还有 `--bind`
  和 `--agent-dir`）。**不**接受 `--description`。要设描述用 `openclaw agents
  set-identity`。

### session-id 不能含冒号

- `openclaw agent --session-id <id>` 拒绝冒号。用 `mao-<task-id>`，不要 `mao:<task-id>`。
  症状：`Invalid session ID`。

### `openclaw agent` 没有 `--cwd`

- `openclaw agent --help` 不列 `--cwd`。mao 的 dispatcher 通过 `child_process` 的
  `cwd:` 选项设置 worktree 路径，子 OpenClaw 进程会继承。出现 "agent 在错误目录跑"
  时就是这个。

### TaskFlow 不会自动创建

- `openclaw agent --message ...` **不**自动创建 OpenClaw TaskFlow 行。mao 任务完全活
  在插件自有 sqlite（`data/tasks.db`）里；它们**不**会出现在 `openclaw tasks list
  --runtime subagent`。设计文档里的状态映射表只是 reference。

### systemd unit 是 USER 级

- gateway 跑在 `systemctl --user`，不是 system 级。`sudo systemctl restart
  openclaw-gateway.service` 会报 "Unit not found"。老 mem0 记忆可能建议 PM2 或
  `sudo`——都是错的。

### TS dts build 在 `strict: false` 下的坑

- `tsup --dts` 即便 `strict: false` 也拒绝 discriminated-union narrowing
  （`{ok:true; X} | {ok:false; error}`）。用扁平 optional 字段
  （`{ok:boolean; X?; error?}`）。build 会在 `--dts` 阶段报错，不是 `--esm`。

### CLI 冷启动主导短测试

- 不要在一个 shell 里同步跑 `mao dispatch` 然后 poll `mao status` —— dispatch CLI
  要等 agent turn 结束（28s+）才返回。涉及 `BLOCKED` 的竞态测试要用后台 dispatch，
  或者直接用 `better-sqlite3` 灌测试数据。

### `openclaw plugins inspect` 关于命令的报告会撒谎

- `Commands: mao` 在 `plugins inspect` 输出里即便 handler 从没跑过也会显示（例如
  `descriptors` 缺失时）。请用 `openclaw mao --help` 交叉验证命令是否真的注册上了。

### memory-lancedb 警告刷屏

- 看到一个长长的"plugin not installed: memory-lancedb" warning box 每次都出现：
  ```bash
  openclaw config unset plugins.entries.memory-lancedb
  systemctl --user restart openclaw-gateway.service
  ```
  注意是 `unset` 不是 `disable` —— disable 只是把 `enabled` 设 false，entry 还在，
  OpenClaw 仍当成"声明过但没装"报警告。`unset` 才彻底删 entry。

### 非交互 ssh 找不到 `openclaw`

- `ssh admin@vps 'openclaw mao dashboard'` 报 `command not found`，因为 ssh 非交互
  shell 不读 `~/.bashrc`，PATH 里没 `/home/admin/.npm-global/bin`。解决：用绝对路径
  `ssh admin@vps '/home/admin/.npm-global/bin/openclaw mao dashboard'`。`ssh -t`
  交互式不受影响（`mao open` 输出的命令带 `-t`，所以没问题）。

---

## 7. 故障排查

| 症状 | 可能原因 | 修法 |
|------|---------|------|
| `openclaw mao` → "unknown command" | 插件没加载。gateway 没重启，或 `descriptors` 缺失 | `systemctl --user restart openclaw-gateway.service`；查 `plugins doctor` |
| `mao setup` 报 `unknown option '--description'` | OpenClaw 版本太老 | 升级 OpenClaw ≥ 2026.4.24，或改 `setup.ts` 对齐你的 `agents add` flag |
| `sub_status` 卡在 `running` 很久不动 | agent 在 loop 或没回 DONE/CLARIFY 前缀 | 等 `stuckHeartbeatMin` 触发，或 `mao cancel <id>` |
| 半自动任务一直 `awaiting_human_work` | 你没进 tui 工作 / 工作了但没 push | 进 tui 完成 + push；或 `mao monitor-tick` 立即检测 |
| `mao merge` 报 `commits_not_pushed` | 工作树有未 push 的 commit（verifier 早该拦） | 检查 `verifyMode`；生产用 `git` 不要 `skip` |
| Discord 通知没收到 | `discordChannel` 未配，或 `openclaw message send --channel discord` 没配通 | `openclaw config set plugins.entries.openclaw-mao.config.discordChannel <id>`；`openclaw channels list` 看 discord 在不在 |
| `mao dispatch` 瞬间失败 "plan-mode gate triggered" | description 命中 `planGateKeywords` 或 `type=refactor` 但没带 `--plan-doc` | 加 `--plan-doc <path>` 或重写 description |
| 任务进 `awaiting_clarification` | agent 在 tui 里回了 `CLARIFY: ...`，状态机停下等你 | `mao continue <id> --message "<回应>"` |
| dashboard `resume` 列显示 `-` | worktree 已被 prune（>retentionHours） | 任务终态结果在 git history（branch 已 merged）；要继续就开新任务 |
| `opencode session list` 在 home dir 看不到 mao 派的 session | opencode session 按 cwd 过滤 | 用 `mao open <task-id>` 自动 cd，或 `cd <worktree>` 后再跑 |

---

## 8. 代码定位

| 想知道 | 看哪个文件 |
|--------|-----------|
| 任务 row schema？ | `tracker.ts` — `TaskRow` interface + `SCHEMA` |
| 多 turn 循环怎么工作？ | `dispatcher.ts` — `runTurnLoop` + `handleTurnOutcome` |
| 半自动模式怎么准备 prompt？ | `prompt-templates.ts` — `buildManualPlan` |
| `verifyMode=git` 实际查啥？ | `verifier.ts` — `Verifier.verify`（status / rev-list / ls-remote） |
| 链式任务怎么走？ | `chain.ts` — `shouldBlockOnInsert` / `validateAncestry` / `afterParentTerminal` |
| review bundle 里有啥？ | `reviewer-bridge.ts` — `prepareBundle` |
| monitor 扫什么？ | `monitor.ts` — `Monitor.tick`（stuck / 半自动完成 / retention / 磁盘） |
| session id 怎么抓取？ | `dispatcher.ts` — `extractSessionId`（kimi 用 stdout regex，opencode 用 `session list --json`） |
| prune 怎么识别孤儿？ | `prune.ts` — `Pruner.prune` |
| 一个 plugin 命令怎么注册？ | `index.ts` — `api.registerCli(({program}) => ..., { descriptors: [...] })` |

---

## 9. 升级

```bash
cd ~/.openclaw/extensions/openclaw-mao
git pull
npm install                    # 只在 package.json 改了才需要
npm run build
openclaw plugins install ~/.openclaw/extensions/openclaw-mao/ --force --dangerously-force-unsafe-install
systemctl --user restart openclaw-gateway.service
```

schema 版本升了的话（看 `tracker.ts:SCHEMA` 是否多了新 entry），插件首次加载时自动跑
迁移。已有的 sqlite 行不会丢。

---

## 10. 卸载

```bash
openclaw plugins uninstall openclaw-mao
systemctl --user restart openclaw-gateway.service

# 清理状态（sqlite 任务库 + worktree，如果你不想留）
rm -rf ~/.openclaw/extensions/openclaw-mao/data

# workspaceRoot 下的 worktree 和 branch 还在
# 卸载后 `mao prune --apply` 没了，用 git 手清：
cd $WORKSPACE_ROOT && git worktree list | awk '/^.*\/worktrees\//{print $1}' | xargs -I{} git worktree remove --force {}
git branch | grep '^  agent/' | awk '{print $1}' | xargs git branch -D
```
