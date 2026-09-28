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
  "error": null                        // string | null, human-readable failure reason
}
```

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
  "args": { "path": "C:\\Users\\Darek\\code\\blog", "name": "blog" },
  "title": "Open blog project",

  // deleteProject ONLY:
  "confirm": "delete"                 // exact string required, otherwise refused
}
```

Commands:

| Command         | Args             | Effect                                              |
|----------------|------------------|-----------------------------------------------------|
| `openProject`  | `args.path`      | Opens the folder in VS Code (current window)        |
| `newProject`   | `args.path`, `args.name?` | Creates the folder, `git init`, stub README, opens it |
| `closeWindow`  | —                | Publishes the done state, then closes VS Code       |
| `deleteProject`| `args.path`, `confirm: "delete"` | **Permanently deletes** the directory |

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

## Concurrency

One task at a time per PC. If two watchers ever run, the claim step
(`git mv` + push) is the lock: whoever pushes the claim first wins;
the loser sees its push rejected, pulls, and finds the task gone.

## Clock skew

All timestamps are UTC ISO-8601 (`datetime.now(timezone.utc)`).
The watcher and Muse don't need synchronized clocks beyond roughly —
`heartbeat_at` staleness (>120s without update while `state` is
`running`) means the watcher probably died; Muse should report the
task as stalled.
