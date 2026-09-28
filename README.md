# Backseat

**Backseat-drive your Cline coding agent from your phone.**

Chat with Muse anywhere — your PC does the coding. You architect from the
couch; Cline builds in VS Code. No servers, no open ports, no shared API
keys. GitHub is the only wire.

```
you (phone) ──chat──▶ Muse (architect) ──git──▶ Backseat extension ──▶ Cline (builder)
   "add a login page"      queues tasks          runs them on your PC     in VS Code
```

## Instant setup

**1. Send this repo to your Muse.**
Paste the repo link into Muse and say *"set up Backseat with this repo."*
It reads `MUSE.md`, clones the repo, and starts watching for work. Its side
is fully automatic from there.

**2. Install the VS Code plugin.**
Download [`dist/backseat-0.1.0.vsix`](dist/backseat-0.1.0.vsix), then in
VS Code: Extensions → `…` → *Install from VSIX*. Requires the Cline extension
(signed in — your DeepSeek key never leaves your PC) and Git.

**3. Open this repo folder in VS Code.**
That's it — Backseat auto-detects the bridge repo and starts polling. No
settings, no terminal windows, no always-on scripts. Close VS Code and it's off.

Now chat with Muse: `status` to see what's happening, `queue: <description>`
to send Cline work.

## How it works

- **Muse** breaks your requests into tasks: `tasks/pending/<id>.json`
  (prompt, project dir, timeout — see `protocol.md`).
- **The Backseat extension** polls the repo, claims the oldest task
  (the git push is the lock), and hands the prompt to Cline — via Cline's
  extension API when available, falling back to the headless `cline --yolo`
  CLI. Live progress lands in `tasks/status/<id>.json`.
- **Finished tasks** move to `tasks/done/` with the result; Muse reports
  back in chat like a human would.

One task at a time. Heartbeats every ~30s while running. Muse's checks are
polling (every few minutes), so asking `status` in chat is the fast path.

## Security

- **Auto-approve is the point — and the risk.** Cline runs unsupervised, so
  only queue work you'd let run on its own, pointed at project directories.
- **No secrets in the repo.** Tasks carry prompts and paths only. API keys
  stay in Cline's own config on the PC.
- **Private repo recommended.**

## Files

- `MUSE.md` — setup brief: send the repo to any Muse and it configures itself
- `protocol.md` — exact JSON schemas for tasks and status files
- `vscode-bridge/` — the VS Code extension source (TypeScript)
- `dist/backseat-0.1.0.vsix` — packaged plugin, ready to install
- `pc/` — legacy standalone watcher (superseded by the extension; kept as reference)
- `agent/` — Muse-side poll script for scheduled checks
