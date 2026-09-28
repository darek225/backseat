# Backseat — VS Code extension (PC side)

This is the PC side of the bridge, as a VS Code extension. While VS Code is
open it polls the private bridge GitHub repo for pending architect tasks from
Muse, hands each prompt to Cline, and pushes status and results back. Close
VS Code and the bridge is off — nothing runs in the background.

The task protocol (`tasks/pending` → `tasks/active` → `tasks/done`, plus
`tasks/status/<id>.json`) is documented in `../protocol.md` and unchanged.

## Install on your PC

Prerequisites: VS Code with the Cline extension installed and signed in
(Cline holds your DeepSeek key — this extension never sees it), plus Git.

```bat
cd C:\Users\<you>\muse-cline-bridge\vscode-bridge
npm install
npm run compile
```

Then either:

- **Run it unpacked:** open this folder in VS Code and press `F5` (Extension
  Development Host), or
- **Package it:** `npx vsce package` then install the `.vsix` via
  `Extensions → … → Install from VSIX`.

## Configure

Open the bridge repo folder in VS Code and you're done — Backseat
auto-detects it. Or set these in VS Code settings (search "Backseat"):

| Setting | What it does |
|---|---|
| `backseat.repoPath` | Local clone of the bridge repo. Empty = auto-detect from the open folder. |
| `backseat.pollIntervalSec` | How often to pull and look for tasks (default 30). |
| `backseat.autoStart` | Start polling on VS Code launch (default true). |
| `backseat.clineCommand` | Cline CLI command for the fallback path (default `cline`; full path if needed). |
| `backseat.preferClineApi` | Try Cline's extension API first (default true). |
| `backseat.defaultTimeoutSec` | Kill a task after this long (default 1800). |

Commands (Ctrl+Shift+P): **Backseat: Start polling / Stop polling /
Check for tasks now / Show status**. A status-bar item and an Explorer view
("Backseat Tasks") show pending/active/done tasks; output goes to the
"Backseat" channel.

## Remote project control

Tasks with `"kind": "command"` drive VS Code itself instead of Cline, so the
user can manage projects entirely from their phone (see `protocol.md`):

| Command | What it does |
|---|---|
| `openProject` | Opens `args.path` in VS Code |
| `newProject` | Creates `args.path` (`git init` + stub README) and opens it |
| `closeWindow` | Publishes the done state, then closes VS Code |
| `deleteProject` | Permanently deletes `args.path` — requires `"confirm": "delete"`, and refuses home dir / repo / filesystem roots |

Every Cline run gets a summary trailer appended to its prompt ("end your
reply with a brief summary: what you changed and how to verify it"), so done
files carry what the morning digest needs.

## How it drives Cline

1. **Extension API (preferred):** activates `saoudrizwan.claude-dev` and
   calls its programmatic API. Cline's API surface is not officially
   documented, so the code probes it defensively (`startNewTask` +
   `getTaskHistory` for completion detection). If the shape isn't what we
   expect, it logs what it found and falls back — it never half-drives Cline.
2. **CLI fallback (tested):** spawns `cline --yolo "<prompt>"` in the task's
   `project_dir`, streams output, pushes heartbeats every ~30s, and reports
   the exit code. This is the documented headless path
   ([Cline CLI README](https://github.com/cline/cline/blob/main/apps/cli/README.md)).

Once `startNewTask()` has been called on the API path, the extension stays
on that path for the task (falling back to the CLI as well would run the
prompt twice).

## Failure handling

Cline prompts fail for flaky reasons — rate limits, network blips,
overloaded models. The extension classifies each failure:

- **Transient** (rate limit / network): retried with backoff (2 min, 10 min),
  up to `max_retries` per task (default 2).
- **Timeout on the CLI path**: retried like transient (the process was
  killed, so it's safe). Never auto-retried on the API path — the task may
  still be running in Cline's sidebar, and retrying would run it twice.
- **Out of credits / context overflow**: failed immediately, never blindly
  retried. Out-of-credits needs a human top-up; context overflow means Muse
  must split the task into smaller pieces.

A failed task never blocks the queue — the extension moves on to the next
pending task, and the failure details (`error_kind`, `attempts`, `error`)
land in the done file for Muse to triage.

## Security notes

- **Auto-approve is the point — and the risk.** Both paths run Cline with
  automatic tool approval so tasks complete unsupervised. Only queue tasks
  you trust, pointed at project directories.
- **No secrets in the repo.** Tasks carry prompts and paths only. Your
  DeepSeek key stays in Cline's own VS Code storage / CLI config on the PC.
- **No open ports.** The extension only shells out to `git` (outbound HTTPS
  to GitHub).
- One task at a time; the git push of the claim is the lock if two
  VS Code windows ever race.
