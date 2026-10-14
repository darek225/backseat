# Backseat bugs — field notes, 2026-10-12 (voxel survey tasks)

> **RESOLVED in v0.9.14 (2026-10-13).** Every bug below was fixed and
> shipped; this file is kept as the evidence record. See CHANGELOG.md
> (0.9.14), `protocol.md` ("Timeouts", "Worktree checkpoints"), and
> `muse-watch/` (health envelope + `healthcheck.sh`).

Captured by Muse during the voxel-survival-game UE5 task series, at
Darek's request, for a later Backseat fix session. Evidence is from the
bridge repo (`tasks/status/*.json`), the game repo's git history, and
Darek's own observation of his PC.

## BUG 1 — "timeout" status is unreliable in BOTH directions (critical)

The same terminal status string means opposite realities:

| Task | Bridge verdict | Reality |
|---|---|---|
| voxel-4 (2026-10-05) | timeout | Completed; work pushed to GitHub |
| voxel-5 (2026-10-11) | timeout | Completed; work pushed |
| voxel-7 (2026-10-12) | timeout (15:28Z) | Completed; full survey pushed as game-repo commit `d0b0ac6` |
| voxel-6 (2026-10-12) | timeout (14:57Z) | Nothing ever landed; work lost |
| voxel-8 (2026-10-12) | timeout (16:12Z) | Nothing ever landed; work lost |

- `log_tail` on timeouts is boilerplate only: "Timed out waiting for
  the Cline sidebar task (no done-file, no terminal session status)".
  It carries NONE of what Cline actually did — a direct violation of
  the standing rule *"if the extension knows it, the bridge records
  it."* Timeout records are exactly where transcript tails / retry
  counts / last-seen activity are most needed.
- The verdict appears to be **terminal and never revised**: voxel-7's
  work landed on GitHub, but its bridge status stayed `timeout`.
  Nothing reconciles "the project repo received task-attributable
  commits" with the task record afterwards.

**Fix directions:** (a) timeout should be a *state*, not a *verdict* —
keep watching and allow late terminal updates (done-after-timeout);
(b) attach the bounded Cline transcript tail + last-activity timestamp
to timeout records, same as completions; (c) optionally, a repo-watch:
commits landing on the project repo during/after a task window get
linked into the task record as evidence.

## BUG 2 — No heartbeat/activity extension for long tasks

UE5 tasks (world generation + editor captures) legitimately run long.
The watcher gives up on a fixed wait with no sign the task is alive
and progressing. From the Muse side there is no difference between
"working fine, 80% done" and "dead at minute 2."

**Fix directions:** activity-based timeout (reset the clock on
transcript growth / editor activity / checkpoint pushes), and/or a
`progress` field the extension updates periodically (stage, last
action). Client-side workaround invented this session: task prompts
now instruct Cline to commit+push after EACH stage ("staged pushes",
voxel-8b) so a timeout can't eat finished work — the bridge should
probably support/encourage this natively (e.g., recognize stage
commits as progress).

## BUG 3 — Running/claimed state vs reality on the PC

voxel-8b flipped to `running` at 17:01:54Z within a minute of being
queued, at a moment when Darek reported nothing running on his PC
(it did start right after). The status likely reflects the extension
*claiming* the task, not Cline *actually working*. Minor, but the
distinction matters when diagnosing stalls: record `claimed_at` and
`started_at` (first transcript activity) as separate fields.

## BUG 4 — Muse-side watcher staleness (observed 2026-10-11)

`~/.backseat/muse-watch/darek225-MYbackseat/state.json` was stale
(dated Oct 1) while the bridge repo itself was current — the nohup
watcher daemon had silently stopped reflecting reality and there is
no staleness alarm. (Known ops quirk: reinstall after VM reboot. The
gap is that nothing *notices* when it dies.)

## What works (keep)

- Pickup is fast and reliable (8b: pending → running in <1 min).
- Done-file + status-file flow for fast tasks (core-side tasks
  voxel-1..3, grid/grass era) reported accurately.
- Git-as-transport itself never lost a *pushed* artifact; all losses
  were work that never reached a push.

## Session workaround now in standing use

Until fixed, Muse queues long PC tasks with **staged-push
instructions** (commit+push per stage) and treats **GitHub, not
bridge status, as the source of truth** for completion.

## Addendum (later the same day) — voxel-10: staged pushes are not enough

voxel-10 (UE materials pass) timed out at 18:03Z with ZERO commits on
GitHub, despite the task prompt carrying the staged-push rule. The
stages were too big: stage 1 (a whole material system) never finished,
so there was never anything to push. voxel-9 started right after.

Mitigations now in Muse's task template: (a) a **Stage 0 pipeline
proof** — create+push a report skeleton before any real work, proving
git flow in the first minutes; (b) smaller stages (one deliverable
each). A bridge-level fix would be better: the extension could
auto-commit/push the working tree on a heartbeat (or on timeout) so
uncommitted work is never stranded — Cline's local changes existed on
the PC and were simply never pushed.
