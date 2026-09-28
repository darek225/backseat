# Muse ↔ Cline Bridge — VS Code extension (PC side)

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

Set these in VS Code settings (search "Muse Bridge"):

| Setting | What it does |
|---|---|
| `museBridge.repoPath` | Local clone of the bridge repo, e.g. `C:\Users\Darek\muse-cline-bridge`. Empty = bridge disabled. |
| `museBridge.pollIntervalSec` | How often to pull and look for tasks (default 30). |
| `museBridge.autoStart` | Start polling on VS Code launch (default true). |
| `museBridge.clineCommand` | Cline CLI command for the fallback path (default `cline`; full path if needed). |
| `museBridge.preferClineApi` | Try Cline's extension API first (default true). |
| `museBridge.defaultTimeoutSec` | Kill a task after this long (default 1800). |

Commands (Ctrl+Shift+P): **Muse Bridge: Start polling / Stop polling /
Check for tasks now / Show status**. A status-bar item and an Explorer view
("Muse Bridge Tasks") show pending/active/done tasks; output goes to the
"Muse Bridge" channel.

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
