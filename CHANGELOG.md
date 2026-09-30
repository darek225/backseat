# Changelog

## [0.9.12] - 2026-09-30
### Changed
- Unified brand logo: a single vector steering-wheel mark (rim with a
  remote-node gap, mint-to-cyan gradient) now backs every surface — the
  Marketplace icon (`images/icon.png`), the activity-bar glyph
  (`images/activity-icon.svg`, same geometry in monochrome), the README
  branding (`images/logo.png`, from `images/logo.svg`), and the demo
  video/GIF. Source SVGs live alongside the renders in `images/`.

## [0.9.11] - 2026-09-30
### Changed
- Marketplace listing prep: the extension README is now user-facing listing
  copy (setup, commands, security model, limitations) with an animated
  demo GIF, and `package.json` carries Marketplace metadata — Machine
  Learning + Other categories, Cline/Claude/agent keywords, homepage,
  issue tracker, and a dark gallery banner.

## [0.9.10] - 2026-09-28
### Fixed
- Activity-bar icon rendered as a solid square. The view container was
  pointing at `images/icon.png`; VS Code renders activity-bar icons as a
  theme-colored mask, so a mostly-opaque PNG degrades to a solid square.
  New `images/activity-icon.svg`: a monochrome steering-wheel glyph with
  code brackets on a transparent background. The marketplace/extension icon
  stays the full-color PNG. Added `test/packaging.test.cjs` asserting the
  container icon is an on-disk SVG and is not excluded by `.vscodeignore`.

## [0.9.9] - 2026-09-28
### Added
- Transcript tail in done records. On every terminal outcome (success,
  failed, timeout, cancelled) the done JSON now carries `transcript_tail`
  (the last ~12 Cline session messages as compact `[say:text]` /
  `[ask:api_req_failed]` lines, bounded to ~3000 chars with a truncation
  marker) and `transcript_stats` (`{messages, errorsSeen}`). Previously a
  timeout record said only "timed out waiting for the Cline sidebar task",
  leaving the Muse side blind to what Cline was doing. Pure
  `transcriptTail`/`transcriptStats`/`attachTranscriptTail` helpers in
  logic.ts reuse the existing dual-shape transcript parsing; the sidebar
  watch loop threads the session's messagesPath through to finishTask.
  Additive and backward compatible — CLI/command tasks omit both fields,
  and transcripts stay in the private bridge repo (never logged).
  protocol.md documents the fields and the new guidance: on timeout, read
  `transcript_tail` to see where Cline got stuck before re-queueing.

## [0.9.8] - 2026-09-28
### Fixed
- Remote cancel no longer wedges the bridge. In 0.9.7 the cancelled
  runner's own superseded done-file/heartbeat commits collided with the
  canceller's record on the next `pull --rebase` ("pull failed" forever).
  The cancel path now resets the working tree to the upstream ref
  (`rebase --abort`, then `reset --hard`) before finishing, so the
  canceller's done record stands and the next poll/push is clean. The
  abort must come first: a conflicted rebase leaves HEAD detached and
  `@{u}` unresolvable. Recovery sequence verified with a live git
  simulation of the exact wedge. Manual recovery for older versions also
  documented in protocol.md.

## [0.9.7] - 2026-09-28
### Added
- Remote cancel for running tasks (pure git, no new setup): the Muse side
  cancels by writing `tasks/done/<id>.json` (`result: "cancelled"` + note)
  and deleting `tasks/active/<id>.json` on origin. The sidebar watch loop
  fetches origin every ~30s and stops within ~30s when its active file is
  gone from the remote — previously a stuck watcher blocked the queue
  until its full `timeout_sec` expired and the only fix was a window
  reload. A failed fetch is fail-open (network blips never cancel work),
  and the runner never overwrites the canceller's done record.
  New `isRemoteCancelled()` in logic.ts; cancel procedure documented in
  protocol.md.

## [0.9.6] - 2026-09-28
### Fixed
- The error auto-retry was too slow and too strict: it waited 60s and only
  fired when the LATEST transcript message was exactly `ask:'api_req_failed'`
  — if Cline wrote anything after the error ask, only the 3-minute stall
  fallback fired (~4 min observed on a live DeepSeek "invalid request"
  error). Now: 30s quiet delay, 5s poll, and the retry fires whenever the
  transcript tail shows a provider error and Cline is not awaiting user
  input (new `isAwaitingUserAsk()` blocklist — approvals/follow-ups are
  never auto-answered).
- Heartbeats no longer clobber meaningful status notes: retry/awaiting-input
  notes are sticky until the transcript moves again, so the bridge log
  actually shows what Backseat did while you were away.

