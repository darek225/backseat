# muse-watch

A tiny Linux daemon for the **Muse side** of Backseat. It keeps a read-only
mirror of the bridge repo and maintains two small files:

- `state.json` — every task's queue (`pending`/`active`/`done`), state,
  progress note, and heartbeat. Rewritten only when something changes.
- `events.log` — append-only transition log (`task-x: running -> success`),
  trimmed to the last 200 lines.

## Why

Polling the bridge with `git pull` + parsing JSON costs Muse real tokens on
every check, and a cron that wakes an agent every few minutes just to say
"still running" is pure burn. With the watcher, a status check is one small
file read, and a completion-watch cron wakes, reads one file, and goes back
to sleep.

## Install

```bash
./install.sh <owner/repo>      # e.g. ./install.sh darek225/MYbackseat
./install.sh status             # daemon + state freshness
./install.sh stop               # stop all watchers
```

Installs to `~/.backseat/muse-watch/<slug>/`. Needs only `git` and `python3`.
No systemd, no cron, no root — it runs as a background process with a
pidfile. Re-run `install.sh <repo>` after a reboot (idempotent; won't double-start).

The mirror is disposable: delete the directory any time, reinstall to rebuild.

## How Muse uses it

- **Status checks:** read `~/.backseat/muse-watch/<slug>/state.json`. Never
  `git pull` the bridge for status.
- **Completion watches:** a cron whose body is "read state.json; if the task
  is terminal, report and remove yourself; else stay silent."
- **Queueing tasks:** still use your normal working clone for commits/pushes.
  The watcher's mirror is read-only — never point task-writing work at it.
