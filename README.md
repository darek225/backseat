# Muse ↔ Cline GitHub Bridge

An agentic loop between two AIs, using GitHub as the only bridge:

- **Muse** (Meta's personal agent, this is me) acts as the **architect**.
  You chat with me on your phone. I break work into tasks, write the exact
  prompts Cline should run, and queue them in a GitHub repo.
- **Cline** (running on your Windows PC, powered by your DeepSeek key) acts
  as the **builder**. A small watcher script on your PC polls the repo,
  runs `cline --yolo "<prompt>"` headlessly, and pushes status and results
  back to the repo.
- **You** get a portal: ask me for status, queue new work, or change plans
  from chat. I poll the repo on a schedule and report back.

No open ports. No shared API keys. No direct connection between my machine
and your PC — GitHub is the only channel.

## Architecture

```
┌─────────────────────┐        ┌──────────────────┐        ┌─────────────────────┐
│  Muse (cloud VM)    │        │  GitHub repo     │        │  Your Windows PC    │
│                     │        │  (bridge repo)   │        │                     │
│  chat with Darek    │        │                  │        │  watcher.py         │
│        │            │        │  tasks/pending/  │        │    polls every ~20s │
│        ▼            │ push   │  tasks/active/   │  pull  │        │            │
│  write task JSON ──────────▶│  tasks/done/     │◀────── │  claim task         │
│                     │        │  tasks/status/   │        │        │            │
│  cron poll ◀────────────────│  (status+logs)   │◀────── │  run cline --yolo   │
│        │            │ pull   │                  │  push  │        │            │
│        ▼            │        │                  │        │  push status/logs   │
│  report to Darek    │        │                  │        │        ▼            │
│  in chat            │        │                  │        │  next task...       │
└─────────────────────┘        └──────────────────┘        └─────────────────────┘
```

Task lifecycle: `pending` → `active` → `done`.
Live progress (heartbeats, log tails) goes to `tasks/status/<id>.json`
so Muse can report status without waiting for completion.

## Repo layout (the bridge repo on GitHub)

```
bridge-repo/
├── tasks/
│   ├── pending/      # tasks queued by Muse, waiting for the PC
│   ├── active/       # claimed by the watcher (one at a time)
│   ├── done/         # finished (success or failure)
│   └── status/       # live status JSON per task id
├── prompts/          # optional: reusable prompt templates
└── README.md         # this file's PC/agent setup summary
```

Exact file formats are documented in [protocol.md](protocol.md).

## Setup

### 1. Create the bridge repo

Create a new **private** GitHub repo (e.g. `darek/muse-cline-bridge`).
Private is recommended since task contents may include project details.

Clone it in two places:

- On your PC: `C:\Users\<you>\muse-cline-bridge`
- On Muse's machine: I handle this side myself.

### 2. PC side (Windows)

Prerequisites: Python 3.10+, Git, VS Code with the Cline extension,
and the Cline CLI installed and authenticated (`cline auth` or API key
configured — your DeepSeek key stays in Cline's own config on your PC).

```bat
cd C:\Users\<you>\muse-cline-bridge
copy pc\config.example.json pc\config.json
notepad pc\config.json
pc\setup.bat
python pc\watcher.py
```

See [pc/README section below](#pc-side-details) and `pc/config.example.json`
for options. Keep the watcher running while you want the loop active
(a terminal window, or Task Scheduler for autostart).

### 3. Muse side (agent)

I poll the repo on a schedule (cron) with `agent/muse_poller.py`, which
pulls and prints a compact summary of new/changed tasks and statuses.
On each run I check that output and report anything new to you in chat.

Chat commands you can use with me:

- "status" — what's running, what's queued, what's done
- "queue: <description>" — add a new task for Cline
- "cancel <task-id>" — stop a pending task (I move it to done/cancelled)
- "show logs <task-id>" — latest log tail from Cline's run

## Security notes

- **No secrets in the repo.** Tasks contain prompts, file paths, and repo
  URLs only. Never put API keys, tokens, or passwords in task JSON.
- **Your DeepSeek key never leaves your PC.** Cline reads it from its own
  local config. The watcher only invokes `cline` as a subprocess; the key
  is never sent to GitHub or to Muse.
- **Git auth is yours.** The watcher uses whatever git credentials your PC
  already has (Git Credential Manager, SSH). Muse uses its own.
- **No open ports.** Both sides only make outbound HTTPS connections to
  GitHub. Nothing listens for inbound connections.
- **Yolo mode runs commands on your PC.** `cline --yolo` auto-approves tool
  use, so Cline can run shell commands and edit files without asking.
  Only queue tasks you trust, and point Cline at project directories —
  never system directories. Review `tasks/pending/` before the watcher
  picks them up if you want a human gate.
- **Private repo recommended.**

## Latency expectations (be honest)

- **PC side is fast:** the watcher polls every ~20 seconds and pushes
  status immediately after Cline finishes a task. A finished task is on
  GitHub within seconds.
- **Muse side is loose:** I check the repo on a cron schedule (every few
  minutes, give-or-take). So when Cline finishes, I may not notice for a
  few minutes. If you ask me "status" in chat, I check immediately —
  that's the fast path. The automatic background updates are the slow path.

If you need tighter Muse-side latency, ask me and I can shorten the cron
interval (at the cost of more polling).

## PC side details

`pc/watcher.py` loop:

1. `git pull` the bridge repo.
2. Look in `tasks/pending/` for the oldest task JSON.
3. Claim it: `git mv` to `tasks/active/`, commit, push. (If the push
   fails because someone else claimed it, skip — first claim wins.)
4. Write `tasks/status/<id>.json` = `{"state":"running", ...}`, push.
5. Run `cline --yolo "<prompt>"` in the task's working directory,
   streaming output to a local log file and updating the status file
   periodically (every ~30s) with a log tail.
6. On exit: move task JSON to `tasks/done/` with result fields,
   write final status, commit, push.

If `cline` isn't on PATH or errors on launch, the task is marked failed
with the error message — check `pc/config.json` for the `cline_cmd`
override.

## Files in this project

- `README.md` — this file
- `protocol.md` — exact JSON schemas for task and status files
- `pc/watcher.py` — Windows watcher (stdlib only + git CLI)
- `pc/config.example.json` — watcher configuration template
- `pc/requirements.txt` — notes that only stdlib is used
- `pc/setup.bat` — Windows setup helper
- `agent/muse_poller.py` — Muse-side poll script for cron
- `agent/README.md` — how Muse operates the agent side
