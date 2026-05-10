# openclaw-mao Onboarding

Minimum-friction guide to install, configure, and operate `openclaw-mao` on a fresh
OpenClaw host. If you're returning after a break, jump to [Daily ops](#daily-ops).

---

## 1. Prerequisites

- **OpenClaw** ≥ 2026.4.24 (`openclaw --version`). The plugin uses the `definePluginEntry`
  SDK shape and `--dangerously-force-unsafe-install`, both first available in this version.
- **Node.js** ≥ 20 (for `better-sqlite3` prebuilt binaries). Verify: `node --version`.
- **Git** ≥ 2.20 with `worktree` support. Verify: `git worktree --help`.
- **A workspace git repo** that mao will create worktrees inside. It must:
  - have a `main` branch
  - have an `origin` remote (for `verifyMode=git`)
  - be writable by the user the OpenClaw gateway runs as
  - For dev/e2e: a bare local repo + a clone is enough. See [Set up a test workspace](#set-up-a-test-workspace).

---

## 2. Install

```bash
# 1. Clone into OpenClaw's extensions dir (or anywhere; path is what matters)
git clone <repo-url> ~/.openclaw/extensions/openclaw-mao
cd ~/.openclaw/extensions/openclaw-mao

# 2. Install deps + build
npm install                           # ~10s
npm run build                         # tsup → dist/index.js (~60KB)

# 3. Register with OpenClaw
openclaw plugins install ~/.openclaw/extensions/openclaw-mao/ \
  --force --dangerously-force-unsafe-install

# 4. Restart the gateway so the plugin loads
systemctl --user restart openclaw-gateway.service     # USER unit, not system
sleep 4 && systemctl --user is-active openclaw-gateway.service     # should print: active

# 5. Verify
openclaw mao --help                   # should list 14 subcommands
openclaw plugins doctor               # mao should appear without diagnostics
```

> ❗ The `--dangerously-force-unsafe-install` flag is **mandatory**. mao spawns `openclaw agent`,
> `git`, and `openclaw message send` via `child_process`, and OpenClaw's plugin loader
> static-analyzes for that. Without the flag, install is blocked. This is intentional from
> OpenClaw — you're attesting that you trust this plugin's source. Audit
> `dispatcher.ts` / `setup.ts` / `merger.ts` / `notifier.ts` if you need to re-verify.

---

## 3. Configure

Configuration lives in `~/.openclaw/openclaw.json` under
`plugins.entries.openclaw-mao.config`. Set keys with `openclaw config set`:

```bash
# Required if your workspace isn't ~/.openclaw/workspace
openclaw config set plugins.entries.openclaw-mao.config.workspaceRoot /path/to/your/workspace

# Optional but recommended
openclaw config set plugins.entries.openclaw-mao.config.discordChannel <your-discord-channel-id>
openclaw config set plugins.entries.openclaw-mao.config.verifyMode git    # or "skip" for dev
openclaw config set plugins.entries.openclaw-mao.config.concurrencyLimit 3

# Restart so plugin re-reads config
systemctl --user restart openclaw-gateway.service
```

Full key list and defaults: see `README.md` → "Configuration reference".

### Set up a test workspace (dev only)

```bash
mkdir -p /tmp/mao-test-origin.git && (cd /tmp/mao-test-origin.git && git init --bare -b main)
cd /tmp && git clone /tmp/mao-test-origin.git mao-test-workspace
cd mao-test-workspace
git config user.email mao-e2e@local && git config user.name mao-e2e
echo "# test workspace" > README.md
git add . && git commit -m "init" && git push -u origin main

# Point mao at it + skip verify (no real `git push` happens in tests)
openclaw config set plugins.entries.openclaw-mao.config.workspaceRoot /tmp/mao-test-workspace
openclaw config set plugins.entries.openclaw-mao.config.verifyMode skip
systemctl --user restart openclaw-gateway.service
```

---

## 4. One-time setup

```bash
openclaw mao setup
```

This:
1. Verifies the external CLIs `kimi` and `opencode` are reachable on PATH and respond to
   `--version` (PATH augmented with `/home/admin/.local/bin:/home/admin/.npm-global/bin` at
   spawn time).
2. **Cron is currently skipped** with a clear reason: OpenClaw's cron only supports
   `--agent --message` payloads, not raw shell commands like `openclaw mao monitor-tick`.
   Schedule it manually via host crontab if you want periodic STUCK detection:
   ```cron
   */5 * * * * /home/admin/.npm-global/bin/openclaw mao monitor-tick >/dev/null 2>&1
   ```

Verify:
```bash
openclaw mao setup                    # cli.ok=true and cron.skipped=true
kimi --version                        # confirms Kimi Code CLI works
opencode --version                    # confirms OpenCode CLI works
```

---

## 5. Daily ops

### Dispatch a task

```bash
# Flag-style
openclaw mao dispatch --type feature --description "Add /v2/users/search endpoint" --priority high

# Or structured prefix (orchestrator-friendly)
openclaw mao dispatch --prefix "TASK:feature | Add /v2/users/search endpoint | priority:high"
```

The prefix form supports: `priority:`, `branch:`, `plan-doc:`, `parent:`, `review:1`. Test
parses without dispatching:

```bash
openclaw mao parse "TASK:refactor | extract auth to its own module | priority:high | plan-doc:docs/auth-refactor.md"
```

### Watch progress

```bash
openclaw mao dashboard                # active tasks only (table)
openclaw mao dashboard --all          # include terminal states
openclaw mao dashboard --agent kimi --json
openclaw mao status <task-id>         # full sqlite row
```

### Review (when a task hits `reviewing`)

```bash
openclaw mao review-bundle <task-id>  # → JSON: task row, git diff, plan-doc, agent result, contract-check hints
# Read it. Then either:
openclaw mao review-result <task-id> --verdict pass --feedback "shipped"
openclaw mao review-result <task-id> --verdict fail --feedback "missing input validation; add Joi schema"
openclaw mao review-result <task-id> --verdict needs-clarification --feedback "what's edge-case A you mentioned?"
```

`fail` with retry budget remaining → resume turn with feedback prepended; agent may
`DONE:` (back to `reviewing`) or `CLARIFY:` (`awaiting_clarification`). Reply via
`mao continue <id> --message "..."`.

### Merge

```bash
openclaw mao merge <task-id> --dry-run    # only show diff stat + commits
openclaw mao merge <task-id>              # ff-only + push + cleanup worktree+branch
openclaw mao merge <task-id> --no-cleanup # keep worktree+branch
```

Best-effort `npm test` runs if `package.json` exists in the worktree (60s timeout). CI
failure aborts merge.

### Housekeeping

```bash
openclaw mao monitor-tick             # one-shot scan; cron also runs this every 5min
openclaw mao prune                    # dry-run: list orphan worktrees + branches
openclaw mao prune --apply            # actually remove them
openclaw mao cancel <task-id>         # cancel an active task
openclaw mao cleanup <task-id>        # remove worktree+branch (terminal tasks only)
```

---

## 6. Known gotchas

These were learned the hard way during Phase 0–5; check here first when something feels
off.

### Cold-start latency
- `openclaw <anything>` takes ~14s on first invocation (plugin loading). All test scripts
  must use timeouts ≥ 30s. `mao setup` runs ~60s because it spawns multiple host CLI
  calls in sequence.

### `register(api)` discipline
- **Never call `spawnSync` (or anything that blocks) inside `register(api)`.** OpenClaw
  loads the plugin in-process; if `register` spawns a child `openclaw` it will load this
  plugin again and recurse infinitely. All host-CLI calls live inside subcommand
  `.action()` callbacks (so they only run when a CLI is invoked). That's why `mao setup`
  is a subcommand, not an `onInstall` hook (the SDK has no such hook anyway).

### `descriptors` is mandatory
- `api.registerCli(handler, { descriptors: [{ name, description, hasSubcommands }] })`
  — the second argument is required. Without `descriptors` the handler is silently
  skipped and `mao` becomes "unknown command". Symptom: `openclaw plugins doctor` reports
  `cli registration missing explicit commands metadata`. The mem0 plugin (older SDK) works
  without it via a back-compat path; new plugins do not.

### `agents add` flag set
- `openclaw agents add` accepts `--non-interactive --workspace --model` (and `--bind`,
  `--agent-dir`). It does **not** accept `--description`. Set descriptions afterwards via
  `openclaw agents set-identity`.

### Session-id format
- `openclaw agent --session-id <id>` rejects colons. Use `mao-<task-id>`, never
  `mao:<task-id>`. Symptom: `Invalid session ID`.

### `openclaw agent` has no `--cwd`
- `openclaw agent --help` does not list `--cwd`. mao's dispatcher works around it by
  starting the spawn with `child_process` `cwd:` option set to the worktree path; the
  child OpenClaw process inherits it. If you ever see "agent ran in the wrong directory",
  that's the symptom.

### TaskFlow does not auto-create
- `openclaw agent --message ...` does **not** automatically create an OpenClaw TaskFlow
  row. mao tasks live entirely in the plugin sqlite (`data/tasks.db`); they will not
  show in `openclaw tasks list --runtime subagent`. The status mapping in the design doc
  is reference-only.

### systemd unit is USER-level
- The gateway runs as `systemctl --user`, not system-wide. `sudo systemctl restart
  openclaw-gateway.service` will fail with "Unit not found". Old mem0 memory may suggest
  PM2 or `sudo` — both are wrong.

### TS dts build under `strict: false`
- `tsup --dts` rejects discriminated-union narrowing (`{ok:true; X} | {ok:false; error}`)
  even with `strict: false`. Use flat optional fields (`{ok:boolean; X?; error?}`)
  instead. The build will error at the `--dts` stage, not the `--esm` stage.

### CLI cold-start dominates short tests
- Don't try to race a `mao dispatch` against a `mao status` poll in a single shell — the
  dispatch CLI doesn't return until the agent turn finishes (~28s+). For race tests
  involving `BLOCKED` you need a background dispatch. Or just use sqlite directly via
  `better-sqlite3` to seed test rows.

### `openclaw plugins inspect` lies about commands
- `Commands: mao` in `plugins inspect` output is reported even if the handler never ran
  (e.g. missing `descriptors`). Always cross-check with `openclaw mao --help` to see
  whether the command is actually wired up.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `openclaw mao` → "unknown command" | Plugin didn't load. Gateway not restarted, or `descriptors` missing. | `systemctl --user restart openclaw-gateway.service`; check `plugins doctor` |
| `mao setup` errors with `unknown option '--description'` | OpenClaw version too old | Upgrade OpenClaw to ≥ 2026.4.24 or hand-edit `setup.ts` to match your `agents add` flags |
| `sub_status` stuck on `running` long after the agent should be done | Agent looping or no DONE/CLARIFY prefix | Wait for `stuckHeartbeatMin` cron, or `mao cancel <id>` |
| `mao merge` fails with `commits_not_pushed` | Working tree had unpushed commits when verifier ran (but verifier should have caught this earlier) | Check `verifyMode`. If it's `skip`, switch to `git` for production. |
| Discord notifications not arriving | `discordChannel` unset, or `openclaw message send --channel discord` not configured | `openclaw config set plugins.entries.openclaw-mao.config.discordChannel <id>`; verify `openclaw channels list` shows discord |
| `mao dispatch` instantly fails with "plan-mode gate triggered" | Description matched a `planGateKeywords` entry or `type=refactor` without `--plan-doc` | Either pass `--plan-doc <path>` or rephrase description |

---

## 8. Where to look in the code

| Question | File |
|---|---|
| What's a task row schema? | `tracker.ts` — `TaskRow` interface + `SCHEMA` |
| How does the multi-turn loop work? | `dispatcher.ts` — `runTurnLoop` + `handleTurnOutcome` |
| What does `verifyMode=git` actually check? | `verifier.ts` — `Verifier.verify` (status/rev-list/ls-remote) |
| How do chained tasks work? | `chain.ts` — `shouldBlockOnInsert`, `validateAncestry`, `afterParentTerminal` |
| What goes into a review bundle? | `reviewer-bridge.ts` — `prepareBundle` |
| What does monitor scan? | `monitor.ts` — `Monitor.tick` |
| How does prune detect orphans? | `prune.ts` — `Pruner.prune` |
| How is a plugin command registered? | `index.ts` — `api.registerCli(({program}) => ..., { descriptors: [...] })` |

---

## 9. Upgrading

```bash
cd ~/.openclaw/extensions/openclaw-mao
git pull
npm install                    # only if package.json changed
npm run build
openclaw plugins install ~/.openclaw/extensions/openclaw-mao/ --force --dangerously-force-unsafe-install
systemctl --user restart openclaw-gateway.service
```

If the schema version bumped (look for a new entry in `tracker.ts:SCHEMA`), the migration
runs automatically on first plugin load. Existing sqlite rows are preserved.

---

## 10. Uninstall

```bash
openclaw plugins uninstall openclaw-mao
systemctl --user restart openclaw-gateway.service

# Clean up state (sqlite tasks db + worktrees, if you don't want to keep them)
rm -rf ~/.openclaw/extensions/openclaw-mao/data
# Worktrees and branches in your workspaceRoot are still there;
# `mao prune --apply` would have done it but is no longer available, so:
cd $WORKSPACE_ROOT && git worktree list | awk '/^.*\/worktrees\//{print $1}' | xargs -I{} git worktree remove --force {}
git branch | grep '^  agent/' | awk '{print $1}' | xargs git branch -D
```