## [0.9.5] - 2026-09-28
### Fixed
- Session discovery could NEVER find sidebar tasks, so the 0.9.0/0.9.3
  transcript-aware auto-retry never fired: tasks started via the extension
  API (`startNewTask`) create the session with `prompt: undefined` — the
  row in `sessions.index.json` ends up with `prompt: null`, and the
  `[backseat:task:<id>]` marker only survives in the first user message of
  `<sessionId>.messages.json`. Discovery now falls back to a newest-first
  scan of session message files (head-read only, cheap). Pure
  `findSessionIdByMarker()` in logic.ts, unit-tested.
### Changed
- Auto-retry is now precise instead of blind: it presses Cline's primary
  button only when the LATEST transcript message really is
  `ask:'api_req_failed'` (new `transcriptInfo()` also reports the last
  message kind). The 3-minute stall press no longer fires when Cline is
  asking the user something (approval/follow-up must never be
  auto-answered) — the status notes "awaiting your input" instead.
- Credits/quota/auth errors are never auto-pressed (retrying fails
  identically) — the status says "manual action needed". Other provider
  errors get at most 3 auto-retries per quiet spell, then the status
  asks for manual attention. Every press is logged in the status note
  with a counter.
- `tryResumeViaClineApi` falls back to the conventional messages path
  (`<sessionId>/<sessionId>.messages.json`) when the index row has no
  messagesPath.
## [0.9.4] - 2026-09-28
### Fixed
- Orphan recovery could leave a task claimed by a dead runner forever:
  the 5-minute heartbeat guard always saw a "fresh" heartbeat right after
  an upgrade/reload and refused to reclaim. Recovery now probes the pid
  embedded in the claim (`<host>-<pid>-<random>`); a dead pid reclaims
  immediately, a live pid (or unparseable id) still defers to the
  heartbeat guard. Pure `isClaimedByDeadRunner()` in logic.ts, unit-tested.
## [0.9.3] - 2026-09-28
### Fixed
- The transcript-aware auto-retry never fired: `transcriptText` only
  understood Anthropic-style `{role, content}` messages, but the Cline SDK
  persists `ClineMessage`-shaped rows (`{type:'say'|'ask', say/ask, text}`),
  so provider errors (`ask:'api_req_failed'`) were invisible and the error
  regex never matched. The reader now handles both shapes, and the error
  regex explicitly matches `api_req_failed` and `invalid_request`.
  Moved `transcriptText` + the regex into logic.ts (pure, unit-tested):
  31/31 tests pass, including a regression test with a realistic
  `api_req_failed` transcript.
## [0.9.2] - 2026-09-28
### Fixed
- Orphan recovery now RESUMES the stranded Cline session instead of
  restarting from scratch: the session is matched by the
  `[backseat:task:<id>]` marker (or, for older tasks, by prompt-head +
  workspace match — never a manual chat), re-adopted with its full
  context, and watched with the same done-file / terminal-status /
  error-retry loop. The done-file is checked first in case Cline finished
  while the runner was dead. Only when no session can be matched does the
  task restart fresh.
## [0.9.1] - 2026-09-28
### Fixed
- Orphan recovery: tasks left in `tasks/active/` by a dead runner (extension
  upgrade, window reload, crash) are moved back to `tasks/pending/` on startup
  and run fresh. A task is only reclaimed when claimed by a different runner id
  AND its heartbeat is older than 5 minutes — live runners (e.g. another VS
  Code window) keep heartbeating, so they are never stolen.
- Verified against Cline's webview source: the "Resume Task" button is the
  primary button and sends the same `yesButtonClicked` response the extension
  API's `pressPrimaryButton()` fires — 0.9.0's auto-retry genuinely clicks it.
## 0.9.0

