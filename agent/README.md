# Agent side (Muse's side)

This is how I, Muse, operate the bridge from my own machine.

## One-time setup

1. Clone the bridge repo somewhere persistent, e.g. `~/bridge-repo`:

   ```bash
   git clone <bridge-repo-url> ~/bridge-repo
   ```

2. Verify the poller works:

   ```bash
   python3 ~/workspace/muse-cline-bridge/agent/muse_poller.py --repo ~/bridge-repo
   ```

   First run prints everything as NEW (it has no prior state) — that's
   expected. Later runs only print changes.

## Cron (background polling)

Add a cron job that runs the poller every few minutes and appends output
to a log I can check:

```bash
*/5 * * * * python3 ~/workspace/muse-cline-bridge/agent/muse_poller.py --repo ~/bridge-repo >> ~/bridge-repo-poller.log 2>&1
```

Honest latency note: cron polling is loose — give or take minutes. The PC
pushes status within seconds of Cline finishing, but I only notice on my
next poll. When Darek asks "status" in chat, I run the poller immediately
instead of waiting for cron — that's the fast path.

## Queueing a task (architect workflow)

When Darek asks for work, or when a Cline task finishes and the plan has
a next step:

1. `git pull` the bridge repo.
2. Write `tasks/pending/<task-id>.json` following `protocol.md`.
   Task ids: `YYYYMMDD-NNN-shortslug`, e.g. `20260928-001-auth`.
   The `prompt` field is the exact Cline prompt: goal first, then context,
   files, constraints, and a verifiable "done when".
3. Commit + push.
4. Tell Darek the task is queued.

Keep prompts self-contained — Cline on the PC has no access to this chat.
Anything Cline needs (file paths are on the PC, so use the PC's paths)
must be inside the prompt.

## Chat commands I support

- **"status"** — run the poller now, summarize: what's running (with log
  tail), what's queued, what finished since last check.
- **"queue: <description>"** — draft a task JSON, confirm the prompt with
  Darek if it's ambiguous, then queue it.
- **"cancel <task-id>"** — move `tasks/pending/<id>.json` to `tasks/done/`
  with `"result": "cancelled"` (only works before the watcher claims it;
  if already active, tell Darek it must finish or be killed on the PC).
- **"show logs <task-id>"** — print the latest `log_tail` from
  `tasks/status/<id>.json`.
- **"plan: <goal>"** — break a goal into staged tasks and queue stage 1,
  keeping the rest of the plan in chat to queue as stages complete.

## Stalled tasks

If the poller reports STALLED (no heartbeat >120s while `state` is
`running`), the watcher on the PC probably died or the PC slept. Tell
Darek to check the watcher window on the PC.

## Security reminders for me

- Never write secrets into task JSON. Prompts are shareable text.
- Never ask Darek for his DeepSeek key — it lives in Cline's local config
  on his PC and I must never see it.
- The bridge repo should stay private.
