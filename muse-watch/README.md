# muse-watch

A tiny Linux daemon for the **Muse side** of Backseat. It keeps a read-only
mirror of the bridge repo and maintains two small files:

- `state.json` — every task's queue (`pending`/`active`/`done`), state,
  progress note, heartbeat, and timeout-as-state flags (`late_watch`,
  `completed_late`, `checkpoint_branch`), plus a `health` envelope
  (`last_ok_at`, `consecutive_failures`) rewritten every poll cycle so
  staleness is detectable. Rewritten on every cycle, not just on change.
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
./install.sh health             # healthcheck every installed watcher (exit 1 if any stale)
./install.sh stop               # stop all watchers
```

## Staleness detection (0.9.14)

A dead watcher used to be indistinguishable from a quiet bridge — nothing
noticed (bug 4, Oct 2026). Now `state.json` carries a health envelope
(`health.status` / `last_ok_at` / `consecutive_failures` / `last_error`,
plus `expected_interval_sec`) that is rewritten **every poll cycle**, so
a `last_ok_at` that stops moving means the daemon died even when no task
changed. `healthcheck.sh <watchdir>` exits 1 with a reason in that case:

```bash
./healthcheck.sh ~/.backseat/muse-watch/darek225-MYbackseat
# OK: last poll 12s ago, status=ok
```

For unattended alerting, install the systemd timer (user units, no root):

```bash
mkdir -p ~/.config/systemd/user
cp systemd/backseat-watch-health@.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now backseat-watch-health@darek225-MYbackseat.timer
systemctl --user list-timers | grep backseat
```

Check the timer's history with `journalctl --user -u backseat-watch-health@<slug>.service`.
A non-zero exit there means the watcher needs attention
(`./install.sh <repo>` reinstalls; see also `watch.log` in the watcher dir).

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
