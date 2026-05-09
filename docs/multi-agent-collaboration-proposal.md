# Multi-Agent 协作方案: OpenClaw plugin `openclaw-mao`

**版本**: v2.2-r9
**日期**: 2026-05-09
**作者**: 0xBevan
**v2 评审协作**: Claude Code（基于 antalpha-agent 历史踩坑沉淀）
**状态**: §9 七条决议已收口；**Phase 0-5 全部完工**；14 子命令零 stub；e2e 闭环验证（dispatch → reviewing → review-result fail → CLARIFY → continue → reviewing → pass → merge → cleanup → prune）

---

## Changelog

### v2.2-r9 (2026-05-09 17:30, Phase 5 完工 — Phase 0-5 全收口)

最后一个 phase。`mao dashboard` 表格 + `mao prune --dry-run/--apply` 孤儿清理 + monitor 磁盘告警全部 e2e 通过。**14 子命令零 stub。**

| 改动 | 触发 |
|------|------|
| 新增 `dashboard.ts`：`Dashboard.render({ showAll, filterAgent, filterType })` 输出表格视图（task short-id / type / pri / agent / sub_status / age / retry / branch）；`mao dashboard` 默认仅活跃，`--all` 含终态，`--json` 切换；`--agent` / `--type` 过滤 | §5.1 统一 dashboard |
| 新增 `prune.ts`：`Pruner.prune({ workspaceRoot, dryRun })` 扫 `worktrees/<dir>` 名格式 + sqlite 对照；扫 `git branch agent/*` 同样对照；不存在 task 或 terminal task 列为 orphan；`--apply` 真删（git worktree remove + branch -D） | §5.3 孤儿清理 |
| `mao prune` CLI（默认 dry-run，`--apply` 真删）；`prune.ts` 修一处 git branch 输出 `+` 前缀 strip（worktree-attached 标识） | 实测发现的格式 bug |
| `Monitor.tick` 加磁盘检查：`du -sb workspaceRoot/worktrees` 拿字节数 → 超 `diskAlertGiB`（默认 5）阈值发 Discord 告警；MonitorResult 加 `disk: {worktrees_bytes, threshold_bytes, alert}` 字段 | §5.3 磁盘监控 |
| manifest configSchema 加 `diskAlertGiB`（数字，默认 5；0 禁用） | 配置入口 |
| Phase 5 e2e：(1) `mao dashboard --all` 显示 12 历史 task 漂亮表格；(2) `mao prune` dry-run 找到 7 孤儿 branch；(3) `mao prune --apply` 7 个全删，git 只剩 main；(4) `mao monitor-tick` 返回 disk 字段 alert=false（worktrees 747 bytes < 5GiB） | 全闭环 |
| **子命令计数：14 全 real**：setup / parse / dispatch / continue / status / list / cancel / cleanup / review-bundle / review-result / merge / monitor-tick / **dashboard** / **prune** | Phase 5 落地 |

### v2.2 全周期总结（Phase 0-5 全部完工）

| Phase | 时间投入 | 主要交付 |
|-------|---------|---------|
| 0 | 0.5 天 | API 探针 + plugin 骨架 + descriptors 关键发现 |
| 1 | 0.5 天 | sqlite tracker + 5 真实 CLI + 单 turn dispatch |
| 2 | 0.5 天 | worktree + verifier + 多 turn + cancel/cleanup |
| 2.5 | 0.5 天 | parser + plan-gate + chain |
| 3 | 0.5 天 | reviewer-bridge + REVIEWING + retry |
| 3.5 | 0.25 天 | awaiting_clarification + mao continue（修 r6 gap） |
| 4 | 0.5 天 | merge + monitor + cron + Discord |
| 5 | 0.25 天 | dashboard + prune + 磁盘告警 |
| **总计** | **3.5 天** | **14 真实 CLI 子命令，零 stub，e2e 全闭环验证** |

实际 vs v2.2-r2 §6 估时（7-9 天）：**节省 ~50%**——主要因为 mem0 plugin 当作骨架模板让 Phase 0 仅花半天，而非从零写 manifest/build chain。

### 仍开放（v3 设计目标）

- 完整 DAG（fan-out/fan-in，超线性链）
- Auto-merge + CI 全绿
- pseudo-subgraph contract checker（review verdict 之外的强约束）
- compact 后自动 reload SKILL.md
- 多 reviewer（Claude Code + OpenCode + KimiCode 多视角 review）

### v2.2-r8 (2026-05-09 16:45, Phase 4 实装 merge + monitor + Discord)

`mao merge` / `mao monitor-tick` 真命令上线，剩余 stub 全清。Discord 告警挂在 dispatcher 终态点 + reviewing 进入点。

| 改动 | 触发 |
|------|------|
| 新增 `notifier.ts`：`Notifier.sendDiscord(api, msg)` 走 `openclaw message send --channel discord --target <id>`；config.discordChannel 未设 silent skip；spawnSync timeout 15s 防卡 | §3.1 Discord 通道实装 |
| 新增 `merger.ts`：`Merger.merge(api, taskId, opts)` git fetch+checkout+pull --ff-only+merge --ff-only+push 全链；`--dry-run` 仅显 diff_stat/commits；`--no-cleanup` 保留 worktree；CI 检测 package.json 存在则尝试 `npm test` 60s timeout，失败 abort merge；成功后调 `Worktree.remove` + Discord notify | §3.4 merge 半自动 |
| 新增 `monitor.ts`：`Monitor.tick` 扫 running > stuckHeartbeatMin → failed (mapped to TaskFlow.lost) + Discord 告警；扫 verifying > verifyingTimeoutMin → failed + 告警；`Monitor.ensureCronRegistered` 用 `openclaw cron add --schedule "*/5 * * * *" --command "openclaw mao monitor-tick"` 幂等注册 cron job | §5.3 健康检查 |
| `mao monitor-tick` CLI：手动一次性触发 monitor 扫描；cron 也调同一命令 | 监控入口 |
| `mao setup` 加 `--skip-cron` 选项 + 自动调 `Monitor.ensureCronRegistered`；plugin install 后跑一次 setup 同时注册 agents 和 cron | setup 一站式 |
| dispatcher.afterTerminal 加 Notifier：sub_status=failed 时 Discord 告警；reviewing 进入点也告警提醒用户 review | 终态告警 |
| Phase 4 e2e：(1) `mao merge --dry-run` 返回 diff/commits；(2) `mao merge` real → ff-only push success + worktree+branch cleanup + Notifier silent skip（无 channel）；(3) `mao monitor-tick` 返回 `{ran_at, stuck_running, stuck_verifying, failed_count}` JSON 结构 | 主路径验证 |
| 子命令计数：12 全 real：setup / parse / dispatch / continue / status / list / cancel / cleanup / review-bundle / review-result / merge / monitor-tick | Phase 4 落地 |
| **known gap**：STUCK 阈值实测（running > 30min stuckHeartbeatMin）e2e 时间太长难真实触发，代码逻辑等价于已通过的查询+update 操作；真实长任务自然触发；Phase 5 加孤儿 worktree 扫描后一并实测 | known-gap |

### v2.2-r7 (2026-05-09 16:05, Phase 3.5 修 resume gap)

修复 v2.2-r6 暴露的 resume 单 turn 假设过死 + agent CLARIFY 直接 failed 的缺陷。新增 awaiting_clarification 子状态 + `mao continue` 子命令。

| 改动 | 触发 |
|------|------|
| sqlite v3 schema：ALTER TABLE 加 `clarify_question` 列；SubStatus 类型加 `awaiting_clarification`；`countActive` 把 awaiting_clarification 计入 active（占并发名额，因为内部状态尚未结束） | r6 暴露设计 gap |
| `runTurnLoop()` helper 抽出（dispatcher.run / resumeAfterReviewFail / Dispatcher.continue 共享一份多 turn + DONE/CLARIFY 检测逻辑） | 三处重复代码合一 |
| `handleTurnOutcome()` 集中状态转移：`done` → verifier → pushed → reviewing/completed；`clarify` → awaiting_clarification + 存 clarify_question；`timeout/agent_error/max_turns` → failed | 单点决策 |
| **CLARIFY 路径修复**：主路径 + resume 路径收到 agent CLARIFY 都进 `awaiting_clarification`（不再 failed），用户/orchestrator 用 `mao continue` 解锁 | r6 实测：vague feedback agent 合理回 CLARIFY 不该被惩罚 |
| `Dispatcher.continue(api, taskId, userMessage)`：把 user 回应注入同 session-id 多 turn 循环；同 handleTurnOutcome 路由 | awaiting → 解锁路径 |
| `mao continue <task-id> --message <text>` CLI 子命令：要求 task 当前 sub_status=awaiting_clarification | 暴露给用户 |
| Phase 3.5 e2e 全跑通：(1) review-result fail vague feedback → resume → CLARIFY → awaiting_clarification + clarify_question 入库；(2) `mao continue` 给具体回应 → multi-turn → DONE → reviewing；(3) review-result pass → completed (retry_review=1 真实保留) | 全闭环 |
| 子命令计数：11 个真实 + 1 stub（merge）：setup / parse / dispatch / continue / status / list / cancel / cleanup / review-bundle / review-result + merge stub | Phase 3.5 落地 |

### v2.2-r6 (2026-05-09 15:10, Phase 3 主路径跑通)

REVIEWING 状态从 PUSHED 拆出；`mao review-bundle` 输出完整 JSON（task row + git diff + plan-doc + agent_result + contract_checks 5 项 hint）；`mao review-result` pass/fail/needs-clarification 三态写库 + 状态机转移真实落地。

| 改动 | 触发 |
|------|------|
| 新增 `reviewer-bridge.ts`：`prepareBundle` 返回机器可读 JSON（含 git diff、plan-doc 文件内容、agent result_json parsed），`recordVerdict` 处理 pass/fail/needs-clarification 三态 + retry counter | §3.2.4 REVIEWING |
| sqlite v2 schema migration：ALTER TABLE 加 `review_verdict / review_feedback / reviewed_at` 三列；migrate() 自动跑 v1→v2 | Phase 3 字段需求 |
| dispatcher.run 拆 PUSHED/REVIEWING：verifier 通过 → PUSHED；review_required → REVIEWING (退出，等 review-result)；否则直接 COMPLETED | §4 状态机对齐 v2.2 |
| `Dispatcher.resumeAfterReviewFail`：review-result fail+retry budget → 回灌 feedback 起一轮新 agent turn → verifier → 回 reviewing 等再 review | §3.2.4 retry ≤ 1 |
| `mao review-bundle <id>` / `mao review-result <id> --verdict <v> --feedback <text>` 真实 CLI 落地（替换 stub） | §3.3 Claude Code 集成 |
| **CLI bug 修复**：`reviewRequired: !!opts.review` 把 undefined 强转 false 覆盖 type-based 默认 → 改为 `opts.review ? true : undefined` 让 dispatcher 用 `type !== "bugfix"` 默认 | dispatch 时 review_required 永远是 false 的 bug |
| e2e 验证：(1) feature 派 → reviewing；(2) review-bundle 输出完整 JSON；(3) review-result pass → sub_status=completed + 5 字段写库；(4) review-result fail → retry_review++ + sub_status=running；(5) resumeAfterReviewFail 真触发 spawn agent | Phase 3 主路径 |
| **暴露设计 gap**：resume 单 turn 假设过死。实测 agent 收到 "missing edge case A; please address" 这种 vague feedback 后**合理地**回 `CLARIFY: What is "edge case A"?`，但 resume 代码不接受 CLARIFY → 直接 failed。retry budget 未被有效利用。**Phase 3.5 修复**：resume 走多 turn 循环（与主路径一致），CLARIFY 时 sub_status=blocked 等用户回应而非直接 failed | 实测发现 |

### v2.2-r5 (2026-05-09 14:45, Phase 2.5 全跑通)

`mao parse` / `mao dispatch --prefix` / plan-gate / `--parent-task` 链式依赖全部 e2e 通过。

