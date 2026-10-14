# Bridge Protocol

All coordination happens through JSON files in the bridge GitHub repo.
Both sides use `git pull` / `git push` only — no GitHub API, no tokens
in the repo.

## Directories

| Directory        | Written by | Meaning                                  |
|------------------|------------|------------------------------------------|
| `tasks/pending/` | Architect       | Queued tasks, not yet claimed             |
| `tasks/active/`  | Watcher    | Claimed; exactly one task runs at a time  |
| `tasks/done/`    | Watcher    | Finished (success, failure, or cancelled) |
| `tasks/status/`  | Watcher    | Live status per task id (updated often)   |
| `reports/`         | Architect       | Morning digests (`YYYY-MM-DD-digest.md`)  |
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

**PC → Architect (task finished):** on every task completion the extension POSTs
a small "task finished" message to `https://ntfy.sh/<topic>` (free, no
account). The architect's fast path: read the topic from `notify.json`, then poll
`https://ntfy.sh/<topic>/json?since=<last-seen-id>` for new pings instead of
blind git polling. Git remains the source of truth — a lost ping is harmless
because the next git poll catches up. The ping payload carries only the task
id, title, and result; never any secrets.

**Architect → PC (new task wake-up):** after pushing a task file, the architect side
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
The architect generates the id when queueing.

## Task JSON (`tasks/pending/<id>.json`)

Created by the architect. Moved (not copied) through `active` → `done` by the watcher.

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
  "notes": "the architect's extra context for the human, not sent to cline",
  "labels": ["frontend"],              // free-form tags
  "max_retries": 2,                    // integer, retries for transient failures (default 2)

  // Written by watcher on completion (present only under tasks/done/)
  "result": "success",                 // "success" | "failed" | "cancelled" | "timeout"
  "exit_code": 0,                      // integer, cline's exit code (if ran)
  "attempts": 1,                       // integer, total Cline attempts including retries
  "error_kind": "transient",           // "transient" | "no_credits" | "context_overflow" | "timeout" | "failed"
  "claimed_at": "2026-09-28T00:30:55Z", // 0.9.14: when the watcher claimed the task (vs started_at below)
  "started_at": "2026-09-28T00:31:05Z",
  "finished_at": "2026-09-28T00:44:12Z",
  "error": null,                       // string | null, human-readable failure reason
  "transcript_tail": "[say:text] ...", // last Cline session messages at completion
  "transcript_stats": { "messages": 42, "errorsSeen": 1 },

  // 0.9.14 — timeout is a STATE, not a verdict (see "Timeouts" below)
  "timeout_pending_late": true,        // sidebar-path timeout: still watching for a late finish
  "late_watch_until": "2026-09-28T02:44:12Z",
  "completed_late": true,              // the late finish landed; result is the late outcome
  "original_result": "timeout",        // what the first verdict said
  "timed_out_at": "2026-09-28T00:44:12Z",
  "late_finished_at": "2026-09-28T01:03:00Z",
  "linked_commits": [                  // project-repo commits landed during the task window
    { "sha": "1fce6af…", "subject": "[backseat:task:…] stage 1", "attributed": true }
  ],
  "checkpoint": {                      // non-disruptive worktree snapshot (see "Checkpoints")
    "branch": "backseat/20260928-001-auth", "sha": "e83f6af…",
    "reason": "timeout", "at": "2026-09-28T00:44:12Z"
  },
  "worktree_base": "a3f9c21…"          // project-repo HEAD when the task started
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
awaiting input, or genuinely still working). Also check `completed_late`
(the sidebar session may have finished after the verdict),
`linked_commits` (staged pushes are evidence of real progress), and
`checkpoint.branch` (uncommitted work is recoverable there). Re-queue a
narrower task targeted at what the tail shows instead of blindly
repeating the same open-ended prompt — repeating the same prompt usually
times out the same way.

**Rules:**

- `prompt` must be a single string. Keep it self-contained: goal, relevant
  files, constraints, and a verifiable "done when" check.
- Never put secrets in any field. The repo may be private, but treat task
  files as shareable text.
- The watcher processes tasks in filename (lexicographic) order — oldest
  first if ids are timestamp-prefixed like `20260928-001-...`.
- To cancel a pending task, the architect moves it to `tasks/done/` with
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
the architect having to maintain it.

**Safety rules for `deleteProject`:**

- Refused unless `"confirm": "delete"` is exactly present — the architect must ask
  the user before setting it.
- The watcher refuses to delete the home directory, the bridge repo clone,
  filesystem roots, and anything that doesn't exist.
- Prefer `openProject`/`newProject` for daily use; deletion is the exception.

