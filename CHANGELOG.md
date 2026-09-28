# Changelog

## 0.6.0

- **Instant task pickup via ntfy wake-ups**: the other half of the instant
  system. When set, `backseat.notifyTopic` now also opens an outbound listen
  stream on the topic — no open ports, no server. The Muse side pings the
  topic right after pushing a task file, and the extension polls within ~1
  second instead of waiting for the next interval. Automatic reconnect with
  backoff; if the stream ever dies, timer polling is still the fallback.
  `notify.json` now advertises both `task_finished` and `new_task` events.
- **Muse-side setup instructions beefed up**: `README.md` now walks through
  creating the fine-grained PAT (exact scopes, token expiry warning) and the
  optional ntfy phone subscription; `MUSE.md` tells the Muse to verify its
  GitHub access, watch for token-expiry symptoms, and publish the wake-up
  ping after every queued task.

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