| 改动 | 触发 |
|------|------|
| 新增 `parser.ts`：`TASK:<type> \| <desc> \| priority:high \| branch:... \| plan-doc:... \| parent:<id>` 结构化前缀解析；未知 key 静默忽略保前向兼容 | §3.2.2 优先级 1 |
| 新增 `plan-gate.ts`：description 含 planGateKeywords OR type=refactor → 缺 `--plan-doc` 即拒派；configSchema.planGateKeywords 驱动 | §3.2.2 优先级 2 + §3.2.3 plan-mode gate |
| 新增 `chain.ts`：`shouldBlockOnInsert`（unknown_parent / parent_terminal_failed / parent_not_done）+ `validateAncestry`（cycle 检测 + MAX_CHAIN_DEPTH=5）+ `afterParentTerminal`（pushed/completed → unblock 直接子；failed/cancelled → 递归级联 cancel） | §3.2.4 链式 task |
| `mao parse <text...>` 子命令：纯函数 parser 输出 JSON，无副作用，方便 orchestrator agent + Claude Code 工具调用前 dry-run | 用户测试体验 |
| `mao dispatch --prefix "TASK:..."` 选项：与 `--type/--description` 二选一；--prefix 优先；其余 flag 可叠加（如 --plan-doc 不在 prefix 里时） | parser 落地 |
| `Dispatcher.create` 返回值改 `{ ok, row?, error? }`，处理三类入口失败：parser 错、plan-gate 拒、chain 拒 | API 收敛 |
| `Dispatcher.afterTerminal(api, row?)` 在 task 终态时调 `Chain.afterParentTerminal`，自动 BLOCKED→pending 或级联 cancel，下游再被 pull-pending 起跑 | 链式 unblock 机制 |
| **TS dts build 严格模式 quirk**：discriminated union (`{ok:true; X} \| {ok:false; error}`) 在 dts builder 里 narrowing 不工作，要改成 `{ok:boolean; X?; error?}` 统一字段；strict:false 下使用 optional 不报错 | 实测 dts build 失败 |
| e2e 三测：(1) refactor 缺 plan-doc 被 gate 拒（reason="type=refactor requires --plan-doc"）；(2) `mao parse "TASK:bugfix \| ... \| priority:high"` 正确解析；(3) `--prefix` 真派 → DONE → completed；(4) `--parent-task task-doesnotexist` 拒 + (5) `--parent-task <completed>` 子立即 pending→run→completed 且 parent_task 字段正确写库 | Phase 2.5 验收 |
| 业务子状态 BLOCKED 状态在 sqlite 实装；`chain.shouldBlockOnInsert(running parent)` 路径未 e2e（CLI 同步阻塞设计使单 shell 难测竞态），代码逻辑等价于已通过的 unknown/completed/failed 三态——留 Phase 3 review 链场景一并验 | known-gap |

### v2.2-r4 (2026-05-09 14:20, Phase 2 主体跑通)

`mao dispatch` 端到端走 pending → dispatch → running (multi-turn) → verifying → completed/cancelled，worktree 自动建/删，cancel/cleanup 真实落地。e2e 在 `/tmp/mao-test-workspace`（bare origin + clone）跑通。

| 改动 | 触发 |
|------|------|
| 新增 `worktree.ts`：`Worktree.create/remove`，git worktree add/branch 幂等 | Phase 2 §3.4 落地 |
| 新增 `verifier.ts`：三项 git 校验 + `verifyMode=skip` e2e bypass（manifest configSchema 加 `verifyMode: skip\|git`） | Phase 2 §4 VERIFYING |
| dispatcher 重写为业务子状态机驱动：dispatch (worktree create) → running (多 turn 循环 + DONE/CLARIFY 检测 + max turns + type 分级超时) → verifying → completed/pushed/failed | Phase 2 主体 |
| `extractFinalText`: 解析 `openclaw agent --json` 输出的 `result.meta.finalAssistantVisibleText` 字段，用于"DONE:"/"CLARIFY:"前缀判定 | 实测发现 agent --json 输出格式 |
| `cancel` / `cleanup` 真命令上线：cancel 把活动 task 标 cancelled + 触发 afterTerminal 拉 pending 队列；cleanup 调 Worktree.remove 删 worktree+branch | Phase 2 §3.4 cleanup |
| `Dispatcher.afterTerminal()`：每次 task 终态时检查 pending 队列，自动拉下一个 → 并发 semaphore 队列驱动 | §3.1.1 并发上限实装 |
| **plugin config 改运行时参数**：`openclaw config set plugins.entries.openclaw-mao.config.<key> <value>` + restart gateway，**不需重新 install** | 实测验证 |
| 业务子状态枚举与 v2.2-r2 §4 表对齐：pending/dispatch/running/verifying/pushed/completed/failed/cancelled | 实装 |

### v2.2-r3 (2026-05-09 14:05, Phase 1 day 2 e2e 跑通)

`openclaw mao dispatch --type bugfix --description "..."` 端到端跑通：plugin 写 sqlite → spawn `openclaw agent` → kimi-k2.5 单 turn 27.8s 返回 `DONE: hello from kimi` → sqlite sub_status=completed。`mao status` / `mao list` 从 sqlite 真实读。

| 改动 | 触发 |
|------|------|
| **§4 修正：mao 派的 task 不会自动进 OpenClaw TaskFlow**（`tasks list --runtime subagent` 实测看不到）。业务子状态机完全活在 plugin sqlite，TaskFlow.status 映射表降级为"参考"而非自动同步 | §11 ⚠️ 第 1 项实测 |
| **§3.5 入口范例硬约束：`register(api)` 内禁止任何 `spawnSync` / 阻塞的 host CLI 调用**（async 包不住内部同步阻塞，会卡 plugin 加载 14s+；最坏会被子 openclaw 进程递归 spawn 死循环） | mao 第一次 e2e 跑出来的死锁 |
| **新增 `mao setup` 子命令**：plugin install + restart gateway 后必须显式跑一次注册 3 个 agent。setup 不能放进 `register(api)` | 上一条的必然推论 |
| `agents add` 真实参数：`--non-interactive --workspace <dir> --model <id>`（**没有 `--description`**，要 description 用 `agents set-identity` 后续设） | 实测 `agents add --help` |
| **OpenClaw plugin install 静态扫描 child_process，必须用 `--dangerously-force-unsafe-install`**（mao 设计依赖 spawn host CLI，无替代路径；mem0 不踩雷因为它纯 SDK 调用） | install 时被 block |
| `openclaw-mao` plugin 是 USER 级 systemd 单元，重启用 `systemctl --user restart openclaw-gateway.service`，不是 `sudo systemctl restart` | 实测 |
| OpenClaw CLI cold start ≈14s（含 plugin loading），写测试脚本 timeout 必须 ≥30s | 实测 `time openclaw mao` = 14.1s |
| **session-id 不接受冒号**：`mao:<task-id>` 失败为 `Invalid session ID`，改为 `mao-<task-id>` | 实测 dispatcher 第一次 spawn agent 报错 |
| Phase 1 day 2 完成度：setup / dispatch / status / list 真实跑通；cancel / cleanup / merge / review-* 仍 stub（等 Phase 2-4） | day 2 目标范围 |

### v2.2-r2 (2026-05-09 13:00, Phase 0 plugin 骨架装上跑通)

VPS 上把 `extensions/openclaw-mao/` 骨架建起来，npm install + tsup build + `openclaw plugins install --force` + gateway restart 全跑通，**`openclaw mao --help` 列出 8 个 stub 子命令、`openclaw mao dispatch ... --json` 返回 `not_implemented` JSON**。Phase 0 完整收口。

| 改动 | 触发 |
|------|------|
| §3.5 入口范例 register() 增加 `api.registerCli(handler, { descriptors: [{name, description, hasSubcommands}] })` 第二参数 | Phase 0 实测：缺 descriptors 时 handler 永不被调用（loader 静默 skip） |
| §11 已验证表加 `descriptors` 一行 + 加 ⚠️ 注："`plugins inspect` 假报 `Commands: <name>` 即便缺 descriptors，需用 `plugins doctor` 才看到真相" | 同上，避免下个 plugin 再踩 |
| § 状态行：v2.2-r1 → v2.2-r2，状态从"探针完成"→"骨架跑通" | 实施进度 |
| 修正 systemd unit：`openclaw-gateway.service` 是 **user** 级 unit (`systemctl --user`)，不是 system 级 | 实测；mem0 记忆里的 PM2 / `sudo systemctl` 是错的 |

### v2.2-r1 (2026-05-09 12:30, Phase 0 探针完成)

Phase 0 跑完 OpenClaw 2026.5.7 全部子命令 `--help` 探针，把 §11 待验证表从"假设"压缩到"事实"：

| 改动 | 触发 |
|------|------|
| §11 重写为"已验证 ✅ / fallback ❌ / 待 SDK 文档 ⚠️"三段；8 项探针结果落地 | Phase 0 探针 |
| §3.4 dispatcher 引入 `openclaw agent --session-id` 简化为单 worker child_process + chdir，不再自驱多 turn 循环 | 探针发现 `--session-id` 已存在 |
| §3.4 加 `--cwd` fallback：每 task 独立 child_process worker、worker 内 chdir 后调 host CLI | 探针确认 `agent --cwd` 不支持 |
| 全文 `openclaw task list` → `openclaw tasks list`（OpenClaw 子命令是复数） | 探针纠错 |
| §11 "实施顺序"段标注 Phase 0 完成，Phase 1 入口改为 SDK `*.d.ts` 读取 + fork mem0 骨架 | 探针自然衔接 |

### v2.2 (2026-05-09)

把 v2.0/v2.1 在"OpenClaw 是空白通信层"的真空假设上做的设计，对齐到 OpenClaw 真实 API surface，落到 plugin SDK 上。**不是新功能层，是把同一个方案改成能在已有 OpenClaw 实例上真正跑起来的形态。**

| # | v2.1 假设 | v2.2 修正 | 依据 |
|---|----------|-----------|------|
| 1 | yaml 注册 agent (`~/.openclaw/config.yaml`) | `openclaw agents add/bind` 命令；plugin install 阶段由 setup 脚本调用 | OpenClaw agents 子系统 (mem0 记忆) |
| 2 | `skills/task-router/lib/*.js` 放可执行 JS | skills 是 markdown-only；执行代码搬到 plugin SDK 入口下（`extensions/openclaw-mao/{parser,classifier,dispatcher,verifier,plan-gate,reviewer-bridge,chain,tracker}.ts`） | OpenClaw skills/plugins 边界 |
| 3 | `openclaw sessions spawn --agent X --cwd ...` 启长 session | sessions 子系统仅 list/cleanup；派发实际接口是 **`openclaw agent --agent X --message Y --json`**（单轮），多步任务由 plugin 自己循环驱动 | OpenClaw single-turn agent dispatch |
| 4 | 自定义状态机 (PENDING/DISPATCH/VERIFYING/PUSHED/REVIEWING/BLOCKED/COMPLETED/FAILED/CANCELLED) 独立运转 | 业务子状态映射到 OpenClaw TaskFlow.status (queued/running/succeeded/failed/timed_out/cancelled/lost)；plugin 在 sqlite 里维护子状态细节 | OpenClaw TaskFlow.status 枚举 |
| 5 | 链式 task 用自创 `--depends-on` | 复用 OpenClaw TaskFlow 内置 `parentTaskId` 字段 | OpenClaw TaskFlow.parentTaskId |
| 6 | 状态写 `~/.openclaw/memory/tasks/<task-id>.json`（路径编的） | plugin 自有 sqlite，参照 `openclaw-mem0/sqlite-resilience.ts` 模式 | mem0 plugin reference impl |
| 7 | CLI 命名 `openclaw task <verb>`（与 OpenClaw 内置 task 子命令冲突） | 全部改为 `openclaw mao <verb>`，由 plugin manifest 的 `commandAliases` 注册 | OpenClaw plugin SDK manifest |
| 8 | （无）—— 缺 plugin 落地骨架 | 新增 §3.0 plugin 化分层 + §3.5 manifest 与入口框架 + §11 API 验证表 | 仿 `openclaw-mem0` 样板 |

**新增 / 重写章节**：§3.0（OpenClaw core vs MAO plugin 责任分层）、§3.5（plugin 骨架与 manifest 范例）、§11（已验证 vs 待验证 OpenClaw API surface）。

**估时影响**：plugin 化对齐没有引入新功能，但 plugin SDK 学习 + manifest/commandAliases/contracts 的 wiring 约 +1 天，总计 **6-8 天 → 7-9 天**。

### v2.1 (2026-05-09)

§9 七条决议落地。关键新增：**Claude Code 作为最终审查者**（REVIEWING 阶段）——把 v2.0 的"机械 git 校验"升级为"机械 + 智能"双层防御。

