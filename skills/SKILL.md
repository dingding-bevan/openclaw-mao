---
name: mao-task-router
description: Multi-Agent Orchestrator — task classification, dispatch routing, plan-mode gating rules
---

# MAO Task Router

This skill is consulted by the orchestrator agent when dispatching tasks. The actual execution
(parsing, dispatch, verifying) is in the `openclaw-mao` plugin entry — this file only holds
the rules a human or LLM should follow when constructing a task.

## Structured prefix syntax (preferred over natural language)

```
TASK:bugfix   | <description> | priority:<high|medium|low> [| branch:<name>]
TASK:feature  | <description> | priority:<...>             [| branch:<name>]
TASK:refactor | <description> | priority:<...>             [| branch:<name>]
STATUS        | <task-id>
CANCEL        | <task-id>
LIST          [| filter:<running|failed|...>]
```

Structured prefix → zero-misclassification dispatch. Natural language → orchestrator agent
falls back to LLM classification (confidence ≥ 0.7 dispatches; < 0.7 asks for confirmation).

## Plan-mode gate

Refuse to dispatch as `impl` when description contains any of:
`重构 / 迁移 / 替换 / refactor / migrate / replace / 框架替换`, OR `--lines >= 200`,
OR `--scope multi-file`, OR `type == refactor`.

Force the user to dispatch a `plan-doc` task first, then a follow-up `impl` task carrying
`--plan-doc <path>`.

## Branch naming

`agent/<agent-id>/task-<unix-timestamp>` (auto-generated unless `branch:` is specified).
