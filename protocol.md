# Bridge Protocol

All coordination happens through JSON files in the bridge GitHub repo.
Both sides use `git pull` / `git push` only — no GitHub API, no tokens
in the repo.

## Directories

| Directory        | Written by | Meaning                                  |
|------------------|------------|------------------------------------------|
| `tasks/pending/` | Muse       | Queued tasks, not yet claimed             |
| `tasks/active/`  | Watcher    | Claimed; exactly one task runs at a time  |
| `tasks/done/`    | Watcher    | Finished (success, failure, or cancelled) |
| `tasks/status/`  | Watcher    | Live status per task id (updated often)   |
| `reports/`         | Muse       | Morning digests (`YYYY-MM-DD-digest.md`)  |
| `projects.json`    | Both       | Nickname → PC path map for projects       |
| `notify.json`      | Watcher    | ntfy.sh topic for instant pings, both directions (optional) |

## Instant notifications (`notify.json`, optional)

Git polling works but is slow. For near-instant pings in both directions,
set `backseat.notifyTopic` in VS Code to any unguessable string (e.g.
`backseat-9f3k7q2x`). The extension publishes the topic here:

```json
{
  "topic": "backseat-9f3k7q2x",
  "events": ["task_finished", "new_task"],
  "updated_at": "2026-09-28T01:10:00Z"
}
```

**PC → Muse (task finished):** on every task completion the extension POSTs
a small "task finished" message to `https://ntfy.sh/<topic>` (free, no
account). Muse's fast path: read the topic from `notify.json`, then poll
`https://ntfy.sh/<topic>/json?since=<last-seen-id>` for new pings instead of
blind git polling. Git remains the source of truth — a lost ping is harmless
because the next git poll catches up. The ping payload carries only the task
id, title, and result; never any secrets.

**Muse → PC (new task wake-up):** after pushing a task file, the Muse side
POSTs a one-line ping to the same topic:

```
curl -s -d "new task <task-id>" "https://ntfy.sh/<topic>"
```

The extension holds an outbound listen stream on the topic (plain HTTPS —
no open ports, no server) and polls immediately on any message, so task
pickup drops from "up to one poll interval" to ~1 second. The stream is
best-effort with automatic reconnect; if it ever dies, timer polling is
still the fallback, so nothing breaks.

Leave `backseat.notifyTopic` empty to disable; everything still works on
git polling alone.

File names are always `<task-id>.json`. Task ids are short, unique,
filesystem-safe strings, e.g. `20260928-001-auth` or a short uuid hex.
Muse generates the id when queueing.

## Task JSON (`tasks/pending/<id>.json`)

Created by Muse. Moved (not copied) through `active` → `done` by the watcher.

```jsonc
{
  // Required
  "id": "20260928-001-auth",          // string, matches filename
  "prompt": "Add login with ...",      // string, the exact prompt for `cline --yolo`
  "created_at": "2026-09-28T00:30:00Z", // string, ISO-8601 UTC

  // Recommended
  "project_dir": "C:\\Users\\Darek\\code\\myapp", // string, cwd for cline on the PC
  "mode": "act",                       // "plan" | "act"  (default "act")
  "timeout_sec": 1800,                 // integer, kill cline after this long (default 1800)

  // Optional
  "title": "Add login page",           // short human title for status messages
  "notes": "Muse's extra context for the human, not sent to cline",
  "labels": ["frontend"],              // free-form tags
  "max_retries": 2,                    // integer, retries for transient failures (default 2)

  // Written by watcher on completion (present only under tasks/done/)
  "result": "success",                 // "success" | "failed" | "cancelled" | "timeout"
  "exit_code": 0,                      // integer, cline's exit code (if ran)
  "attempts": 1,                       // integer, total Cline attempts including retries
  "error_kind": "transient",           // "transient" | "no_credits" | "context_overflow" | "timeout" | "failed"
  "started_at": "2026-09-28T00:31:05Z",
  "finished_at": "2026-09-28T00:44:12Z",
  "error": null,                       // string | null, human-readable failure reason
  "transcript_tail": "[say:text] ...", // last Cline session messages at completion
  "transcript_stats": { "messages": 42, "errorsSeen": 1 }
}
```