| # | 决议 | 落地章节 |
|---|------|---------|
| 1 | 并发上限 = 3 个 agent 同时跑 | §3.1 |
| 2 | 任务超时按 type 分级：bugfix 15min / feature 60min / refactor 120min；priority:high 各档 +50% | §3.2.2 |
| 3 | Merge = CLI 半自动（`openclaw mao merge` → 自动 CI + 显 diff → 用户 y/n） | §3.4 |
| 4 | **强制 plan-mode**：命中"重构/迁移/替换/200 行+"关键词时，Task Router 拒绝直接派 impl，必须先派 plan-doc 任务并评审通过 | §3.2.2 |
| 5 | 结果格式 = JSON 主体 + `summary` 人话字段 | §4 |
| 6 | 跨 agent 协作 = 链式 task（`--depends-on`），状态机加 `BLOCKED` 节点 | §3.2.3 |
| 7 | **Claude Code 作为最终审查者**：状态机加 `REVIEWING` 节点；feature/refactor/plan-doc 强制 review，bugfix 默认跳过；触发方式手动 pull（Discord 通知 → 用户在 Claude Code 输 `/review-task <id>`） | §3.2.4 + §4 |

时间估算：4-5 天 → **6-8 天**（链式 task +1 天，Claude Code review 集成 +1-2 天）。

### v2.0 (2026-05-09)

基于 antalpha-agent 工作流（branch-per-agent + worktree 隔离）和 mem0 中沉淀的踩坑经验，对 v1 做的关键修订：

| # | 章节 | v1 → v2 变化 | 动机 |
|---|------|-------------|------|
| 1 | §3.4 代码同步 | 所有 agent 共用 `git pull main` → branch-per-agent + worktree 物理隔离 | 与 antalpha-agent 已验证的工作流对齐，避免多 agent 在 main 上互相污染 |
| 2 | §4 状态机 | 增加 `VERIFYING` / `PUSHED` 节点；agent 自报 done 不算数 | 修复 zero-commit completion 反模式（历史出现 4 次）：agent 把 push 当成"交付后的事" |
| 3 | §3.1 Channel | SSH+CLI 升级为首选；Discord 降为异步通知 | 主链路保留在用户掌控内，避免 Discord API 限流 / 外网延迟；Discord 留给"用户离开终端时也能收到通知"场景 |
| 4 | §3.2.2 分类器 | 关键词匹配 → 结构化前缀（`TASK:type|...`）+ LLM fallback | 关键词分类器对自然语言（如"重构 auth 的 bug"）会同时命中多类，必然误判 |
| 5 | §4 Memory | 明确：状态写 OpenClaw 本地 memory，**不写 mem0** | 避免污染长期 user memory（mem0 有自动归并机制，会把短期任务状态当成长期事实） |
| 6 | §5.3 + §7 失败处理 | 增加 retry 策略、timeout 监控、stuck-task 检测 | v1 状态机有 FAILED 但无回路 |
| 7 | §6 / §8 时间估算 | 1-2 天 → 4-5 天 | Task Router + 状态机 + worktree 协调的复杂度被低估 |

### v1.0 (2026-05-09)

初始版本，详见 `multi-agent-collaboration-proposal.v1.bak`。

---

## 1. 现状与痛点

### 当前架构

```
┌─────────────────────┐         SSH          ┌─────────────────────────┐
│  MacBook (Local)    │ ◄──────────────────► │  VPS (Remote)           │
│                     │                      │                         │
│  • Claude Code      │    git commit+push   │  • OpenCode             │
│    (指挥家/编码)     │    复制粘贴          │    (oh-my-openagent)    │
│  • VS Code          │                      │    Plan → Execute       │
│    (文件可视化)      │                      │  • KimiCode             │
│                     │                      │    (快速 bug fix)       │
└─────────────────────┘                      │                         │
                                             │  • OpenClaw Gateway     │
                                             │    (已有，未充分利用)     │
                                             └─────────────────────────┘
```

### 痛点

| # | 痛点 | 影响 | 频率 |
|---|------|------|------|
| P1 | Claude Code 输出需手动复制粘贴给 VPS agent | 中断心流，每次 2-5 分钟 | 每天 10-20 次 |
| P2 | 代码同步靠 git commit+push，手动触发 | 遗漏时导致 agent 读到旧代码 | 每天 5-10 次 |
| P3 | 无法追踪任务在哪个 agent 上的状态 | 重复下发、遗漏完成 | 每天 3-5 次 |
| P4 | Agent 失败时没有统一告警 | 任务静默失败，用户不知情 | 每周 2-3 次 |
| P5 | 扩展新 agent 需要手动配置通信链路 | 加一个 agent 要半天 | 偶发 |
| P6 (v2 新增) | Agent 反复声明 "completed" 但未 commit/push | 用户以为完成，实际代码没落盘 | 历史观察到 4 次 |

---

## 2. 目标架构

### 核心思路

**Claude Code 不变，OpenClaw 做通信层与任务编排，VPS agent 不变。**

Claude Code 通过 SSH 调用 OpenClaw CLI 派任务 → OpenClaw 解析路由 → 创建 branch+worktree → 子 agent session 执行 → 验证 push → 结果回传（或 Discord 通知）。

### 目标拓扑

```
┌──────────────────────────────────────────────────────────────────┐
│  MacBook (Local)                                                 │
│                                                                  │
│  ┌────────────┐    ┌────────────┐                               │
│  │ Claude Code│    │  VS Code   │                               │
│  │  (指挥家)   │    │  (看文件)   │                               │
│  └─────┬──────┘    └────────────┘                               │
│        │                                                         │
│        │  SSH + openclaw CLI (主链路)                            │
└────────┼─────────────────────────────────────────────────────────┘
         │
         │  ssh admin@47.85.199.78 'openclaw mao ...'
         │
┌────────┼─────────────────────────────────────────────────────────┐
│  VPS   ▼                                                         │
│                                                                  │
│  ┌─────────────────────────────────────────────┐                 │
│  │  OpenClaw Gateway                           │                 │
│  │                                             │                 │
│  │  ┌─────────────┐  ┌─────────────┐          │                 │
│  │  │ Orchestrator│  │ Task Router │          │                 │
│  │  │   Session   │  │ (前缀+LLM)   │          │                 │
│  │  └──────┬──────┘  └──────┬──────┘          │                 │
│  │         │                │                  │                 │
│  │         ▼                ▼                  │                 │
│  │  ┌────────────┐  ┌────────────┐  ┌────────┐│                 │
│  │  │  OpenCode  │  │  KimiCode  │  │ Future ││                 │
│  │  │  Session   │  │  Session   │  │ Agent  ││                 │
│  │  │  (工程)    │  │  (快修)    │  │  ...   ││                 │
│  │  └────────────┘  └────────────┘  └────────┘│                 │
│  └─────────────────────────────────────────────┘                 │
│                          │                                       │
│                          │ 通知 (异步)                           │
│                          ▼                                       │
│              ┌─────────────────────┐                             │
│              │  Discord #agent-ops │  ←  完成/失败/卡住 推送      │
│              └─────────────────────┘                             │
│                                                                  │
│  ┌─────────────────────────────────────────────┐                 │
│  │  仓库 + worktree 隔离                        │                 │
│  │  /workspace/.git/                            │                 │
│  │  /workspace/main/                  (参考)    │                 │
│  │  /workspace/worktrees/                       │                 │
│  │    ├─ opencode-dev-task-xxx/      (独立)     │                 │
│  │    └─ kimi-bugfix-task-yyy/       (独立)     │                 │
│  └─────────────────────────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────┘
```

### 通信流程（主链路）

```
Claude Code                    OpenClaw                      VPS Agent
    │                             │                             │
    │  1. SSH 派任务               │                             │
    │  openclaw mao dispatch     │                             │
    │   --type bugfix             │                             │
    │   --branch agent/.../...    │                             │
    │ ─────────────────────────►  │                             │
    │                             │  2. 解析前缀 / LLM 兜底       │
    │                             │  → 创建 branch + worktree    │
    │                             │  → 路由到 kimi-bugfix         │
    │                             │ ─────────────────────────►  │
    │                             │                             │
    │                             │  3. Agent 在 worktree 执行   │
    │                             │  (read, fix, commit, push)  │
    │                             │                             │
    │                             │  4. 自报 done                │
    │                             │ ◄─────────────────────────  │
    │                             │  5. VERIFYING (强制校验)     │
    │                             │  - git status 干净           │
    │                             │  - origin 上有 commit        │
    │                             │  通过 → PUSHED → COMPLETED   │
    │  6. 状态可查 / Discord 通知   │                             │
    │ ◄─────────────────────────  │                             │
```

---

## 3. 实现方案

### 3.0 Plugin 化分层（v2.2 新增）

**OpenClaw 不是空白通信层**——它已有 task / agent / sessions / cron / hooks / channels / skills / plugins 八大子系统。我们要做的"多 agent 协作编排"，是 OpenClaw 之上的一个 **plugin**，不是 OpenClaw core 的一部分，也不是凭空的 daemon。

#### 责任边界

| 能力 | 归属 | 备注 |
|------|------|------|
| Agent 注册、isolated workspace、auth、routing | **OpenClaw core** (agents) | `openclaw agents add/bind` |
| 单轮 agent 派发（`--agent X --message Y --json`） | **OpenClaw core** (agent) | 单轮 in/out，多步由调用方驱动 |
| TaskFlow（状态枚举 + parentTaskId 串联） | **OpenClaw core** (tasks) | 内置 status: queued/running/succeeded/failed/timed_out/cancelled/lost |
| Sessions（list / cleanup） | **OpenClaw core** (sessions) | 仅查询和清理，**不是派发入口** |
| Cron / Hooks | **OpenClaw core** | plugin 可挂监听做 STUCK 检测、孤儿清理 |
| Discord / Telegram channels | **OpenClaw core** (channels) | plugin 通过 channel API 推通知 |
| Skills（markdown-only 文档） | **OpenClaw core** (skills) | 仅 markdown，**不放可执行代码** |
| Plugins（可执行 npm 包，manifest + commandAliases） | **OpenClaw core** (plugins) | 我们的代码住在这里 |
| Task Router / 分类 / 派发 / VERIFYING / Plan-gate / Chain | **`openclaw-mao` plugin** | 本方案的核心 |
| Reviewer bridge（review-bundle / review-result） | **`openclaw-mao` plugin** | §3.2.4 配套 |
| 业务子状态机（VERIFYING/PUSHED/REVIEWING/BLOCKED） | **`openclaw-mao` plugin** | 在 plugin 自有 sqlite 里维护 |
| Worktree 创建与 git 校验 | **`openclaw-mao` plugin** | dispatcher.ts + verifier.ts |

#### 一句话定位

`openclaw-mao` = **multi-agent orchestrator plugin**。它把"用户想让多个 agent 协作完成一组有状态、有契约要求的工程任务"翻译为：n 次 `openclaw agent --message` 单轮派发 + worktree 隔离 + git 强校验 + 智能 review，状态写在 plugin 自己的 sqlite，对外暴露 `openclaw mao <verb>` 一组 CLI（参考 `openclaw-mem0` 样板）。

#### 与 OpenClaw 已验证 plugin 的对齐

`openclaw-mem0`（住在 `/home/admin/.openclaw/extensions/openclaw-mem0/`）已经跑通的模式：
- `openclaw.plugin.json` 注册 `commandAliases: [{name:"mem0", cliCommand:"mem0"}]` → `openclaw mem0 <...>`
- `contracts.tools` 列 LLM tool-calling 名单（`memory_search` / `memory_add` / ...）
- `kind: "memory"` 标识子类
- 入口 `index.ts` + `cli/` + `backend/` + `providers.ts` + sqlite 持久化（`sqlite-resilience.test.ts` 验证）
- `skills/` 目录挂 markdown-only skill

`openclaw-mao` 直接复用该样板（详见 §3.5）。

### 3.1 Channel 选择

| 通道 | 用途 | 推荐 |
|------|------|------|
| **SSH + OpenClaw CLI** | 主链路：Claude Code 派任务 / 查状态 | ⭐ 首选 |
| **Discord** | 异步通知：agent 完成 / 失败 / STUCK 时推送 | 辅助 |
| **Telegram** | Discord 备选 | 备选 |

**为什么 SSH+CLI 主链路**：
- 链路在用户掌控内，无第三方限流 / 外网延迟
- 用户已天天 SSH 到 VPS，凭据复用现有 SSH key
- 失败模式简单：SSH 不通就是网络问题，不用排查 Discord bot 状态

**为什么保留 Discord 作为通知通道**：
- 用户不在终端时也能收到 push（手机 Discord 客户端）
- OpenClaw 已有 Discord channel 配置可复用
- 仅做单向通知，不承担派发，限流影响很小

