# openclaw-mao

Multi-Agent Orchestrator plugin for OpenClaw.

**Status**: Phase 0 skeleton — all CLI subcommands return `{ status: "not_implemented" }` JSON.
See `multi-agent-collaboration-proposal.md` (v2.2-r1) §6 for the phase plan.

## Phase 0 deliverables (this skeleton)

- `openclaw.plugin.json` — manifest with `commandAliases: [{ name: "mao" }]` + configSchema
- `index.ts` — `definePluginEntry({ register(api) })` plugin entry; logs registration + wires CLI
- `cli/commands.ts` — 8 stub subcommands: `dispatch / status / list / cancel / cleanup / merge / review-bundle / review-result`
- `skills/SKILL.md` — markdown-only skill describing task router rules

## Build + install

```bash
cd /home/admin/.openclaw/extensions/openclaw-mao
npm install
npm run build      # tsup → dist/index.js
openclaw plugins install /home/admin/.openclaw/extensions/openclaw-mao/
openclaw mao --help
```

Expected output: 8 stub subcommands listed; each returns `not_implemented` JSON when invoked.

## Phase 1+ roadmap

Phase 1 day 2: replace stubs with real logic — sqlite tracker, dispatcher with `child_process` chdir +
`openclaw agent --session-id` multi-turn, concurrency semaphore, agent-add via onInstall.

Phase 2: worktree + verifier + plan-gate + chain.

Phase 3: reviewer-bridge + Claude Code `/review-task` integration.

Phase 4: semi-auto merge + retry policy + STUCK detection (registerService + cron).

Phase 5: dashboard + orphan cleanup.