**`transcript_tail` / `transcript_stats` (0.9.9+):** on every terminal
outcome (success, failed, timeout, cancelled) the watcher appends the last
~12 Cline session messages as compact lines like `[say:text] ...` /
`[ask:api_req_failed] ...`, bounded to ~3000 chars with a
`[... earlier transcript omitted ...]` marker when truncated, plus message
and provider-error counts. Additive and optional — CLI-path and command
tasks have no transcript and omit both fields. Transcripts live only in
the private bridge repo (never in logs).

On a **timeout**, read `transcript_tail` before deciding what to do next:
it shows where Cline actually got stuck (mid-edit, provider-error loop,
awaiting input, or genuinely still working). Re-queue a narrower task
targeted at what the tail shows instead of blindly repeating the same
open-ended prompt — repeating the same prompt usually times out the same
way.

**Rules:**

- `prompt` must be a single string. Keep it self-contained: goal, relevant
  files, constraints, and a verifiable "done when" check.
- Never put secrets in any field. The repo may be private, but treat task
  files as shareable text.
- The watcher processes tasks in filename (lexicographic) order — oldest
  first if ids are timestamp-prefixed like `20260928-001-...`.
- To cancel a pending task, Muse moves it to `tasks/done/` with
  `"result": "cancelled"` and does not touch `tasks/status/`.

## Command tasks (`kind: "command"`)

A task with `"kind": "command"` drives VS Code itself instead of Cline —
this is how the user opens, creates, closes, or deletes projects entirely
from their phone. `prompt` may be empty for command tasks.

```jsonc
{
  // Required
  "id": "20260928-002-open-blog",
  "kind": "command",                 // "command" (default is "cline")
  "command": "openProject",           // "openProject" | "newProject" | "closeWindow" | "deleteProject"
  "created_at": "2026-09-28T01:10:00Z",

  // Per command
  "args": { "project": "blog" },      // preferred: nickname from projects.json
  // ...or a raw path: "args": { "path": "C:\\Users\\Darek\\code\\blog", "name": "blog" }
  "title": "Open blog project",

  // deleteProject ONLY:
  "confirm": "delete"                 // exact string required, otherwise refused
}
```

Commands:

| Command         | Args             | Effect                                              |
|----------------|------------------|-----------------------------------------------------|
| `openProject`  | `args.project` or `args.path` | Adds the folder as a workspace root (the bridge repo lives in the extension's managed clone, so remote control never drops); removes previously opened project roots |
| `newProject`   | `args.path`, `args.name?` | Creates the folder, `git init`, stub README, adds it as a workspace root |
| `closeWindow`  | —                | Publishes the done state, then closes VS Code       |
| `deleteProject`| `args.project` or `args.path`, `confirm: "delete"` | **Permanently deletes** the directory; also drops it from the workspace and `projects.json` |

**Project nicknames:** the bridge repo's `projects.json` maps nicknames to PC
paths (`{"blog": "C:\\Users\\Darek\\code\\blog"}`). Prefer `args.project`
over raw paths — a nickname can't typo-delete the wrong folder. After a
successful `openProject`/`newProject`, the extension writes the nickname →
path mapping into `projects.json` itself, so the map stays current without
Muse having to maintain it.

**Safety rules for `deleteProject`:**

- Refused unless `"confirm": "delete"` is exactly present — Muse must ask
  the user before setting it.
- The watcher refuses to delete the home directory, the bridge repo clone,
  filesystem roots, and anything that doesn't exist.
- Prefer `openProject`/`newProject` for daily use; deletion is the exception.

Command tasks flow through the same `pending → active → done` lifecycle and
`tasks/status/` heartbeats as Cline tasks, so Muse reports them the same way.

## Status JSON (`tasks/status/<id>.json`)

Written by the watcher, updated while a task runs and once at the end.
This is the fast path for "what's happening right now".

```jsonc
{
  "id": "20260928-001-auth",          // string, matches task id
  "state": "running",                 // "queued" | "running" | "success" | "failed" | "cancelled" | "timeout"
  "updated_at": "2026-09-28T00:35:00Z", // string, ISO-8601 UTC, every write bumps this
  "heartbeat_at": "2026-09-28T00:35:00Z", // string, ISO-8601 UTC, bumped every ~30s while running
  "log_tail": "...last ~40 lines of cline output...", // string
  "progress_note": "optional short note" // string, e.g. "tests passing, polishing UI"
}
```

**Rules:**

- The watcher writes `{"state":"queued", ...}` when it claims a task
  (before launching cline), then `running` with heartbeats every ~30s.
- `log_tail` is truncated to the last ~40 lines / ~8 KB so the file stays small.
- On completion the watcher writes the terminal state (`success`,
  `failed`, `cancelled`, `timeout`) once more, then stops updating it.
- Muse never writes status files; it only reads them.

## Example: full lifecycle

1. Muse writes `tasks/pending/20260928-001-auth.json` (`result` absent),
   commits, pushes.
2. Watcher pulls, sees the pending task, `git mv` to `tasks/active/`,
   commits, pushes. Writes `tasks/status/20260928-001-auth.json` with
   `state: "queued"`, pushes.
3. Watcher launches `cline --yolo "<prompt>"` in `project_dir`,
   updates status to `running` + heartbeats, pushes every ~30s.
4. Cline exits 0. Watcher adds `result: "success"`, timestamps, moves
   task JSON to `tasks/done/`, writes final status `success`, pushes.
5. Muse's poller sees the done task + final status, reports to Darek.

## Failure handling
Cline runs fail for flaky reasons (rate limits, network blips, overloaded
models). The watcher retries instead of stalling:

| `error_kind` | Meaning | Watcher behavior |
|---|---|---|
| `transient` | Rate limit, 429, overloaded, network error | Retries with backoff (2 min, then 10 min), up to `max_retries` (default 2) |
| `timeout` | Cline exceeded `timeout_sec` | Retried like transient on the CLI path (the process was killed, so it's safe). Never auto-retried on the extension-API path — the task may still be running in the sidebar, and retrying would run the prompt twice |
| `no_credits` | Out of credits / quota / billing | Fails immediately, no retries — retrying can't help |
| `context_overflow` | Context / token limit exceeded | Fails immediately — retrying the same prompt would fail identically; Muse splits the task instead |
| `failed` | Anything else | Fails immediately; Muse triages |

The retry loop is interruptible: stopping the bridge during backoff marks the
task failed rather than hanging. `attempts` records the total tries.

**Stall recovery (Muse side):** if a task sits in `tasks/active/` with
`heartbeat_at` more than ~15 minutes stale, the PC side died (VS Code
closed, PC asleep, crash). Move the task JSON back to `tasks/pending/` for a
fresh attempt — but only after that staleness threshold, to avoid double-running
a task that's merely slow.

**Cancelling a running task (Muse side, v0.9.7+):** the extension runs one
task at a time, and a stuck watcher would otherwise block the queue until
its `timeout_sec` expires. To cancel remotely with pure git (no extra
setup, no ntfy needed):
1. Write `tasks/done/<id>.json` with `result: "cancelled"` and a note
   saying why (e.g. user-verified complete, superseded, wrong prompt).
2. Delete `tasks/active/<id>.json`.
3. Commit and push.
The watcher's loop fetches origin every ~30s and checks whether its active
file still exists on the remote (`git cat-file -e <upstream>:tasks/active/<id>.json`).
When it's gone, the loop stops within ~30s as `cancelled` — without
overwriting the done record you wrote — and the next pending task is
picked up on the following poll. A failed fetch is fail-open: the task
keeps running, so a network blip never cancels work.
On cancellation the runner also resets its working tree to the upstream
ref (`rebase --abort`, then `reset --hard`), because its own superseded
heartbeat/finish commits would otherwise collide with the canceller's
record on the next `pull --rebase` and wedge the bridge with "pull
failed". If you ever see a stuck "pull failed" on an older version,
recover manually in the bridge clone: `git rebase --abort`, then
`git reset --hard origin/main` (the abort must come first — a conflicted
rebase leaves HEAD detached).

## Concurrency

One task at a time per PC. If two watchers ever run against the same bridge
(e.g. a desktop and a laptop), the claim step is the lock: whoever pushes
the claim first wins. The claim file in `tasks/active/` is stamped with
`claimed_by` (a unique id per watcher process). The loser sees its push
rejected, fetches, reads the winner's `claimed_by`, and backs off — it
uncommits only its own claim and syncs those two paths to the winner's
state, so the task runs exactly once and the loser's next pull stays clean.
A rejected push with *no* winner's claim on origin is transient
(network/auth); the local claim stands and the next push carries it.

## Clock skew

All timestamps are UTC ISO-8601 (`datetime.now(timezone.utc)`).
The watcher and Muse don't need synchronized clocks beyond roughly —
`heartbeat_at` staleness (>120s without update while `state` is
`running`) means the watcher probably died; Muse should report the
task as stalled.