> **v1 选 Discord 主要是因为已有配置，但忽略了"每条任务都绕外网一圈"的代价。v2 把 Discord 降级为通知通道，保留其价值，避免其代价。**

### 3.1.1 并发上限

**最多同时 3 个 agent 跑非阻塞 task**（v2.1 决议）。OpenClaw Gateway 维护一个 dispatch semaphore：

- 当前活跃 task 数 ≥ 3 时，新 dispatch 进入 PENDING 队列
- 任意 task 进入终态（COMPLETED / FAILED / CANCELLED）时弹出队首
- BLOCKED 状态（等依赖）的 task **不**占用并发名额

**理由**：约束不是 VPS 资源（agent 是 CLI 调远程 LLM API，本地 CPU 轻），而是用户人脑能同时跟踪的任务条数。3 条覆盖 bugfix/feature/refactor 三大类典型场景。

### 3.2 OpenClaw 配置

#### 3.2.1 Agent 注册（v2.2：命令式，非 yaml）

**v2.1 错误**：写成 `~/.openclaw/config.yaml` 的 yaml 块。OpenClaw agents 子系统的实际接口是 `agents add` / `bind` 命令，不是 yaml 文件配置。

`openclaw-mao` plugin 在 install 阶段（plugin manifest 的 `setup` hook 或独立 setup 脚本）批量调用：

```bash
# Plugin install 后由 plugin setup 调用（用户视角是 openclaw plugin install openclaw-mao 一次性完成）
openclaw agents add opencode-dev \
  --description "OpenCode 工程团队：新功能、重构、代码审查" \
  --model qwen/qwen3-coder-next \
  --skills web3-trader,antalpha-ai-setup

openclaw agents add kimi-bugfix \
  --description "KimiCode 快修：紧急 bug 修复、hotfix" \
  --model moonshot/kimi-k2.5

openclaw agents add orchestrator \
  --description "主编排器：分类、状态追踪、结果汇总" \
  --model xiaomi/mimo-v2.5
```

随后 `openclaw agents bind` 把 agent 与对应 isolated workspace / auth credential 绑定（具体参数见 OpenClaw `agents bind --help`，§11 标记为待验证细节）。

**为什么命令式更好**: agent 注册涉及 isolated workspace 创建和 credential routing，是状态变更而不是声明配置；命令式接口让失败可见、可回滚，yaml 假设的"reload 即生效"在 OpenClaw 实现里并不成立。

#### 3.2.2 Task Router Skill

任务路由优先识别**结构化前缀**，自然语言降级到 LLM 分类。

**优先级 1：结构化前缀**

```
TASK:bugfix   | <description> | priority:<high|medium|low> [| branch:<name>]
TASK:feature  | <description> | priority:<...>             [| branch:<name>]
TASK:refactor | <description> | priority:<...>             [| branch:<name>]
STATUS        | <task-id>
CANCEL        | <task-id>
LIST          [| filter:<running|failed|...>]
```

CLI 直接派任务时强制走前缀，分类器零误判。

**优先级 2：LLM 分类降级**

非结构化输入（例如从 Discord 转发的自然语言）由 orchestrator 调用 LLM：

```json
{
  "type": "bugfix | feature | refactor",
  "confidence": 0.0-1.0,
  "reason": "..."
}
```

- `confidence ≥ 0.7` 直接派发
- `confidence < 0.7` 回问用户："识别为 bugfix（0.62），是否确认？" 不盲派

**Branch 分配**

每个任务一条独立 branch + 独立 worktree（详见 §3.4）：
- 命令里指定 `branch:` 时优先使用
- 未指定时自动生成：`agent/<agent-id>/task-<unix-timestamp>`

**Skill / Plugin 模块分布**（v2.2 修正：skills 是 markdown-only，可执行代码必须在 plugin 入口下）

```
# 1. Markdown-only skill（OpenClaw skills 子系统下，仅文档）
skills/task-router/SKILL.md     # 描述：何时调 task router、前缀语法、人类可读规则

# 2. 可执行模块（openclaw-mao plugin 入口下）
extensions/openclaw-mao/
├── openclaw.plugin.json        # manifest：见 §3.5
├── index.ts                    # plugin entry: 注册 commandAliases 处理函数 + tool contracts
├── cli/
│   ├── dispatch.ts             # `openclaw mao dispatch` 子命令
│   ├── status.ts               # `openclaw mao status`
│   ├── list.ts                 # `openclaw mao list`
│   ├── cancel.ts               # `openclaw mao cancel`
│   ├── merge.ts                # `openclaw mao merge`（半自动）
│   ├── cleanup.ts              # `openclaw mao cleanup`
│   ├── review-bundle.ts        # `openclaw mao review-bundle`
│   └── review-result.ts        # `openclaw mao review-result`
├── parser.ts                   # 结构化前缀解析
├── classifier.ts               # LLM 分类降级
├── dispatcher.ts               # branch + worktree 创建 → 调 `openclaw agent --message --json`（多步循环）
├── verifier.ts                 # VERIFYING 阶段 git 校验
├── reviewer-bridge.ts          # review bundle 准备 + verdict 写回
├── plan-gate.ts                # Plan-mode 强制 gate
├── chain.ts                    # 借 TaskFlow.parentTaskId 做依赖解锁与级联取消
├── tracker.ts                  # plugin 自有 sqlite 读写（业务子状态）
└── sqlite-resilience.ts        # 仿 openclaw-mem0 的持久化基类
```

`SKILL.md` 由 orchestrator agent 在分类/派发时按需加载，告诉它"前缀怎么解析、关键词触发什么 gate"；真正的执行（解析、派发、校验）由 plugin 入口在 OpenClaw 进程内同步调用，不走 LLM tool-loop。

#### 任务超时（按 type 分级）

| type | 默认 timeout | priority:high | 触发动作 |
|------|-------------|---------------|---------|
| bugfix | 15 min | 22.5 min | RUNNING 超时 → FAILED + Discord 告警 |
| feature | 60 min | 90 min | 同上 |
| refactor | 120 min | 180 min | 同上 |
| plan-doc | 30 min | 45 min | 同上（plan-doc 任务也有超时） |
| review (Claude Code) | 用户人工触发，无 timeout | — | 由用户决定何时 review |

阈值由 type 派生，无需额外配置。VERIFYING 5 min 上限保持不变。

#### Plan-mode 强制 gate

Task Router 在派发前先过 `plan-gate.js`：

**触发条件（任一命中即拒绝直接派 impl 任务）**：
- description 包含关键词：`重构|迁移|替换|refactor|migrate|replace|框架替换`
- 显式标注 `--lines >=200` 或 `--scope multi-file`
- type 为 `refactor`

**触发后行为**：

```
$ openclaw mao dispatch --type refactor --description "重构 IntentService 替换为 LangGraph subgraph"
ERROR: 该任务命中 plan-mode gate（关键词: 重构, 替换）。

大重构必须先派 plan-doc 任务，评审通过后才能派 impl。

请按以下流程：
  1. openclaw mao dispatch --type plan-doc \
       --description "为 IntentService → LangGraph subgraph 重构写 impl plan" \
       --target docs/intent-subgraph-impl-plan.md
  2. （等 plan-doc 评审通过）
  3. openclaw mao dispatch --type refactor \
       --description "..." \
       --plan-doc docs/intent-subgraph-impl-plan.md
```

未带 `--plan-doc` 参数的 refactor / 大改 impl 任务一律拒绝。

> **设计动机**: mem0 中"plan_mode_for_large_refactors" feedback——用户已验证过 4 次：跳过 plan 直接写代码会出 pseudo-subgraph，被迫 rework。Task Router 把这条硬规则实例化为不可绕过的 gate。

### 3.2.3 链式 task（跨 agent 协作）

支持"先 opencode 写代码、再 kimi review"这类有先后依赖的任务编排（v2.1 新增；v2.2 改为复用 OpenClaw TaskFlow.parentTaskId）。

#### 派发语法

```bash
# 先派父任务，拿到 task-id
TASK_A=$(ssh admin@47.85.199.78 'openclaw mao dispatch \
  --type feature \
  --description "实现 X 功能" \
  --json' | jq -r .task_id)

# 派依赖任务：plugin 通过 OpenClaw TaskFlow.parentTaskId 串联
ssh admin@47.85.199.78 "openclaw mao dispatch \
  --type review \
  --description '检查 $TASK_A 的实现是否有边界 case 遗漏' \
  --parent-task $TASK_A"
```

**v2.2 修正**：v2.1 的 `--depends-on` 是凭空发明的字段，不存在于 OpenClaw。OpenClaw TaskFlow 内置 `parentTaskId`，本就用来表达父子关系，plugin 直接复用即可。`openclaw mao dispatch` 内部把 `--parent-task` 翻译为 TaskFlow 的 parentTaskId。

#### 业务子状态（plugin 自管，独立于 TaskFlow.status）

依赖未满足的子任务在 plugin sqlite 里标 **BLOCKED**（OpenClaw TaskFlow.status 仍是 `queued`，不占 plugin 自己维护的并发 semaphore 名额）：

- 父任务 plugin 子状态进入 PUSHED → 子任务从 BLOCKED 转入 PENDING（占 plugin 名额排队）
- 父任务 TaskFlow.status = `failed` / `cancelled` → 子任务 plugin 子状态自动 CANCELLED（同步 TaskFlow.status=cancelled）+ Discord 通知"上游失败"

#### 限制（v2.2 维持 v2.1 决议）

- 仅支持 **线性链**（A → B → C，逐级 parentTaskId），不支持 fan-out / fan-in DAG
- 单条链最长 5 个任务
- 循环依赖（A→B→A）派发时立刻拒绝
- 完整 DAG 留 v3 设计

### 3.2.4 Claude Code 作为最终审查者（REVIEWING）

**v2.1 关键新增**：在机械的 VERIFYING 之外，加一层智能审查——由 Claude Code（项目里模型能力最强、且持有 CLAUDE.md / mem0 / 历史记忆）做契约层审查。

#### 为什么需要

VERIFYING 只校验"代码是否落盘到 origin"，不校验"代码是否符合契约"。后者是历史踩坑核心：
- pseudo-subgraph：30 个测试通过 / 5 条契约全挂
- DI wiring 没接对但单测通过
- compact 后丢失工程纪律导致 plan §8 类章节漏实现

VERIFYING + REVIEWING 形成多层防御：

```
机械层（VERIFYING）→ 拦 zero-commit
   ↓
智能层（REVIEWING）→ 拦 pseudo-implementation / 契约偏离 / DI 失联
   ↓
人工层（CLI merge 半自动）→ 最终把关
```

#### 覆盖范围（按 type 分级）

| type | review 默认 |
|------|------------|
| feature | ✅ 强制 |
| refactor | ✅ 强制 |
| plan-doc | ✅ 强制（review 文档质量） |
| bugfix | ⚪ 默认跳过；可 `--review` 显式开启 |

#### 触发方式：手动 pull

Claude Code 不是 daemon，无法被远程触发。流程：

1. Task 进入 PUSHED → OpenClaw 推送 Discord 通知到 `#agent-ops`：
   ```
   📋 Review needed: task-1715230000 (feature)
   Branch: agent/opencode-dev/task-1715230000
   Files: 7 changed (+342 -89)
   Run in Claude Code: /review-task 1715230000
   ```
2. 用户在 Claude Code session 输入 `/review-task 1715230000`（项目 CLAUDE.md 里定义的 skill）
3. Skill 自动 SSH 调 `openclaw mao review-bundle 1715230000`，拉取：
   - 完整 diff
   - 关联的 plan-doc（如有）
   - task description / 契约要求
   - 相关历史 mem0 记忆（用户偏好、踩坑经验）
4. Claude Code 用其完整能力（Opus 4.7 1M context）做契约审查，输出结构化 verdict
5. Skill 把 verdict 通过 SSH 写回：`openclaw mao review-result 1715230000 --verdict pass --feedback "..."`

#### Review verdict 格式

```json
{
  "verdict": "pass | fail | needs-clarification",
  "summary": "一句话总结",
  "checks": {
    "contract_satisfied": true,
    "di_wiring_correct": true,
    "edge_cases_covered": false,
    "test_validates_contract_not_just_state": true,
    "no_pseudo_implementation": true
  },
  "feedback": "具体要改什么（fail 时给 agent 用）",
  "blocking_issues": ["..."],
  "suggestions_non_blocking": ["..."]
}
```