- **Backseat now reads Cline's session store** (`~/.cline/data/sessions/`,
  the plain-JSON store Cline's extension, CLI, and hub all share): each
  sidebar task is matched by a `[backseat:task:<id>]` marker in its prompt,
  and Backseat watches its live status, transcript, and liveness.
  Completion is detected from a terminal session status even if Cline never
  writes the done-file; an error visible in the transcript (provider
  rejection, rate limit, etc.) triggers a fast retry via the primary
  button; a quiet transcript triggers the 3-minute stall retry. The
  done-file remains the primary result carrier (Cline's summary).

## 0.8.1

- Sidebar tasks now watch workspace file activity as a liveness signal. If
  the workspace goes quiet for 3 minutes (e.g. a provider error is waiting
  on the retry button in the chat), Backseat presses Cline's primary button
  once per quiet spell — clicking retry/approve when one is showing, no-op
  otherwise. The Backseat tab shows the quiet/retry state.

## 0.8.0

- **Cline sidebar is now the primary task path**: tasks start visibly in the
  user's Cline chat via the extension API (`startNewTask`) — chat speed,
  user's own settings, and you can watch it work. Completion is a file
  handshake: the prompt instructs Cline to write `.backseat-done-<taskid>`
  (first line DONE or FAILED plus a summary) in the workspace root, which
  Backseat polls for. The headless CLI remains as automatic fallback when
  the Cline extension/API is unavailable.

## 0.7.6

- **Reverted 0.7.5's provider/model knobs**: the Cline CLI and the VS Code
  extension share one provider-settings file
  (`~/.cline/data/settings/providers.json`), so task runs already use the
  user's own provider/model with zero Backseat configuration. The manual
  `backseat.clineProvider`/`backseat.clineModel` settings are gone.
- Verified Cline 4.x's extension API (4 methods, no completion signal), so
  the CLI fallback is now the intended path by design — not a degraded
  mode. The doctor says so and shows what the shared providers file
  declares (secrets redacted).

## 0.7.5

- **Cline CLI provider/model settings**: the CLI does NOT inherit the VS Code
  extension's provider/model — it was silently using its own defaults
  (provider `cline`, model `anthropic/claude-sonnet-4.6`), which ran much
  slower than the user's VS Code setup. New `backseat.clineProvider` and
  `backseat.clineModel` settings (also in the dashboard setup card) are
  passed as `-P`/`-m` flags; the doctor reports which provider/model task
  runs will use.

## 0.7.4

- **CLI stdin closed**: the spawned Cline process now gets `stdio: ['ignore',
  'pipe', 'pipe']`. If the CLI ever waits on an interactive prompt
  (first-run trust, login), it receives EOF and fails fast with visible
  output instead of hanging silently until the task timeout.

## 0.7.3

- **CLI prompt quoting fixed**: on Windows the extension spawned the Cline
  CLI with `shell: true`, which joins the command with plain spaces — every
  multi-word prompt arrived as separate argv entries and Cline rejected it
  ("Unknown command or unquoted prompt"), so no task could ever run. The
  extension now routes through `cmd.exe /d /s /c` with `shell: false` so
  each argument is quoted correctly. The spawn target is a pure function
  (`clineSpawnTarget` in logic.ts) covered by unit tests.

## 0.7.2

- **Doctor push check**: `git push --dry-run` used to report a behind-origin
  clone as a permission failure ("fetch first…"). The doctor now fetches
  first and says plainly when the clone is behind, pointing at Check now to
  sync before re-running.

## 0.7.1

- **Seamless Muse-side setup**: the docs no longer ask new users to hand-craft
  a fine-grained token. `gh auth login` with the device flow (~30s, one code
  at github.com/device) is the documented default in README and MUSE.md;
  the token route is a fallback. Muse-side GitHub work is headless
  (`git`/`gh` CLI only) by documented rule.
- **Claim race fixed**: two watchers racing for the same task could both run
  it. Claims are now stamped with a unique `claimed_by` runner id; the loser
  of a rejected push reads the winner's stamp, backs off, and syncs cleanly.
  Verified with a two-clone git simulation.
- **Dashboard hardening**: the webview now ships a Content-Security-Policy
  with a script nonce (without it VS Code silently blocks the tab's buttons),
  the doctor renders inside the tab without yanking open the Output panel,
  and **Check now** runs a real poll cycle even while polling is stopped.
- **Tests**: `npm test` — 23 unit/static tests (pure logic + dashboard
  security contract), run headless with node:test, no new dependencies.
- **LICENSE**: MIT license added (package.json already claimed MIT).


## 0.7.0

- **Sidebar dashboard tab**: Backseat now has its own activity-bar tab (the
  steering-wheel icon) — live status, bridge-repo + ping-topic setup with a
  Save & connect button, Start/Stop/Check-now actions, the task queues, and
  the setup doctor with readable pass/fail results. No more settings JSON
  or Output-panel log diving for normal use.
- **Muse-side token rule**: `MUSE.md` now instructs the Muse to do all
  GitHub work headless via `git`/`gh` CLI — never open github.com in a
  browser to check the bridge.


## 0.6.2

- **Setup hardening**: if the auto-clone fails (usually the GitHub sign-in,
  which the extension can't do itself), you now get a "Run clone in terminal"
  button that opens a terminal with the exact `git clone` command ready —
  sign in there, reload, done. The doctor prints its own version (so a stale
  install is obvious), reports "bridge repo cloned" as its own check instead
  of failing confusing git checks, and no longer creates task directories
  when there's no repo. An incomplete managed clone is cleared automatically
  on the next start instead of asking you to delete it by hand.


- **Self-managed bridge clone**: the extension no longer needs you to open the
  bridge repo folder in VS Code. Set `backseat.bridgeRepo` to your private repo
  (`owner/repo` or a git URL) and the extension clones it into
  `~/.backseat/bridge` and manages it itself — Backseat now works in every VS
  Code window, whatever project you have open. `backseat.repoPath` remains as
  an advanced explicit-path override. If the setting ever points at a
  different repo than the managed clone, startup refuses with a clear error
  instead of syncing the wrong repo.



## 0.6.0

- **Instant task pickup via ntfy wake-ups**: the other half of the instant
  system. When set, `backseat.notifyTopic` now also opens an outbound listen
  stream on the topic — no open ports, no server. The Muse side pings the
  topic right after pushing a task file, and the extension polls within ~1
  second instead of waiting for the next interval. Automatic reconnect with
  backoff; if the stream ever dies, timer polling is still the fallback.
  `notify.json` now advertises both `task_finished` and `new_task` events.
- **Muse-side setup instructions beefed up**: `README.md` now walks through
  creating the fine-grained PAT (exact scopes, token expiry warning);
  `MUSE.md` tells the Muse to verify its GitHub access, watch for
  token-expiry symptoms, and publish the wake-up ping after every queued
  task. (ntfy is machine-to-machine signaling only — no app, no account.)

- **Setup Doctor honesty fix**: the "git push/pull auth works" check only ran
  `git ls-remote`, which proves *read* access. It is now labeled "git read
  access works (ls-remote)", and a new check runs `git push --dry-run` to
  prove *write* permission without pushing anything. The whole bridge is
  push-based (claims, statuses, results), so a read-only remote would have
  passed the old doctor and then failed at runtime.
- **No more notify.json churn**: the extension rewrote and pushed `notify.json`
  on every restart (the `updated_at` timestamp always differed). It now reads
  the published topic first and only writes/pushes when the topic actually
  changed.
- **Refactor for testability**: pure logic (error classification, retry
  policy, project-nickname resolution, projects.json auto-learn/forget merge
  rules, deleteProject protection, Cline history heuristics, notify-topic
  read) extracted from `extension.ts` into `src/logic.ts`; behavior unchanged.

## 0.5.0

- **Instant task-finished pings via ntfy.sh** (optional): set
  `backseat.notifyTopic` to any unguessable string and the extension POSTs a
  completion ping on every finished task — no account, no secrets, ~20 lines
  of code. The topic is published to `notify.json` in the bridge repo so any
  Muse discovers it automatically. Git stays the source of truth; the pings
  are just the doorbell, so a lost ping is harmless. Leave the setting empty
  to stay on git polling alone.
- **New logo**: Backseat finally looks like something — glowing steering
  wheel from the back seat, code brackets on the wheel. Ships as the
  extension icon.

- **Fixed a git deadlock**: both sides commit to the bridge repo, so pulls
  now rebase instead of failing on diverged history (previously the bridge
  could wedge itself with "pull failed" forever).
- **Project switching keeps remote control alive**: `openProject` /
  `newProject` add the project as a second workspace root instead of
  reloading the window onto it — the bridge repo stays open and your phone
  never goes dead. The repo path is also persisted across reloads.
- **Project nicknames**: command tasks accept `args.project` (a nickname from
  `projects.json`) instead of raw paths; the extension auto-learns the
  nickname → path mapping after successful opens/creates, and forgets it on
  delete.
- **Backseat: Run setup doctor** — new command that checks every link in the
  chain (repo detection, task dirs, git auth, `cline` CLI, Cline extension +
  API probe) and prints a pasteable report.
- **Quieter repo history**: heartbeats still write locally every ~30s but push
  at most every 2 minutes.
- **Fresh-clone bootstrap**: the extension creates `tasks/` dirs and
  `reports/` on start, so zero-config detection works on a brand-new template
  copy.
- Removed the legacy `agent/` and `pc/` Python scripts — the VS Code extension
  is the only PC side.

## 0.3.0

- Cline failure classification + automatic retry with backoff for transient
  failures (rate limits, network blips). Out-of-credits and context-overflow
  fail fast for Muse to triage instead of blind retrying.
- "When a task fails" triage playbook in `MUSE.md`.

## 0.2.0

- Command tasks (`kind: "command"`): `openProject`, `newProject`,
  `closeWindow`, `deleteProject` — manage projects from your phone.
- Cline summary trailer on every prompt, powering the morning digest.
- Overnight mode conventions in `MUSE.md`.

## 0.1.0

- Initial release: git-backed task queue, VS Code extension polls the bridge
  repo, drives Cline via extension API with CLI fallback, heartbeats and
  done-file reporting.