Command tasks flow through the same `pending → active → done` lifecycle and
`tasks/status/` heartbeats as Cline tasks, so the architect reports them the same way.

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
  "progress_note": "optional short note", // string, e.g. "tests passing, polishing UI"

  // 0.9.14 — written once at the relevant lifecycle point, then preserved
  // (status writes merge; they never rewrite from scratch):
  "claimed_at": "2026-09-28T00:30:55Z",   // claim instant (BUG 3: distinct from start)
  "started_at": "2026-09-28T00:31:05Z",   // Cline actually began
  "last_activity_at": "2026-09-28T00:40:12Z", // last sign of life (transcript/output/commit)
  "deadline_at": "2026-09-28T01:10:12Z",  // current activity-based deadline (absent = uncapped)
  "transcript_tail": "[say:text] ...",    // on timeouts: what Cline was doing (bounded)
  "transcript_stats": { "messages": 42, "errorsSeen": 1 }, // on timeouts
  "linked_commits": [ ... ],              // as in the task record
  "checkpoint": { "branch": "backseat/…", "sha": "…", "reason": "periodic", "at": "…" },
  "late_watch": true,                     // timeout state: still watching for a late finish
  "late_watch_until": "2026-09-28T02:44:12Z",
  "completed_late": true                  // set when the late finish revised the record
}
```

**Rules:**

- The watcher writes `{"state":"queued", ...}` when it claims a task
  (before launching cline), then `running` with heartbeats every ~30s.
- `log_tail` is truncated to the last ~40 lines / ~8 KB so the file stays small.
- On completion the watcher writes the terminal state (`success`,
  `failed`, `cancelled`, `timeout`) once more, then stops updating it.
- The architect never writes status files; it only reads them.

## Timeouts (0.9.14: a state, not a verdict)

A fixed wall-clock timeout cannot tell "working fine, 80% done" from
"dead at minute 2" — the same `timeout` string once meant both "work
completed and pushed" and "nothing ever landed". Backseat now treats
timeout as a *state* with a recovery path:

**Activity-based deadline.** While a task runs, any sign of life resets
the quiet clock: transcript growth, CLI output bytes, an auto-retry
press, or a stage commit pushed to the project repo. The task times out
when it goes quiet for `backseat.inactivityTimeoutSec` (default 1800s)
or hits the absolute `timeout_sec` cap, whichever comes first.
`timeout_sec: 0` disables the absolute cap; `inactivityTimeoutSec: 0`
disables the quiet cap. Status records show the current `deadline_at`
and `last_activity_at` so the architect can see the reasoning.

**Timeout records carry evidence.** On timeout the status record gets
the bounded transcript tail, `transcript_stats`, `last_activity_at`,
and `linked_commits` (project-repo commits landed during the task
window — staged pushes show up here even when the verdict says
timeout). The done record keeps the full tail as before.

**Late completion (sidebar path only).** On the CLI path the process
was killed, so timeout is final. On the sidebar path Cline may still be
working, so the watcher keeps watching for `backseat.lateWatchSec`
(default 7200s): done-file first, then terminal session status — the
same signals as the main watch loop. When Cline finishes, the done
record is revised: `result` becomes the late outcome,
`completed_late: true`, and the original verdict is preserved as
`original_result` / `timed_out_at` so nothing already read becomes a
lie. The status state updates to the late outcome with
`progress_note: "finished late: …"`. If the window closes with no
finish, the watch is dropped (`late_watch: false`).

## Worktree checkpoints (0.9.14)

A timeout must never strand uncommitted work. On every timeout — and
every `backseat.checkpointMin` minutes (default 15, `0` disables) while
a task runs — the watcher snapshots the project worktree to a
`backseat/<task-id>` branch and pushes it. The snapshot is pure git
plumbing (`add -A` → `write-tree` → `commit-tree` → `update-ref`,
with the index restored exactly afterwards): the user's branch, index,
and working tree are untouched, ignored files (build output,
`node_modules`, UE `Binaries/…`) are excluded by git's own rules, and
the architect can recover or merge the branch later. `newProject`
ships a default `.gitignore` so fresh projects don't checkpoint
gigabytes of artifacts. The checkpoint is recorded on the task as
`checkpoint: { branch, sha, reason, at }`.

**Architect recovery recipe:** `git fetch origin` in the project repo,
inspect `backseat/<task-id>` (`git log`, `git diff main...backseat/<id>`),
then merge or cherry-pick onto your working branch. The branch is
extension-owned and force-pushed on each checkpoint.

## Example: full lifecycle

1. The architect writes `tasks/pending/20260928-001-auth.json` (`result` absent),
   commits, pushes.
2. Watcher pulls, sees the pending task, `git mv` to `tasks/active/`,
   commits, pushes. Writes `tasks/status/20260928-001-auth.json` with
   `state: "queued"`, pushes.
3. Watcher launches `cline --yolo "<prompt>"` in `project_dir`,
   updates status to `running` + heartbeats, pushes every ~30s.
4. Cline exits 0. Watcher adds `result: "success"`, timestamps, moves
   task JSON to `tasks/done/`, writes final status `success`, pushes.
5. The architect's poller sees the done task + final status, reports to Darek.

## Failure handling
Cline runs fail for flaky reasons (rate limits, network blips, overloaded
models). The watcher retries instead of stalling:

| `error_kind` | Meaning | Watcher behavior |
|---|---|---|
| `transient` | Rate limit, 429, overloaded, network error | Retries with backoff (2 min, then 10 min), up to `max_retries` (default 2) |
| `timeout` | Cline exceeded the activity deadline (quiet too long) or `timeout_sec` | Retried like transient on the CLI path (the process was killed, so it's safe). Never auto-retried on the extension-API path — the task may still be running in the sidebar, and retrying would run the prompt twice; instead the late watch revises the record if it finishes |
| `no_credits` | Out of credits / quota / billing | Fails immediately, no retries — retrying can't help |
| `context_overflow` | Context / token limit exceeded | Fails immediately — retrying the same prompt would fail identically; the architect splits the task instead |
| `failed` | Anything else | Fails immediately; architect triages |

The retry loop is interruptible: stopping the bridge during backoff marks the
task failed rather than hanging. `attempts` records the total tries.

**Stall recovery (architect side):** if a task sits in `tasks/active/` with
`heartbeat_at` more than ~15 minutes stale, the PC side died (VS Code
closed, PC asleep, crash). Move the task JSON back to `tasks/pending/` for a
fresh attempt — but only after that staleness threshold, to avoid double-running
a task that's merely slow.

**Cancelling a running task (architect side, v0.9.7+):** the extension runs one
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
The watcher and architect don't need synchronized clocks beyond roughly —
`heartbeat_at` staleness (>120s without update while `state` is
`running`) means the watcher probably died; the architect should report the
task as stalled.