#### Review 失败回路

VERIFYING_FAILED 不 retry（行为问题），但 **REVIEWING_FAILED 是技术问题**——Claude Code 给出具体反馈，agent 应该能基于反馈改：

- REVIEWING fail → `feedback` 字段回灌 agent session → 进入 RUNNING（retry 1 次）
- 第二次又 REVIEWING fail → 进入 FAILED 终态 + Discord 告警（避免无限循环）

#### Claude Code 端的 review skill

在项目 CLAUDE.md 加：

```markdown
## /review-task <task-id>

When user invokes this command:

1. SSH 调 `openclaw mao review-bundle <task-id>` 拉 diff bundle + 上下文
2. 加载关联的 plan-doc（如有）和 mem0 中相关踩坑经验
3. 按以下维度审查：
   - 契约满足度（参考 plan-doc 中的契约清单）
   - DI wiring 是否真的接上（不只是单测过）
   - 边界 case 覆盖
   - 是否存在 pseudo-implementation（测试通过但不真正实现功能）
   - 是否绕过 plan 中明确要求的 §8 类工程纪律
4. 输出 JSON verdict（见 §3.2.4 verdict 格式）
5. SSH 调 `openclaw mao review-result <id> --verdict <...> --feedback <...>` 写回
```

### 3.3 Claude Code 侧集成

#### 主链路：SSH + OpenClaw CLI

在项目 CLAUDE.md 中加入：

```markdown
## VPS Agent 协作

需要 VPS 执行任务时，通过 SSH 调用 OpenClaw CLI：

# 派任务（结构化前缀）
ssh admin@47.85.199.78 'openclaw mao dispatch \
  --type bugfix \
  --priority high \
  --description "修复 auth.py 第42行 bug" \
  --branch agent/kimi-bugfix/task-$(date +%s)'

# 派带依赖的任务（链式 task，v2.1 新增）
ssh admin@47.85.199.78 "openclaw mao dispatch \
  --type review --description '...' --depends-on $TASK_A"

# 派大重构任务（必须带 plan-doc，v2.1 强制）
ssh admin@47.85.199.78 'openclaw mao dispatch \
  --type refactor \
  --description "..." \
  --plan-doc docs/intent-subgraph-impl-plan.md'

# 查询 / 列表 / 取消 / 清理
ssh admin@47.85.199.78 'openclaw mao status <task-id>'
ssh admin@47.85.199.78 'openclaw mao list --filter running'
ssh admin@47.85.199.78 'openclaw mao cancel <task-id>'
ssh admin@47.85.199.78 'openclaw mao cleanup <task-id>'

# Merge 半自动（v2.1 新增）
ssh admin@47.85.199.78 'openclaw mao merge <task-id>'
# 自动跑 CI + 显示 diff，等待用户 y/n 后才真的 merge

# Review 配套命令（在 Claude Code review skill 内部使用）
ssh admin@47.85.199.78 'openclaw mao review-bundle <task-id>'        # 拉 diff + 上下文
ssh admin@47.85.199.78 'openclaw mao review-result <task-id> \
  --verdict pass --feedback "..."'                                     # 写回 verdict
```

CLI 输出 JSON，Claude Code 可直接解析下一步动作。

#### 辅助链路：Discord 异步通知

OpenClaw 在以下事件主动推送到 `#agent-ops`：

| 事件 | 内容 |
|------|------|
| COMPLETED | task-id, branch, commit-sha 列表, summary |
| FAILED (终态) | task-id, retry 次数, 失败原因, 日志 URL |
| STUCK (>30min running) | task-id, agent, 最后活动时间 |
| VERIFYING_FAILED | task-id, 校验失败原因（uncommitted / not-pushed / branch-missing） |

用户在外不需要主动查询，关键事件自动推送。

### 3.4 代码同步：branch-per-agent + worktree 隔离

**与 antalpha-agent 现有验证过的工作流对齐。** v1 的 `git pull main` 模型放弃。

#### 工作模型

```
/workspace/
  ├─ .git/                                       # 仓库状态权威源
  ├─ main/                                       # main 签出（只读，参考用）
  └─ worktrees/                                  # 每个任务一个独立 worktree
       ├─ opencode-dev-task-1715230000/          # → branch: agent/opencode-dev/task-1715230000
       ├─ kimi-bugfix-task-1715230800/           # → branch: agent/kimi-bugfix/task-1715230800
       └─ ...
```

#### 任务派发时（dispatcher.ts 自动；v2.2 修正：用 agent dispatch 不是 sessions spawn）

```bash
# 1. 从 main 切出新分支
git -C /workspace branch agent/<agent>/task-<id> origin/main

# 2. 创建 worktree
git -C /workspace worktree add \
    /workspace/worktrees/<agent>-task-<id> \
    agent/<agent>/task-<id>

# 3. plugin dispatcher 在 cwd=worktree 路径下，单轮派给 agent
openclaw agent \
  --agent <agent> \
  --message "<rendered task prompt with description, branch, plan-doc ref, contract checks>" \
  --cwd /workspace/worktrees/<agent>-task-<id> \
  --json
# 返回单轮 agent 输出（可能是工具调用、写文件、commit、自报 done）
```

**v2.2 修正**: v2.1 写的 `openclaw sessions spawn --agent ... --cwd ...` 不存在——sessions 子系统只有 `list/show`，是只读的。OpenClaw 真正的 agent 派发入口是 `openclaw agent --agent X --message Y --json`，并提供 `--session-id` 让多 turn 在同一 session 内连续。

**多步任务由 OpenClaw session 维持**（v2.2 + Phase 0 探针修正）：v2.1 假设 plugin 要"自驱多步循环、每轮重组完整 prompt"。Phase 0 跑 `openclaw agent --help` 发现 **`--session-id <id>`** 选项已存在，OpenClaw agent 自带 multi-turn session 维持。dispatcher 只需要传相同 session-id 就能让 agent 在前一轮上下文上继续，不必自己拼 prompt 历史：

```ts
// dispatcher.ts 伪代码（v2.2 简化版）
async function runTask(task: Task) {
  const sessionId = `mao:${task.task_id}`;   // 用 task-id 派生 session-id
  let turn = 0;
  while (turn++ < MAX_TURNS_BY_TYPE[task.type]) {
    const out = await execHost("openclaw", [
      "agent",
      "--agent", task.assignee,
      "--session-id", sessionId,
      "--message", turn === 1 ? renderInitialPrompt(task) : renderContinuationPrompt(task),
      "--json",
    ]);
    if (claimsDone(out))  break;
    if (needsClarify(out)) return haltForUser(task);
  }
  return enterVerifying(task);
}
```

#### `--cwd` fallback（v2.2 + Phase 0 探针确认）

**Phase 0 探针结论：`openclaw agent` 不支持 `--cwd`**。两种 fallback 取其一（推荐 a）：

a. **Plugin 进程内 chdir**: dispatcher 调 host CLI 前 `process.chdir(task.worktree_path)`，`openclaw agent` 子进程继承 cwd。代价：plugin 进程同一时刻只能跑一个 task 的 chdir，需要在 dispatcher 串行化或 fork 子进程隔离。

b. **Prompt 注入 cwd**: 在 `--message` 头部加 `Working directory: ${task.worktree_path}\nAlways operate inside this directory.\n\n${task.description}`，由 agent 在工具调用里自行 cd。代价：依赖 agent 听话，对不熟纪律的 agent 不可靠。

实施选 a：dispatcher 给每个 task 起独立 worker 子进程（child_process），子进程内 chdir 后调 host CLI，互不影响。这也顺便解决了 §3.4 并发隔离问题。

#### 任务完成判定（VERIFYING 阶段）

Agent 报 done 后**不直接进入 COMPLETED**，必须先经过 VERIFYING 校验三项：

1. `git status --porcelain` 输出为空（工作区干净）
2. `git rev-list origin/<branch>..HEAD` 输出为空（没有未推送 commit）
3. `git ls-remote origin <branch>` 非空（远端确实有这个 branch）

三项全过 → PUSHED → COMPLETED。任一失败 → VERIFYING_FAILED → 重新进 RUNNING（如有 retry 配额）或 FAILED。

#### Merge 半自动（v2.1 决议）

`openclaw mao merge <task-id>` 提供半自动 merge 流程：

```bash
$ ssh admin@47.85.199.78 'openclaw mao merge task-1715230000'

[1/4] Pre-flight check: task status = COMPLETED ✓
[2/4] Running CI on agent/opencode-dev/task-1715230000...
      • lint: pass
      • typecheck: pass
      • test: pass (47 tests)
      • build: pass
[3/4] Diff summary:
      7 files changed, 342 insertions(+), 89 deletions(-)
      [显示 git diff main...agent/opencode-dev/task-1715230000]
[4/4] Merge to main? (y/N): _
```

用户输 `y` → fast-forward merge → 自动清理 worktree + branch；输 `N` → 不 merge，task 留在 PUSHED 状态等用户后续手动 merge。

#### 任务结束后清理

```bash
# 不走 merge 命令时（如手动操作 / 直接放弃 task）：
openclaw mao cleanup <task-id>
# 内部执行：
#   git -C /workspace worktree remove /workspace/worktrees/<agent>-task-<id>
#   git -C /workspace branch -D agent/<agent>/task-<id>   (仅当已 merge 或 CANCELLED)
```

#### v1 vs v2 对比

| 维度 | v1（已放弃） | v2 |
|------|------|------|
| 分支策略 | 所有 agent 共用 main | branch-per-agent |
| 隔离性 | 无（共享文件系统） | worktree 物理隔离 |
| 并发安全 | 多 agent 同时改 main 必冲突 | 互不干扰 |
| 失败回滚 | 难（main 已被污染） | 直接删 branch + worktree |
| 与 antalpha-agent 现状 | 不一致 | 一致 |

### 3.5 Plugin 骨架（v2.2 新增）

参照 `/home/admin/.openclaw/extensions/openclaw-mem0/` 的已验证模式落 `openclaw-mao` plugin。manifest 在 plugin 包根目录，由 OpenClaw 在 plugin install 时读取。

#### `openclaw.plugin.json`（最小可用）

```jsonc
{
  "id": "openclaw-mao",
  "name": "Multi-Agent Orchestrator",
  "description": "在 OpenClaw 上派发、追踪、校验、review 多 agent 协作任务。基于 branch-per-agent + worktree 隔离 + git 强校验 + Claude Code 智能 review。",
  "version": "0.1.0",
  "kind": "orchestrator",
  "skills": ["skills"],

  "commandAliases": [
    { "name": "mao", "cliCommand": "mao" }
  ],

  "contracts": {
    "tools": [
      "mao_dispatch",
      "mao_status",
      "mao_list",
      "mao_cancel",
      "mao_cleanup",
      "mao_merge",
      "mao_review_bundle",
      "mao_review_result"
    ]
  },

  "setup": {
    "providers": [
      {
        "id": "mao",
        "envVars": ["MAO_DEFAULT_BRANCH_PREFIX"]
      }
    ]
  },

  "uiHints": {
    "concurrencyLimit": {
      "label": "Concurrency Limit",
      "placeholder": "3",
      "help": "同时跑的 agent 数（默认 3，BLOCKED 不占名额）"
    },
    "timeouts": {
      "label": "Type-tiered Timeouts",
      "advanced": true,
      "help": "按 type 分级 timeout（分钟）：bugfix/feature/refactor/plan-doc"
    },
    "planGateKeywords": {
      "label": "Plan-mode Trigger Keywords",
      "advanced": true,
      "help": "命中即拒绝直接派 impl，强制先派 plan-doc"
    }
  },

  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "concurrencyLimit": { "type": "integer", "default": 3 },
      "branchPrefix":     { "type": "string",  "default": "agent" },
      "timeouts": {
        "type": "object",
        "properties": {
          "bugfix":   { "type": "integer", "default": 15 },
          "feature":  { "type": "integer", "default": 60 },
          "refactor": { "type": "integer", "default": 120 },
          "planDoc":  { "type": "integer", "default": 30 }
        }
      },
      "highPriorityMultiplier": { "type": "number", "default": 1.5 },
      "verifyingTimeoutMin":    { "type": "integer", "default": 5 },
      "stuckHeartbeatMin":      { "type": "integer", "default": 30 },
      "planGateKeywords": {
        "type": "array",
        "items": { "type": "string" },
        "default": ["重构","迁移","替换","refactor","migrate","replace","框架替换"]
      },
      "reviewRequiredTypes": {
        "type": "array",
        "items": { "type": "string", "enum": ["feature","refactor","plan-doc","bugfix"] },
        "default": ["feature","refactor","plan-doc"]
      },
      "retry": {
        "type": "object",
        "properties": {
          "running":  { "type": "integer", "default": 3 },
          "review":   { "type": "integer", "default": 1 },
          "verifying":{ "type": "integer", "default": 0 }
        }
      },
      "discordChannel": {
        "type": "string",
        "description": "OpenClaw channel id（在 channels 子系统配置）"
      }
    },
    "required": []
  },

  "providerEndpoints": []
}
```

