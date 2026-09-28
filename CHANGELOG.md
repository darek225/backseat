# Changelog

## Unreleased

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
