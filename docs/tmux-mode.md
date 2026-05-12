# tmux mode (Wave 3+)

## Attach a running task

```bash
mao open <task-id>
# Outputs one line:
ssh -t admin@47.85.199.78 "tmux attach -t mao-uvcmvj"
```

## Detach (keep session running)

Inside tmux: `Ctrl-b`, then `d`

## Kill session manually

```bash
ssh admin@47.85.199.78 "tmux kill-session -t mao-uvcmvj"
```

## tmux cheatsheet

| Shortcut | Action |
|----------|--------|
| `Ctrl-b d` | detach (back to ssh) |
| `Ctrl-b [` | scroll mode (q to exit) |
| `Ctrl-b PgUp` | scroll up history |
| `Ctrl-b c` | new window (advanced) |
| `Ctrl-b ?` | tmux help inside |

## VPS workbench (direct attach without ssh)

On the VPS workbench shell, just run:

```bash
tmux attach -t mao-uvcmvj
```

## Lifecycle

- Created at dispatch time (auto mode)
- Survives agent process exit
- Auto-killed 60 min after task reaches terminal state (configurable via plugin config `tmuxRetentionMin`)
- Manually killable via `tmux kill-session` any time
