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

  // Written by watcher on completion (present only under tasks/done/)
  "result": "success",                 // "success" | "failed" | "cancelled" | "timeout"
  "exit_code": 0,                      // integer, cline's exit code (if ran)
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