#### 入口框架（`index.ts`，v2.2-r2 已实测对齐 OpenClaw plugin SDK；v2.2-r3 加约束）

> **⛔ 硬约束（v2.2-r3 实测）**：`register(api)` 内**禁止**任何 `child_process.spawnSync` / 阻塞 host CLI 调用。
> 1. `async function ensureXxx()` 包不住内部 `spawnSync` —— 它仍同步阻塞 register 调用栈，导致 plugin 加载 14s+。
> 2. spawn 出的子 `openclaw` 进程会再加载本 plugin、再 spawn ……无限 fork 死循环。
> 3. 凡是要调 host CLI 做 setup（`agents add` / `cron add` 等），统一暴露成显式 `mao setup` 子命令，由用户在 install 后手动跑一次。

```ts
// 真实 SDK：`definePluginEntry({ id, name, description?, register(api) })`
// 没有 onInstall / cli / tools / hooks 顶层字段——所有注册都通过 register(api) 内调
// api.registerCli / api.registerTool / api.registerService / api.on(...)
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { registerCliCommands } from "./cli";       // 内部调 api.registerCli
import { registerTools }       from "./tools";     // 内部调 api.registerTool
import { startMonitorService } from "./monitor";   // 内部调 api.registerService
import { Tracker }             from "./tracker";
import { ensureAgentsRegistered } from "./setup";  // 替代 onInstall 的延迟初始化

export default definePluginEntry({
  id: "openclaw-mao",
  name: "Multi-Agent Orchestrator",
  description: "Dispatch, track, verify, review multi-agent collaboration tasks on OpenClaw.",

  register(api: OpenClawPluginApi) {
    // 1. 同步、非阻塞、不调 host CLI 的初始化
    Tracker.init(api.resolvePath("data/tasks.db"));   // better-sqlite3，~60ms

    // 2. CLI 注册：descriptors 必填，否则 handler 不会被 loader 调用！(v2.2-r2 实测)
    //    setup（注册 agents / cron）由 `openclaw mao setup` 子命令显式触发，不在这里
    registerCliCommands(api);

    // 3. LLM tools (contracts.tools 列表对应)
    registerTools(api);

    // 4. 后台监控（STUCK 检测 / 孤儿清理；v2.2-r1 §11 待验证 cron hook 形式）
    //    startMonitorService 内若需调 host CLI，必须在 service.start() 异步跑而非 register 时同步跑
    startMonitorService(api);
  },
});
```

**`api.registerCli` 必填 `descriptors`**（v2.2-r2 关键发现）：

```ts
// cli/index.ts
export function registerCliCommands(api: OpenClawPluginApi) {
  api.registerCli(
    ({ program }) => {
      const mao = program.command("mao").description("...");
      mao.command("dispatch").option("--type <t>", "...").action(...);
      // ... 7 个其余子命令
    },
    {
      descriptors: [
        { name: "mao", description: "Multi-Agent Orchestrator commands", hasSubcommands: true },
      ],
    },
  );
}
```

**陷阱**：缺 `descriptors` 时 `register(api)` 仍执行、`api.registerCli(handler)` 不报错、`openclaw plugins inspect` 仍打印 `Commands: mao` —— 但 handler 永远不会被调用，`openclaw mao` 命令永远 unknown。**只有 `openclaw plugins doctor` 会打 "cli registration missing explicit commands metadata"**。下次写 plugin 第一件事就检 descriptors。

#### 与 `openclaw-mem0` 的复用清单

| 文件/模式 | 复用方式 |
|----------|---------|
| `sqlite-resilience.ts` (WAL + 锁重试 + schema 迁移) | 几乎原样拷贝，仅改 schema 表名 |
| `openclaw-plugin-sdk.d.ts` 类型定义 | 直接复用 |
| `tsup.config.ts` + `pnpm-workspace.yaml` | 直接复用 |
| `Makefile` 构建脚本 | 改 plugin id 即可 |
| `telemetry.ts` 模式（匿名 telemetry） | 可选复用 |
| `providers.ts` 多 provider 组合 | 不需要（mao 不接外部 provider） |

预计 plugin 骨架搭起来 0.5-1 天（manifest + 入口 + sqlite + commandAliases wiring）。

---

## 4. 任务生命周期

### 业务子状态 ↔ OpenClaw TaskFlow.status 映射（v2.2 新增）

每个 plugin 派发的 task 同时在两个层面有状态：
- **OpenClaw TaskFlow.status**（core 子系统维护，外部 dashboard / `openclaw tasks list` 看到的）
- **Plugin 业务子状态**（plugin sqlite 维护，`openclaw mao list` 看到的细粒度）

| 业务子状态 (plugin) | OpenClaw TaskFlow.status (core) | 说明 |
|---------------------|----------------------------------|------|
| BLOCKED | queued | 等父 task；不占 plugin 并发名额 |
| PENDING | queued | 占 plugin 并发名额，等 dispatch |
| DISPATCH | running | 切 branch、建 worktree |
| RUNNING | running | agent 多轮派发循环执行中 |
| VERIFYING | running | git 三项校验中 |
| PUSHED | running | 已推到 origin，等 review（如需） |
| REVIEWING | running | Claude Code 契约审查中 |
| COMPLETED | succeeded | 终态 |
| FAILED (执行/校验/review 用尽) | failed | 终态 |
| FAILED (RUNNING > type timeout) | timed_out | 终态；type 分级超时 → 这一档 |
| FAILED (RUNNING > 30min 无心跳) | lost | 终态；STUCK 检测把卡死任务划进 lost |
| CANCELLED | cancelled | 终态 |

**为什么这样切分**: `TaskFlow.status` 是 OpenClaw 给所有 plugin 共用的粗粒度状态，外部观察者（其他 plugin、监控）只关心"这个 task 跑没跑、成没成"。`openclaw-mao` plugin 自己关心"卡在哪一步"才能做 STUCK 告警、retry 决策、链式 task 解锁——这些细节走 plugin 自己的 sqlite，不污染 TaskFlow。

### 状态机（v2.1 增加 BLOCKED / REVIEWING）

```
                       ┌──────────┐
                       │ BLOCKED  │  等依赖（链式 task，不占并发名额）
                       └────┬─────┘
                            │ 父任务 PUSHED
                            ▼
              ┌──────────┐      ┌──────────┐
       ┌──── │ PENDING  │ ◄──── │  入列    │
       │     └────┬─────┘      （并发≥3 时）
       │          │
   取消/超时       ▼
       │     ┌──────────┐
       │     │ DISPATCH │  创建 branch + worktree
       │     └────┬─────┘
       │          │
       │          ▼
       │     ┌──────────┐
       │     │ RUNNING  │ ◄──── retry ≤3（执行层 retry）
       │     └────┬─────┘  ◄──── retry ≤1（review feedback retry）
       │          │ agent claims done
       │          ▼
       │     ┌────────────┐
       │     │ VERIFYING  │  机械层：git status / push 校验
       │     └─────┬──────┘
       │           │ pass
       │           ▼
       │     ┌──────────┐
       │     │  PUSHED  │  origin 上确实有 commit
       │     └────┬─────┘
       │          │ feature/refactor/plan-doc 强制；bugfix 默认跳过
       │          ▼
       │     ┌────────────┐
       │     │ REVIEWING  │  智能层：Claude Code 契约审查（v2.1 新增）
       │     └─────┬──────┘
       │           │ verdict=pass
       │  fail──┐  ▼
       │  (回灌  │  ┌──────────┐
       │  feedback│ COMPLETED│
       │   retry │  └──────────┘
       │    1次) │
       │        ▼
       │   ┌──────────┐
       │   │ FAILED   │ 终态（VERIFYING/REVIEWING/超时/retry 用尽）
       │   └──────────┘
       │
       ▼
  ┌──────────┐
  │ CANCELLED│
  └──────────┘
```

**状态转换关键规则**：
- BLOCKED → PENDING：父任务进入 PUSHED 即触发（不等到 COMPLETED，因为 review 可能等很久）
- VERIFYING → FAILED：行为问题，**不 retry**
- REVIEWING → RUNNING：Claude Code 给出可操作 feedback，agent 基于 feedback 改一次（retry ≤ 1）
- 父任务 FAILED → 所有 BLOCKED 子任务自动 CANCELLED + 通知

### 完成判据（修复 zero-commit 反模式）

Agent 自报 done 后由 verifier.ts 强制校验：

```javascript
async function verify(task) {
  const cwd = task.worktree_path;

  // 1. 工作区干净
  const status = await exec(`git -C ${cwd} status --porcelain`);
  if (status.trim()) {
    return { ok: false, reason: "uncommitted_changes", detail: status };
  }

  // 2. 已经 push 到 remote
  const ahead = await exec(`git -C ${cwd} rev-list origin/${task.branch}..HEAD`);
  if (ahead.trim()) {
    return { ok: false, reason: "commits_not_pushed", detail: ahead };
  }

  // 3. branch 在 remote 上确实存在
  const remoteRef = await exec(`git ls-remote origin ${task.branch}`);
  if (!remoteRef.trim()) {
    return { ok: false, reason: "branch_not_on_origin" };
  }

  return { ok: true };  // → 进入 PUSHED 状态
}
```

> **设计动机**: 历史上 antalpha-agent 出现过 4 次 zero-commit completion 反模式（web-search v1.0、Phase 1 first、Phase 2 draft、Phase 2 rework），agent 把 push 当成"交付后的事"。VERIFYING 这一关把这个反模式直接拦在状态机里，agent 自己说"完成"不算数，必须代码确实落盘到 origin 才算。

### 失败重试

| 失败阶段 | retry 策略 |
|---------|-----------|
| RUNNING → FAILED（执行层） | 自动 retry ≤ 3 次，指数退避 30s / 2min / 5min |
| VERIFYING_FAILED（行为层） | **不自动 retry**——agent 行为问题，需要人介入或换 agent |
| REVIEWING_FAILED（技术层，v2.1 新增） | retry ≤ 1 次。Claude Code 的 `feedback` 字段回灌 agent session prompt，让 agent 基于具体反馈改 |
| 超过 retry 上限 | 进入 FAILED 终态，触发 Discord 告警 |

### Plugin sqlite 中的 task 行（v2.2：从 JSON 文件改为 sqlite 行）

```json
{
  "task_id": "task-1715230800",
  "description": "实现 X 功能",
  "type": "feature",
  "priority": "high",
  "assignee": "opencode-dev",
  "branch": "agent/opencode-dev/task-1715230800",
  "worktree_path": "/workspace/worktrees/opencode-dev-task-1715230800",
  "status": "reviewing",
  "retry_count_run": 0,
  "retry_count_review": 0,

  "openclaw_task_id": "tsk_01HX...",          // OpenClaw TaskFlow 主键（plugin 创建任务时拿到）
  "openclaw_parent_task_id": null,            // v2.2：链式 task 走 TaskFlow.parentTaskId
  "openclaw_status": "running",               // 镜像 OpenClaw TaskFlow.status，便于跨表 join
  "unblocks": ["task-1715230900"],            // 由 plugin 通过反查 parentTaskId 维护

  "plan_doc": "docs/feature-x-impl-plan.md",
  "review_required": true,
  "review_verdict": null,
  "review_feedback": null,
  "reviewed_at": null,
  "reviewer": "claude-code",

  "created_at": "2026-05-09T10:36:00+08:00",
  "dispatched_at": "2026-05-09T10:36:05+08:00",
  "verified_at": "2026-05-09T11:02:33+08:00",
  "review_started_at": "2026-05-09T11:02:34+08:00",
  "completed_at": null,

  "session_key": "session:opencode-dev:run:task-1715230800",
  "result": null,
  "error": null
}
```

