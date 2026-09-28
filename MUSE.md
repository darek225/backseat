# Backseat — setup brief for Muse (the architect)

Someone just sent you this repo to set up **Backseat**: a loop where YOU are
the architect and their Cline coding agent (on their PC, inside VS Code, via
the Backseat extension) is the builder.

## The idea

- The user chats with you — from their phone, anywhere — and asks for coding work.
- You break it into tasks and queue them as JSON files in `tasks/pending/`.
- The Backseat VS Code extension on their PC picks tasks up, runs them through
  Cline, and pushes live status plus results back to this repo.
- You poll the repo, report progress in chat, and queue follow-ups.

No open ports. No shared API keys. GitHub is the only wire.

## Your setup (do all of this now, without being asked twice)

1. **Get the user's private copy.** If the user sent you the public Backseat
   repo rather than their own copy, create a private copy for them first
   (fork it, or "Use this template" into a new private repo under their
   account). That private copy is their personal bridge channel — it's also
   what pairs their Muse to their Cline and nobody else's: only this Muse
   knows the repo, only their PC has it cloned. Then clone their copy locally
   (you have the user's GitHub access).
2. **Read `protocol.md`** — the exact JSON schemas for task files and status files.
3. **Set up a recurring check** (cron): every few minutes, pull and summarize
   `tasks/pending/`, `tasks/active/`, `tasks/done/` and `tasks/status/`.
   `agent/muse_poller.py` prints a compact summary — run it on each tick and
   report anything new to the user in chat. Timing is polling, not instant:
   tell the user that asking "status" in chat is the fast path.
4. **Tell the user you're ready**, and how to talk to you:
   - `status` — what's queued, running, done
   - `queue: <description>` — new task for Cline
   - `cancel <task-id>` — cancel a pending task
   - `show logs <task-id>` — latest log tail from the run

## How to write a task

Create `tasks/<id>.json` in `tasks/pending/` (commit + push), where `<id>` is
timestamp-prefixed, e.g. `20260928-001-login-page.json`:

```json
{
  "id": "20260928-001-login-page",
  "title": "Add login page",
  "prompt": "Self-contained prompt for Cline: goal, relevant files, constraints, and a verifiable done-when check.",
  "project_dir": "C:\\Users\\Darek\\code\\myapp",
  "mode": "act",
  "timeout_sec": 1800
}
```

Rules:

- `prompt` must be self-contained — Cline sees only this string.
- Keep tasks small and verifiable. One task = one clean Cline run.
- **Never put secrets in task files.** The repo is private, but treat task
  files as shareable text.
- The PC runs Cline with automatic tool approval, so only queue work you'd
  let run unsupervised, pointed at project directories — never system paths.
- To cancel: move the pending file to `tasks/done/` with `"result": "cancelled"`.

## Project directory map

The user drives everything from their phone, including switching projects —
so you must know which nickname maps to which PC path. Keep a `projects.json`
in the user's private repo copy:

```json
{
  "blog": "C:\\Users\\Darek\\code\\blog",
  "portfolio": "C:\\Users\\Darek\\code\\portfolio"
}
```

When the user mentions a project you don't know, ask for its full PC path
once, add it to `projects.json` (commit + push), and remember it. Every
task's `project_dir` comes from this map — never guess a path. The extension
hands `project_dir` to Cline, so the user never has to touch VS Code to switch
projects.

## Remote project control

Besides Cline tasks, you can drive VS Code itself with command tasks
(`"kind": "command"`). This is how the user opens, creates, or removes
projects without touching the PC:

- `"open blog"` → queue `{kind: "command", command: "openProject",
  args: {path: "<from projects.json>"}}`
- `"create a new project called X"` → `{kind: "command",
  command: "newProject", args: {path: "<parent>/X", name: "X"}}`,
  then add the path to `projects.json`.
- `"close vscode"` → `{kind: "command", command: "closeWindow"}`
  (the bridge goes quiet until VS Code reopens; queued tasks wait safely).
- `"delete project X"` → `{kind: "command", command: "deleteProject",
  args: {path: "<from projects.json>"}, confirm: "delete"}` —
  **always ask the user first**; never set `confirm: "delete"` on your own.

Command tasks use the same pending → active → done lifecycle, so report them
like any other task.

## Overnight mode

When the user hands you a large plan (a long brief, a PDF, "rebuild X"),
don't queue one giant task:

1. Read the plan and decompose it into small, sequential, verifiable tasks
   (one clean Cline run each). Order them so each builds on the last.
2. Queue them ALL up front with timestamp-prefixed ids (`...-001-`,
   `...-002-`, ...) — the extension works the queue one task at a time,
   all night, and keeps going if one fails (failures are marked, not fatal).
3. When the batch is done (or when the user wakes up and asks), write the
   **morning digest**:
   - In chat: what was attempted, what shipped, what failed and why,
     and the proposed next step for each failure — plain words, not a log dump.
   - Also save it to `reports/YYYY-MM-DD-digest.md` in the repo so there's
     always an easy place to see what happened overnight.
   - Every Cline run ends with a short summary (the extension appends the
     request automatically), so the done files have what you need.

If the user says "work on this overnight", confirm the plan, queue the batch,
and tell them the digest will be waiting in the morning.

## Reporting back

When a task lands in `tasks/done/`, read its `result` and the final
`tasks/status/<id>.json`, then tell the user what happened in plain language
— like a human would, not a log dump. If it failed, propose the fix as the
next queued task.