> **存储位置（v2.2 修正）**: 写入 plugin 自有 sqlite 数据库 `~/.openclaw/extensions/openclaw-mao/data/tasks.db`（路径由 plugin 入口在 install/init 时建立，参照 `openclaw-mem0` 用 `sqlite-resilience.ts` 做 WAL + 锁重试 + schema 迁移）。**不写 mem0**，**也不直接写 OpenClaw core 的全局 memory**。
>
> v2.1 写的"`~/.openclaw/memory/tasks/<task-id>.json`"是凭空假设的路径，OpenClaw core memory 的内部布局对 plugin 不公开。Plugin 自有 sqlite 的好处：(a) schema 由 plugin 自己 own，可加索引、做事务性多行更新（业务子状态机要原子转换）；(b) 卸载 plugin 时数据连带清理；(c) `openclaw-mem0` 已验证此模式可行。
>
> 不写 mem0 的原因不变：mem0 自动归并机制会把 "task running"、"task completed" 等短期任务状态当长期事实归并入用户档案，污染长期 user memory，且容量也撑不住每天几十条任务的写入。

### 结果格式（v2.1 决议：JSON + summary）

Agent 完成后通过 sessions 输出回传以下结构（OpenClaw 解析后写入 memory `result` 字段）：

```json
{
  "task_id": "task-1715230800",
  "summary": "实现了 X 功能，新增 3 个 endpoint 和 7 个 unit test，修改 router/service/repo 三层。已 commit 并 push。",
  "branch": "agent/opencode-dev/task-1715230800",
  "commits": [
    {"sha": "a1b2c3d", "message": "feat: add X endpoint scaffolding"},
    {"sha": "e4f5g6h", "message": "feat: implement X service logic + tests"}
  ],
  "diffstat": {
    "files_changed": 7,
    "insertions": 342,
    "deletions": 89
  },
  "test_results": {
    "passed": 47,
    "failed": 0,
    "skipped": 2
  },
  "next_actions_suggested": [
    "review by Claude Code",
    "merge to main once approved"
  ]
}
```

`summary` 字段是 Claude Code / 用户读，其余字段供机器解析下一步动作。

---

## 5. 可观测性设计

### 5.1 统一 Dashboard

```
$ openclaw mao list

Task ID            │ Type    │ Agent         │ Branch                              │ Status      │ Last Active
───────────────────┼─────────┼───────────────┼─────────────────────────────────────┼─────────────┼─────────────
task-1715230800    │ bugfix  │ kimi-bugfix   │ agent/kimi-bugfix/task-1715230800   │ running     │ 2 min ago
task-1715230000    │ feature │ opencode-dev  │ agent/opencode-dev/task-1715230000  │ pushed      │ 15 min ago
task-1715229000    │ refactor│ opencode-dev  │ agent/opencode-dev/task-1715229000  │ failed (3x) │ 1 hr ago
task-1715228000    │ bugfix  │ kimi-bugfix   │ agent/kimi-bugfix/task-1715228000   │ verifying   │ 30 sec ago
```

### 5.2 日志查询

```bash
# 单任务完整链路
openclaw sessions history --label "task-1715230800"

# Agent 最近活动
openclaw sessions list --active-minutes 60

# 任务状态搜索
openclaw mao list --filter "status=running OR status=verifying"

# 验证失败的任务（行为层问题，需要人介入）
openclaw mao list --filter "verifying_failed"
```

### 5.3 告警 + 健康检查

由 HEARTBEAT.md 配置周期性检查（建议 5 分钟一次）：

```markdown
## Agent 任务监控

每 5 分钟检查：
- RUNNING 超过 30 分钟 → Discord STUCK 告警
- VERIFYING 卡住超过 5 分钟 → 强制降级到 FAILED
- FAILED 终态（retry 用尽） → Discord FAILED 告警
- VPS agent 进程存活 → 异常时 Discord 告警

每 1 小时检查：
- 孤儿 worktree（task 已结束但目录仍在）
- 孤儿 branch（无对应 task 但 agent/ 前缀分支存在）
- worktrees/ 总占用磁盘 > 5GB → 警告
```

---

## 6. 迁移计划（v2.2 plugin 化重排）

### Phase 0: API 探针 + plugin 骨架（Day 1，v2.2 新增）

**这是 v2.2 修订的核心新增 phase——先验证 §11 待验证项，再写功能代码。**

- [ ] 跑 `openclaw <subcommand> --help` 把 §11 表里所有待验证 API 拉清楚（`agent --cwd`、`agents add/bind` flag、cron hook、`ctx.tasks.create`、`ctx.runHostCommand`、`ctx.channels.send`）
- [ ] 用 `openclaw-mem0` 拷一份骨架，重命名为 `openclaw-mao`（manifest id、commandAlias=mao、kind=orchestrator、清空 mem0 业务代码）
- [ ] 跑通 `openclaw plugin install ./extensions/openclaw-mao/` 让 `openclaw mao --help` 列出空命令组
- [ ] 复用 `sqlite-resilience.ts` 建立 `tasks.db` schema（task 行字段见 §4 sqlite 结构）
- [ ] **任一关键 API 不可用** → 在本文件 §11 加 fallback 设计，回到这一步重新评估，不进 Phase 1

### Phase 1: 派发主链路（Day 2）

- [ ] plugin onInstall 中调 `openclaw agents add` 注册 opencode-dev / kimi-bugfix / orchestrator
- [ ] 实现 `openclaw mao dispatch / status / list / cancel / cleanup` CLI 命令骨架
- [ ] 实现并发 semaphore（max=3，配置项 `concurrencyLimit`）
- [ ] dispatcher.ts 跑通"单轮 `openclaw agent --message --json` → 返回 → 写 sqlite"最小循环
- [ ] 端到端测试：Claude Code → SSH → `openclaw mao dispatch` → agent 单轮派发 → sqlite 留痕

### Phase 2: Task Router + Worktree + 超时（Day 3-4）

- [ ] parser.ts（结构化前缀）+ classifier.ts（LLM 分类降级）
- [ ] dispatcher.ts 多步循环：把单轮 agent dispatch 串成 task-level run（含 worktree 创建、cwd 注入）
- [ ] verifier.ts 实现 VERIFYING 三项 git 校验
- [ ] type 分级超时检测
- [ ] 业务子状态机基础态（PENDING / DISPATCH / RUNNING / VERIFYING / PUSHED / FAILED / CANCELLED）+ 同步 TaskFlow.status
- [ ] tracker.ts 完成全部 sqlite 读写
- [ ] 端到端测试：派发 → 创建 worktree → agent 多轮执行 → push → 验证 → PUSHED

### Phase 2.5: Plan-mode gate + 链式 task（Day 5）

- [ ] plan-gate.ts（关键词 / type / 行数检测）
- [ ] chain.ts（基于 OpenClaw `parentTaskId` 解依赖、BLOCKED 子状态、级联取消）
- [ ] 业务子状态机加 BLOCKED 节点
- [ ] CLI 支持 `--plan-doc` / `--parent-task` 参数
- [ ] 端到端测试：refactor 任务无 plan-doc 被拒；A→B 链式正常解锁

### Phase 3: REVIEWING + Claude Code 集成（Day 6-7）

- [ ] reviewer-bridge.ts（review bundle 准备 + 写回 verdict）
- [ ] CLI 支持 `openclaw mao review-bundle / review-result`
- [ ] 业务子状态机加 REVIEWING 节点
- [ ] REVIEWING_FAILED retry 逻辑（feedback 回灌下一轮 agent prompt）
- [ ] 在项目 CLAUDE.md 加 `/review-task <id>` skill 定义
- [ ] 端到端测试：feature 任务 PUSHED → Discord 通知 → Claude Code review → verdict pass → COMPLETED；以及 fail → retry → 二次 fail → FAILED

### Phase 4: Merge 半自动 + 失败处理 + 监控（Day 8）

- [ ] `openclaw mao merge`（CI + diff + y/n）
- [ ] retry 逻辑（执行层 / review 层分别按 configSchema.retry 配置）
- [ ] timeout 检测（按 type 分级 + VERIFYING 5min + REVIEWING 无超时）+ TaskFlow.status=`timed_out` / `lost` 同步
- [ ] HEARTBEAT.md 监控规则
- [ ] Discord 告警通道（PUSHED 通知 / FAILED 告警 / STUCK 告警，通过 `ctx.channels.send`）

### Phase 5: 可观测性 + 清理（Day 9）

- [ ] `openclaw mao list` 统一视图（含 BLOCKED / REVIEWING 业务子状态 + TaskFlow.status 双列）
- [ ] worktree / branch 清理命令
- [ ] 孤儿资源检测脚本（cron hook 每小时）

### 总计

**预计 7-9 天**（v2.1 的 6-8 天 + Phase 0 API 探针 & plugin 骨架 +1 天）。Phase 0 是必要支出：v2.0/v2.1 估时省掉它的代价就是要重做 v2.2。

---

## 7. 风险与缓解（v2.2 更新）

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| **OpenClaw API 实际行为与 §11 假设不一致** (v2.2 新增) | 中 | Phase 1+ 推倒重来 | Phase 0 必须先把 §11 全部 ✅，任一不可用立刻在 v2.3 加 fallback，不进 Phase 1 |
| **`openclaw agent --cwd` 不支持** (v2.2 新增) | 中 | dispatcher 没法把 agent 锚到 worktree | fallback：plugin 进程内 `process.chdir()` 后再调 agent；或 prompt 里硬注入 cwd 提示 |
| **Plugin SDK 学习曲线 / 文档不全** (v2.2 新增) | 中 | 写不出能跑的 manifest | 直接 fork `openclaw-mem0` 改而不是从零写 manifest |
| SSH 链路中断 | 低 | 任务派不出去 | 本地 retry + 降级到 Discord 通道作为最后兜底 |
| Worktree 数量爆炸 | 中 | 磁盘满 | COMPLETED 自动 cleanup + 每日孤儿清理；总占用监控 |
| Branch 命名冲突 | 低 | task 创建失败 | task-id 用 unix timestamp 保证唯一 |
| Agent 反复 zero-commit | 中 | 业务子状态机卡 VERIFYING | VERIFYING 5min timeout 后 FAILED（TaskFlow.status=timed_out）+ Discord 告警 |
| LLM 分类器误判 | 中 | 任务派给错误 agent | confidence < 0.7 回问；用户可手动 reassign |
| Discord API 限流 | 低 | 通知延迟 | 仅作通知通道，主链路是 SSH 不受影响 |
| OpenClaw Gateway 重启 | 低 | 任务中断 | systemd `openclaw-gateway.service` 自动重启 + plugin sqlite 持久化，重启后从 sqlite 恢复业务子状态 |
| Agent compact 后丢工程纪律 | 中 | 写代码跳过 plan / 漏 push | v3 待补：compact 后自动 reload SKILL.md 与状态机文档 |

---

## 8. 成本估算（v2.2 更新）

| Phase | 内容 | 时间成本 | 运行成本 |
|-------|------|---------|---------|
| Phase 0 | API 探针 + plugin 骨架（v2.2 新增） | 1 天 | 无 |
| Phase 1 | 派发主链路（agents add + dispatch CLI + 单轮 agent invoke） | 1 天 | 无 |
| Phase 2 | Task Router + worktree + 超时 + 业务子状态机 | 1.5-2 天 | 无 |
| Phase 2.5 | Plan-mode gate + 链式 task（parentTaskId） | 1 天 | 无 |
| Phase 3 | REVIEWING + Claude Code 集成 | 1.5-2 天 | 无 |
| Phase 4 | Merge 半自动 + 失败处理 + 监控 | 1 天 | 无 |
| Phase 5 | 可观测性 + 清理 | 0.5-1 天 | 无 |
| **总计** | | **7-9 天** | **零额外运行成本** |

唯一会增加的运行开销：Claude Code review 阶段消耗 Opus 4.7 token（按 task 平均 50K 输入 + 5K 输出估算，每个 review ~$0.5-1）。考虑到这能拦住 pseudo-subgraph 类问题（一次 rework 浪费的人/agent 时间远超此），ROI 高。

---

## 9. 决议记录

### v1 → v2 收口

| v1 问题 | v2 决议 |
|---------|---------|
| Channel 选 Discord 还是 Telegram？ | SSH+CLI 主链路，Discord 仅通知 |
| 方案 A 还是 方案 B？ | 方案 B（SSH+CLI） |
| 任务分类规则？ | 结构化前缀 + LLM fallback (confidence < 0.7 回问) |

### v2 → v2.1 收口（用户 2026-05-09 拍板）

| 决议项 | 决定 | 落地章节 |
|-------|-----|---------|
| 1. 并发上限 | **3 个** agent 同时跑；BLOCKED 不占名额 | §3.1.1 |
| 2. 任务超时 | **按 type 分级**：bugfix 15min / feature 60min / refactor 120min；priority:high 各档 +50% | §3.2.2 |
| 3. Merge 策略 | **CLI 半自动**：`openclaw mao merge` → 自动 CI + 显 diff → 用户 y/n | §3.4 |
| 4. Plan-mode | **强制**：命中关键词时拒绝直接派 impl，必须先 plan-doc 任务评审通过 | §3.2.2 |
| 5. 结果格式 | **JSON + summary 字段**：JSON 主体供机器解析，summary 供人读 | §4 |
| 6. 跨 agent 协作 | **v2.1 加链式 task**（线性链 ≤5），完整 DAG 留 v3 | §3.2.3 |
| 7. **Claude Code 最终审查者** | **REVIEWING 阶段**：feature/refactor/plan-doc 强制；触发=手动 pull（Discord 通知 → 用户输 `/review-task <id>`）；retry ≤1 | §3.2.4 |

### v2.1 仍开放（留给 v3）

1. **完整 DAG 任务编排**: fan-out / fan-in 依赖图（v2.1 仅支持线性链）
2. **Auto-merge 配合 CI**: 当 review verdict=pass 且 CI 全绿时自动 merge（v2.1 仍要用户 y/n）
3. **Pseudo-subgraph contract 检查器**: Task Router 强制检查"测试是否真的覆盖契约"而非只看测试通过率
4. **Compact 后自动 reload SKILL.md**: 解决 mem0 中"compact 后丢工程纪律"的踩坑
5. **多个 reviewer**: 当前只让 Claude Code review；将来可加 OpenCode review feature plan、KimiCode review bugfix 等多人评审

---

## 10. 评审请求

请各 agent 从以下维度评审本方案：

### 架构评审
- 拓扑设计是否合理？
- 是否有单点故障？
- 扩展性是否足够（加新 agent 时多大成本）？

### 实现评审
- 配置项是否完整？
- 是否有遗漏的边界情况？
- 代码实现复杂度是否可控？

### 运维评审
- 日志和监控是否足够？
- 故障恢复流程是否清晰？
- 日常维护成本是否可接受？

### 安全评审
- Agent 间通信是否有越权风险？
- 任务分发是否有注入风险（CLI 参数转义）？
- 是否需要审计日志？

### Plugin 化对齐评审（v2.2 新增）

请评审人对照 §3.0 / §3.5 / §11，检查：
- `openclaw-mao` 的责任边界是否切得干净（哪些应该归给 OpenClaw core，哪些归 plugin）
- manifest configSchema 是否覆盖了运维参数（concurrency / timeouts / planGate keywords / review types）
- §11 中标"待验证"的 API 是否影响整体设计成立（任一关键 API 不存在时，是否需要 v2.3 fallback）

### 历史踩坑回顾（v2.2 更新）

请评审人特别注意是否完整覆盖了以下历史踩坑：

| 踩坑 | v2.2 覆盖情况 |
|------|-------------|
| zero-commit completion antipattern（agent 自报 done 但没 push） | ✅ §4 VERIFYING 节点强制 git 校验 |
| branch-per-agent / worktree 隔离 | ✅ §3.4 重写代码同步策略 |
| pseudo-subgraph（test 通过但 contract 失败） | ✅ §3.2.4 REVIEWING 阶段由 Claude Code 做契约审查（verdict.checks.no_pseudo_implementation） |
| DI wiring 没接对但单测通过 | ✅ §3.2.4 REVIEWING（verdict.checks.di_wiring_correct） |
| agent 跳过 plan 直接写代码（出现 4 次） | ✅ §3.2.2 Plan-mode 强制 gate |
| compact 后丢失工程纪律（plan §8 类章节） | ⚠️ 暂未覆盖，v3 在 SKILL.md 加自动 reload 机制 |
| 多 agent 并行时改 main 互相冲突 | ✅ §3.4 worktree 物理隔离（每 agent 独立 branch） |
| 长 task 静默卡死 | ✅ §3.2.2 type 分级超时 + §5.3 STUCK 告警 |
| **真空假设：把 OpenClaw 当空白通信层** | ✅ §3.0 plugin 化分层 + §11 API 验证表（v2.2 修正） |

---

## 11. OpenClaw API surface 验证表（v2.2 + 2026-05-09 12:30 Phase 0 探针完成）

本节列出 v2.2 设计依赖的所有 OpenClaw API。**Phase 0 已在 VPS (OpenClaw 2026.5.7) 跑完 `openclaw <subcommand> --help` 全部探针**，下表为最终验证结果。任一未通过的项已配对 fallback。

### ✅ 已验证（探针通过，可直接采用）

| API / 行为 | 用途 | 探针结果 |
|-----------|------|---------|
| `openclaw.plugin.json` manifest 格式 | plugin 注册 | `/home/admin/.openclaw/extensions/openclaw-mem0/openclaw.plugin.json` 中已有完整范例 |
| `commandAliases: [{name, cliCommand}]` | `openclaw mao <verb>` CLI 路由 | mem0 plugin 注册 `mem0` 命令成功；mao plugin 实测同样有效 |
| **`api.registerCli(handler, { descriptors: [{name, description, hasSubcommands}] })`**（v2.2-r2 实测） | plugin loader 决定是否调用 handler | matrix plugin 内置 reference (`/home/admin/.npm-global/lib/node_modules/openclaw/dist/cli-metadata-*.js`)；缺 descriptors → handler 静默 skip → `openclaw mao` unknown command；mem0 旧 SDK 有兼容路径不需要，新 plugin 必填 |
| `api.registerService({id, start, stop})` | 后台 STUCK / 孤儿清理 service | mem0 plugin 已用 |
| `api.registerTool(definition, metadata?)` | LLM tool-calling 入口（contracts.tools 对应） | SDK .d.ts 暴露 |
| `api.on(event, handler)` | 订阅 plugin lifecycle / agent 事件 | mem0 用 `before_prompt_build` / `agent_end`，可作 plugin lifecycle hook |
| `api.resolvePath(p)` | plugin data 路径解析（sqlite 落盘点） | SDK .d.ts 暴露 |
| `api.pluginConfig` | 读取 manifest configSchema 的运行时值 | mem0 plugin 已用 |
| `contracts.tools` LLM tool-calling 名单 | orchestrator agent 自然语言派发时调用 | mem0 注册 8 个 memory_* tools 已生效 |
| `kind` 标识 | plugin 分类 | mem0: `kind: "memory"`；mao 拟用 `kind: "orchestrator"` |
| `configSchema` JSON Schema | 用户可调参数 | mem0 用 configSchema 暴露 mode/apiKey/topK 等 |
| Skills = markdown-only | SKILL.md 仅文档 | `openclaw skills *` 子命令仅 list/inspect，无注册可执行代码入口 |
| **TaskFlow.status 枚举** (queued / running / succeeded / failed / timed_out / cancelled / lost) | 业务子状态映射目标 | `openclaw tasks --status <name>` flag 列出完全相同枚举，§4 映射表 100% 对齐 |
| **TaskFlow runtime 分类**（subagent / acp / cron / cli） | plugin 派任务归类 | `openclaw tasks --runtime <kind>` 暴露；mao 派的 task 落 `subagent` 或 `cli` |
| **`openclaw tasks flow/audit/list/show/cancel/maintenance/notify`** 子命令 | 检视、取消、审计 TaskFlow | 全部子命令存在，外部 dashboard 直接用 `openclaw tasks list` |
| `openclaw agents add/bind/bindings/delete/list/set-identity/unbind` | plugin install 时批量注册 agent | 七个子命令完整存在 |
| **`openclaw agent --session-id <id>`**（v2.2 探针意外发现） | **dispatcher 多 turn 由 OpenClaw session 维持，不必自驱循环** | `--session-id` 直接列在 `openclaw agent --help`；§3.4 dispatcher 据此简化 |
| `openclaw agent --json --message --agent` | 单 turn 派发 | 完整存在 |
| `openclaw cron add/edit/enable/disable/list/run/runs/show/status` | STUCK 检测、孤儿清理 cron | 完整子命令；plugin onInstall 调 `cron add` 注册定时任务 |
| `openclaw plugins install <path>` 支持本地路径 | plugin 开发期反复装 | 子命令存在，可装 path/archive/npm/git/clawhub/marketplace |
| `openclaw channels add/list/login/status/...` | Discord 通知通道 | 完整子命令；具体 plugin SDK 推送 API 见下文待验证项 |
| Plugin sqlite 持久化 | 业务子状态、retry、review verdict | `openclaw-mem0/sqlite-resilience.ts` 已验证可用 |

### ❌ 探针不通过 → fallback（v2.2 设计已落地）

| API / 行为 | 探针结果 | 已采用的 fallback |
|-----------|---------|------------------|
| `openclaw agent --cwd <path>` | **不支持**。`openclaw agent --help` 中无此 flag | §3.4 改用 child_process worker：每个 task 起独立 worker，worker 内 `process.chdir(worktree)` 后调 host CLI，子进程继承 cwd |

### ❌ 探针不通过（Phase 0 已读 SDK .d.ts 确认）→ 全部 fallback 已落地

| API / 行为 | 实测结果 | 已采用的 fallback |
|-----------|---------|------------------|
| `ctx.runHostCommand` 或 SDK 程序化调 host CLI | SDK 不暴露 | `child_process.spawnSync("openclaw", [...])`，setup 阶段在 `register(api)` 内同步执行；幂等 |
| SDK TaskFlow 写入 API | SDK 不暴露；`openclaw tasks` 也无 `create` 子命令 | 通过 `openclaw agent --message ...` 派发，OpenClaw 自动以 `runtime: subagent` 注册 TaskFlow（**Phase 1 必须实测确认**：派发后 `openclaw tasks list` 是否真的看到该 task） |
| SDK Channel send API | SDK 不暴露 | `child_process.spawn("openclaw", ["message", "send", "--channel", "discord", "--target", channelId, "--message", msg])` |
| Plugin onInstall hook | SDK 不存在（只有 `register(api)`） | 在 `register(api)` 内做幂等 setup（检查 sqlite schema、按需 spawn `agents add`）；这就是延迟初始化 |
| `hooks install` 命令 | 已 deprecated | hook 跟 plugin 一起装走 `openclaw plugins install`；`openclaw hooks list` 仍可查 |

### ⚠️ 仍需进 Phase 1 day 2 时实测的细节

| 行为 | 用途 | 验证方法 |
|------|------|---------|
| `openclaw agent --message ...` 派发后是否自动产生 TaskFlow | 让 `openclaw tasks list` 看到 mao 派的 task | Phase 1 派一个 stub 任务，跑 `openclaw tasks list --runtime subagent --json` 检查 |
| cron hook 通过 plugin 注册的形式 | STUCK 检测 / 孤儿清理 cron | `openclaw cron add` 在 plugin `register()` 内 spawn 调，配 `--command "openclaw mao monitor-tick"` 自调 |
| `process.chdir()` 在 plugin 进程内是否影响其他 plugin | dispatcher worker 隔离方案 | Phase 2 实测；如有干扰则改 `child_process.fork()` 起独立 worker |

### 实施顺序（更新）

**Phase 0 已完成**（2026-05-09 12:30 探针 + 13:00 plugin 骨架装上跑通）：
- 8 项 API 探针完成
- 1 项关键 fallback 落地（`agent --cwd` 不存在 → child_process worker chdir）
- 复数命名修正（`tasks` 而非 `task`）
- `--session-id` 简化 dispatcher
- **descriptors 必填发现** + 入口范例对齐 SDK 真实签名（`definePluginEntry` + `register(api)`，无 onInstall/cli/hooks 顶层字段）
- VPS 上 `openclaw mao --help` + `openclaw mao dispatch ... --json` 全 OK

**Phase 1 day 2 入口任务**（按 §6 Phase 1 列表）：plugin onInstall 中调 `openclaw agents add`（实际改为 `register(api)` 内 spawn）+ 实现 dispatch / status / list / cancel / cleanup CLI 真实逻辑 + sqlite tracker schema + 并发 semaphore + dispatcher 跑通"单轮 `openclaw agent --session-id --message --json` → 写 sqlite"循环 + e2e 测试。

---

*v2.2 文档结束。请评审人对照 §3.0 责任分层、§3.5 plugin 骨架、§11 API 验证表给意见；尤其 §11 待验证项哪些必须 Phase 1 之前就拍板。*
