/**
 * Muse <-> Cline Bridge — VS Code extension (PC side).
 *
 * Instead of an always-on background script, the bridge lives inside VS Code:
 * while VS Code is open it polls the private bridge GitHub repo for pending
 * architect tasks from Muse, hands each prompt to Cline, and pushes status
 * and results back to the repo. Close VS Code and the bridge is off.
 *
 * Task protocol (pending -> active -> done, plus tasks/status/<id>.json) is
 * documented in protocol.md at the repo root. This file implements the PC
 * side of that protocol.
 *
 * Driving Cline: the extension first tries Cline's own extension API
 * (saoudrizwan.claude-dev). Cline's API surface is not officially documented,
 * so the code below probes it defensively and falls back to the Cline CLI
 * (`cline --yolo "<prompt>"`, the documented headless path) whenever the API
 * shape is not what we expect. The CLI path is the tested one.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFile = promisify(cp.execFile);

/** Marketplace ID of the Cline extension (kept since the "Claude Dev" era). */
const CLINE_EXTENSION_ID = 'saoudrizwan.claude-dev';

const LOG_TAIL_LINES = 40;
const LOG_TAIL_BYTES = 8192;

// ---------------------------------------------------------------------------
// Types (mirror protocol.md)
// ---------------------------------------------------------------------------

interface BridgeTask {
  id: string;
  prompt: string;
  project_dir?: string;
  mode?: 'plan' | 'act';
  timeout_sec?: number;
  title?: string;
  notes?: string;
  labels?: string[];
  // written by this extension on completion (tasks/done/)
  result?: string;
  exit_code?: number;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
}

type TaskState = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';

interface BridgeConfig {
  repoPath: string;
  pollIntervalSec: number;
  autoStart: boolean;
  clineCommand: string;
  preferClineApi: boolean;
  defaultTimeoutSec: number;
  heartbeatSec: number;
}

/**
 * Best-effort shape of Cline's extension API.
 * NOT officially documented — verify against your installed Cline version.
 * (Roo Code, a Cline fork, documents startNewTask/clearTask/getTaskHistory/
 * resumeTask; Cline itself exposes createClineAPI from its exports module.)
 */
interface ClineApi {
  startNewTask?: (prompt: string, images?: string[]) => Promise<unknown>;
  getTaskHistory?: () => Promise<unknown[]>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function utcnow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tailLines(text: string, n = LOG_TAIL_LINES): string {
  return text.split('\n').slice(-n).join('\n');
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Atomic JSON write (tmp file + rename), safe on Windows. */
function writeJsonAtomic(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function git(repoDir: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFile('git', args, { cwd: repoDir, timeout: 120_000 });
    return { code: 0, out: String(stdout) + String(stderr) };
  } catch (e: any) {
    const out = String(e?.stdout ?? '') + String(e?.stderr ?? '') + String(e?.message ?? e);
    return { code: typeof e?.code === 'number' ? e.code : 1, out };
  }
}

/** git add -A, commit (if anything changed), push. Returns true on success. */
async function pushChanges(
  repoDir: string,
  message: string,
  out: vscode.OutputChannel,
): Promise<boolean> {
  let r = await git(repoDir, ['add', '-A']);
  if (r.code !== 0) {
    out.appendLine(`[bridge] git add failed: ${r.out.slice(-300)}`);
    return false;
  }
  r = await git(repoDir, ['commit', '-m', message]);
  if (r.code !== 0) {
    if (/nothing to commit/i.test(r.out)) {
      return true; // nothing changed — treat as success
    }
    out.appendLine(`[bridge] git commit failed: ${r.out.slice(-300)}`);
    return false;
  }
  r = await git(repoDir, ['push']);
  if (r.code !== 0) {
    out.appendLine(`[bridge] git push failed (will retry next cycle): ${r.out.slice(-500)}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Bridge runner
// ---------------------------------------------------------------------------

class BridgeRunner {
  private timer: NodeJS.Timeout | undefined;
  private taskRunning = false;
  private statusBar: vscode.StatusBarItem;
  private currentTaskLabel = '';

  tree: TaskTreeProvider | undefined;

  constructor(private out: vscode.OutputChannel, private ctx: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'museBridge.showStatus';
    ctx.subscriptions.push(this.statusBar);
  }

  get config(): BridgeConfig | undefined {
    const c = vscode.workspace.getConfiguration('museBridge');
    const repoPath = String(c.get('repoPath') ?? '').trim();
    if (!repoPath) {
      return undefined;
    }
    return {
      repoPath: path.resolve(repoPath.replace(/^~(?=$|[\\/])/, process.env.HOME ?? '')),
      pollIntervalSec: Number(c.get('pollIntervalSec') ?? 30),
      autoStart: Boolean(c.get('autoStart') ?? true),
      clineCommand: String(c.get('clineCommand') ?? 'cline'),
      preferClineApi: Boolean(c.get('preferClineApi') ?? true),
      defaultTimeoutSec: Number(c.get('defaultTimeoutSec') ?? 1800),
      heartbeatSec: Number(c.get('heartbeatSec') ?? 30),
    };
  }

  start(): void {
    this.stop();
    const cfg = this.config;
    if (!cfg) {
      vscode.window.showWarningMessage(
        'Muse Bridge: set "museBridge.repoPath" to your bridge repo clone first.',
      );
      return;
    }
    if (!fs.existsSync(path.join(cfg.repoPath, '.git'))) {
      vscode.window.showErrorMessage(`Muse Bridge: not a git repo: ${cfg.repoPath}`);
      return;
    }
    this.out.appendLine(`[bridge] starting, repo=${cfg.repoPath} every ${cfg.pollIntervalSec}s`);
    this.setStatus('idle');
    // Check immediately, then on the interval.
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), cfg.pollIntervalSec * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.setStatus('stopped');
    this.out.appendLine('[bridge] stopped');
  }

  get isRunning(): boolean {
    return !!this.timer;
  }

  private setStatus(kind: 'idle' | 'stopped' | 'working' | 'error', detail = ''): void {
    const icons: Record<string, string> = {
      idle: '$(check) Bridge: idle',
      stopped: '$(circle-slash) Bridge: off',
      working: '$(sync~spin) Bridge: working',
      error: '$(warning) Bridge: error',
    };
    this.statusBar.text = detail ? `${icons[kind]} ${detail}` : icons[kind];
    this.statusBar.tooltip = 'Muse ↔ Cline bridge — click for status';
    this.statusBar.show();
  }

  /** One poll cycle: pull, claim the oldest pending task, run it, report back. */
  async pollOnce(): Promise<void> {
    const cfg = this.config;
    if (!cfg || !this.isRunning || this.taskRunning) {
      return;
    }
    const pull = await git(cfg.repoPath, ['pull', '--ff-only']);
    if (pull.code !== 0) {
      this.out.appendLine(`[bridge] pull failed: ${pull.out.slice(-300)}`);
      this.setStatus('error', 'pull failed');
      return;
    }
    this.tree?.refresh();

    const pendingDir = path.join(cfg.repoPath, 'tasks', 'pending');
    let files: string[] = [];
    try {
      files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return; // no pending dir yet
    }
    if (files.length === 0) {
      this.setStatus('idle');
      return;
    }
    const task = this.claimTask(cfg, files[0]);
    if (!task) {
      return; // claim lost to another runner, or unreadable
    }
    this.taskRunning = true;
    this.currentTaskLabel = task.title || task.id;
    try {
      await this.executeTask(cfg, task);
    } catch (e: any) {
      this.out.appendLine(`[bridge] unexpected error running ${task.id}: ${e?.stack ?? e}`);
      await this.finishTask(cfg, task, 'failed', `runner error: ${e?.message ?? e}`, 1);
    } finally {
      this.taskRunning = false;
      this.currentTaskLabel = '';
      this.setStatus('idle');
      this.tree?.refresh();
    }
  }

  /**
   * Claim the oldest pending task. The push is the distributed lock:
   * whoever pushes the claim first wins; losers roll back.
   */
  private claimTask(cfg: BridgeConfig, filename: string): BridgeTask | undefined {
    const src = path.join(cfg.repoPath, 'tasks', 'pending', filename);
    const dst = path.join(cfg.repoPath, 'tasks', 'active', filename);
    let task: BridgeTask;
    try {
      task = readJson(src) as BridgeTask;
    } catch (e: any) {
      this.out.appendLine(`[bridge] skipping unreadable task ${filename}: ${e?.message}`);
      return undefined;
    }
    task.id = task.id || filename.replace(/\.json$/, '');

    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst); // local claim
    } catch (e: any) {
      this.out.appendLine(`[bridge] could not claim ${task.id}: ${e?.message}`);
      return undefined;
    }

    // The local move is the claim; executeTask() publishes it with git
    // (push = the distributed lock) before launching Cline.
    return task;
  }

  private async executeTask(cfg: BridgeConfig, task: BridgeTask): Promise<void> {
    this.setStatus('working', task.title || task.id);
    this.out.appendLine(`[bridge] claimed task ${task.id}: ${task.title ?? '(no title)'}`);
    this.tree?.refresh();

    // Publish the claim (the distributed lock) before doing any work.
    const claimed = await pushChanges(cfg.repoPath, `claim task ${task.id}`, this.out);
    if (!claimed) {
      // Re-sync: did someone else claim it first?
      await git(cfg.repoPath, ['pull', '--ff-only']);
      const stillOurs = fs.existsSync(path.join(cfg.repoPath, 'tasks', 'active', `${task.id}.json`));
      if (!stillOurs) {
        this.out.appendLine(`[bridge] claim lost for ${task.id} (taken by another runner)`);
        return;
      }
      // Otherwise the push failed for a transient reason; the local move
      // stands and the next push will carry it. Continue.
      this.out.appendLine(`[bridge] claim push failed transiently for ${task.id}; continuing`);
    }

    task.started_at = utcnow();
    await this.writeStatus(cfg, task.id, 'queued', '', 'starting');
    await pushChanges(cfg.repoPath, `task ${task.id}: queued`, this.out);

    const startedAt = Date.now();
    let result: TaskState = 'failed';
    let output = '';
    let exitCode = 1;

    if (cfg.preferClineApi) {
      const viaApi = await this.tryRunViaClineApi(cfg, task);
      if (viaApi) {
        ({ result, output, exitCode } = viaApi);
      } else {
        this.out.appendLine('[bridge] Cline API path unavailable — falling back to Cline CLI.');
        ({ result, output, exitCode } = await this.runViaCli(cfg, task));
      }
    } else {
      ({ result, output, exitCode } = await this.runViaCli(cfg, task));
    }

    this.out.appendLine(
      `[bridge] task ${task.id} finished: ${result} (exit ${exitCode}, ${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    await this.finishTask(cfg, task, result, output, exitCode);
  }

  // -- Cline extension API path -------------------------------------------

  /**
   * Drive the Cline VS Code extension through its programmatic API.
   * Returns null when the API surface is not usable (caller falls back to CLI).
   *
   * IMPORTANT: once startNewTask() has been invoked we must NOT fall back —
   * the task is already running inside Cline, and launching the CLI too
   * would run the prompt twice. From that point on we stay on the API path.
   */
  private async tryRunViaClineApi(
    cfg: BridgeConfig,
    task: BridgeTask,
  ): Promise<{ result: TaskState; output: string; exitCode: number } | null> {
    const ext = vscode.extensions.getExtension(CLINE_EXTENSION_ID);
    if (!ext) {
      this.out.appendLine('[bridge] Cline extension not installed/active.');
      return null;
    }
    let api: ClineApi;
    try {
      api = (await ext.activate()) as ClineApi;
    } catch (e: any) {
      this.out.appendLine(`[bridge] could not activate Cline extension: ${e?.message}`);
      return null;
    }
    if (typeof api?.startNewTask !== 'function') {
      this.out.appendLine(
        `[bridge] Cline API has no startNewTask (exports: ${Object.keys(api ?? {}).join(', ') || 'none'}).`,
      );
      return null;
    }
    if (typeof api.getTaskHistory !== 'function') {
      // Without a completion signal we cannot reliably finish the bridge
      // task, so stay on the tested CLI path instead of half-driving Cline.
      this.out.appendLine('[bridge] Cline API has no task-history/completion signal; using CLI.');
      return null;
    }

    // Snapshot history so we can recognise the task we are about to start.
    let beforeIds = new Set<string>();
    try {
      const hist = await api.getTaskHistory();
      beforeIds = new Set(hist.map((h) => idOf(h)).filter(Boolean) as string[]);
    } catch (e: any) {
      this.out.appendLine(`[bridge] getTaskHistory failed: ${e?.message}; using CLI.`);
      return null;
    }

    this.out.appendLine(`[bridge] starting Cline task via extension API: ${task.id}`);
    await this.writeStatus(cfg, task.id, 'running', '', 'cline (extension) working');
    await pushChanges(cfg.repoPath, `task ${task.id}: running`, this.out);

    try {
      await api.startNewTask(task.prompt);
    } catch (e: any) {
      return { result: 'failed', output: `startNewTask threw: ${e?.message ?? e}`, exitCode: 1 };
    }

    // Best-effort completion detection. Cline's history item schema is not
    // documented; we look for common completion markers on the new entry.
    // TODO: pin this to the installed Cline version's real schema.
    const timeoutMs = (task.timeout_sec ?? cfg.defaultTimeoutSec) * 1000;
    const started = Date.now();
    let lastHeartbeat = 0;
    while (Date.now() - started < timeoutMs) {
      await sleep(15_000);
      if (Date.now() - lastHeartbeat > cfg.heartbeatSec * 1000) {
        lastHeartbeat = Date.now();
        await this.writeStatus(cfg, task.id, 'running', '', 'cline (extension) working');
        await pushChanges(cfg.repoPath, `task ${task.id}: heartbeat`, this.out);
      }
      try {
        const hist = await api.getTaskHistory();
        const fresh = hist.filter((h) => {
          const id = idOf(h);
          return id && !beforeIds.has(id);
        });
        for (const entry of fresh) {
          const marker = completionMarker(entry);
          if (marker === 'done') {
            return { result: 'success', output: JSON.stringify(entry, null, 2).slice(0, 8000), exitCode: 0 };
          }
          if (marker === 'failed') {
            return { result: 'failed', output: JSON.stringify(entry, null, 2).slice(0, 8000), exitCode: 1 };
          }
        }
      } catch (e: any) {
        this.out.appendLine(`[bridge] history poll error: ${e?.message}`);
      }
    }
    return {
      result: 'timeout',
      output: 'Timed out waiting for Cline extension task completion. Cline may still be working in the sidebar.',
      exitCode: 124,
    };
  }

  // -- Cline CLI fallback path ---------------------------------------------

  /**
   * Run the prompt headlessly with the Cline CLI. Documented at
   * https://github.com/cline/cline/blob/main/apps/cli/README.md
   * (`cline --yolo "<prompt>"` auto-approves tools; only queue trusted tasks).
   */
  private runViaCli(
    cfg: BridgeConfig,
    task: BridgeTask,
  ): Promise<{ result: TaskState; output: string; exitCode: number }> {
    const projectDir =
      task.project_dir ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      cfg.repoPath;
    const timeoutMs = (task.timeout_sec ?? cfg.defaultTimeoutSec) * 1000;

    if (!fs.existsSync(projectDir)) {
      return Promise.resolve({
        result: 'failed',
        output: `project_dir does not exist: ${projectDir}`,
        exitCode: 1,
      });
    }

    this.out.appendLine(`[bridge] launching: ${cfg.clineCommand} --yolo (cwd=${projectDir})`);

    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      const done = (r: { result: TaskState; output: string; exitCode: number }) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };

      let child: cp.ChildProcess;
      try {
        child = cp.spawn(cfg.clineCommand, ['--yolo', task.prompt], {
          cwd: projectDir,
          // npm-installed CLIs are .cmd shims on Windows — need a shell there.
          shell: process.platform === 'win32',
          windowsHide: true,
        });
      } catch (e: any) {
        done({ result: 'failed', output: `could not launch cline: ${e?.message}`, exitCode: 1 });
        return;
      }

      const onData = (d: Buffer | string) => {
        const s = d.toString();
        output += s;
        if (output.length > 500_000) {
          output = output.slice(-250_000); // bound memory on very long runs
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => {
        clearInterval(heartbeat);
        clearTimeout(killer);
        done({
          result: 'failed',
          output: `cline not found (tried '${cfg.clineCommand}'). Set museBridge.clineCommand to the full path.\n${err.message}`,
          exitCode: 127,
        });
      });
      child.on('close', (code) => {
        clearInterval(heartbeat);
        clearTimeout(killer);
        done({
          result: code === 0 ? 'success' : 'failed',
          output,
          exitCode: code ?? 1,
        });
      });

      const heartbeat = setInterval(() => {
        void (async () => {
          await this.writeStatus(cfg, task.id, 'running', tailLines(output), 'cline working');
          await pushChanges(cfg.repoPath, `task ${task.id}: heartbeat`, this.out);
        })();
      }, cfg.heartbeatSec * 1000);

      const killer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        clearInterval(heartbeat);
        output += `\n[TIMEOUT after ${Math.round(timeoutMs / 1000)}s]`;
        done({ result: 'timeout', output, exitCode: 124 });
      }, timeoutMs);
      killer.unref?.();
    });
  }

  // -- Task finishing -------------------------------------------------------

  private async finishTask(
    cfg: BridgeConfig,
    task: BridgeTask,
    result: TaskState,
    output: string,
    exitCode: number,
  ): Promise<void> {
    task.result = result;
    task.exit_code = exitCode;
    task.finished_at = utcnow();
    if (result !== 'success') {
      task.error = tailLines(output, 20) || 'no output';
    } else {
      task.error = null;
    }

    const activePath = path.join(cfg.repoPath, 'tasks', 'active', `${task.id}.json`);
    const donePath = path.join(cfg.repoPath, 'tasks', 'done', `${task.id}.json`);
    try {
      if (fs.existsSync(activePath)) {
        const existing = readJson(activePath) as BridgeTask;
        task = { ...existing, ...task };
        fs.unlinkSync(activePath);
      }
      writeJsonAtomic(donePath, task);
    } catch (e: any) {
      this.out.appendLine(`[bridge] could not move task file for ${task.id}: ${e?.message}`);
    }

    await this.writeStatus(cfg, task.id, result, tailLines(output), `finished: ${result} (exit ${exitCode})`);
    await pushChanges(cfg.repoPath, `task ${task.id}: ${result}`, this.out);
  }

  private async writeStatus(
    cfg: BridgeConfig,
    taskId: string,
    state: TaskState,
    logTail: string,
    progressNote: string,
  ): Promise<void> {
    writeJsonAtomic(path.join(cfg.repoPath, 'tasks', 'status', `${taskId}.json`), {
      id: taskId,
      state,
      updated_at: utcnow(),
      heartbeat_at: utcnow(),
      log_tail: logTail.slice(-LOG_TAIL_BYTES),
      progress_note: progressNote,
    });
  }

  showStatus(): void {
    const cfg = this.config;
    const lines = [
      `Bridge: ${this.isRunning ? 'polling' : 'stopped'}`,
      `Repo: ${cfg?.repoPath ?? '(not configured)'}`,
      `Task in flight: ${this.taskRunning ? this.currentTaskLabel || 'yes' : 'none'}`,
    ];
    if (cfg) {
      for (const kind of ['pending', 'active', 'done'] as const) {
        try {
          const n = fs
            .readdirSync(path.join(cfg.repoPath, 'tasks', kind))
            .filter((f) => f.endsWith('.json')).length;
          lines.push(`${kind}: ${n}`);
        } catch {
          lines.push(`${kind}: ?`);
        }
      }
    }
    this.out.show();
    this.out.appendLine('[bridge] ' + lines.join(' | '));
    vscode.window.showInformationMessage(lines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Completion-marker heuristics for Cline's (undocumented) history schema
// ---------------------------------------------------------------------------

function idOf(entry: unknown): string | undefined {
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    for (const k of ['id', 'taskId', 'task_id']) {
      if (typeof o[k] === 'string' && (o[k] as string)) {
        return o[k] as string;
      }
    }
  }
  return undefined;
}

/** Returns 'done' | 'failed' | undefined based on common completion markers. */
function completionMarker(entry: unknown): 'done' | 'failed' | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const o = entry as Record<string, unknown>;
  const candidates: unknown[] = [o.status, o.state, o.result, o.completed, o.isComplete, o.done];
  for (const c of candidates) {
    const s = String(c ?? '').toLowerCase();
    if (/(complete|done|finish|success)/.test(s) && !/incomplete|unfinished/.test(s)) {
      return 'done';
    }
    if (/(fail|error|cancel|abort)/.test(s)) {
      return 'failed';
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Task tree view (Explorer sidebar)
// ---------------------------------------------------------------------------

class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: string,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly filePath: string,
  ) {
    super(label, collapsible);
    this.contextValue = 'bridgeTask';
  }
}

class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private readonly emitter = new vscode.EventEmitter<void | TaskTreeItem>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private runner: BridgeRunner) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(el: TaskTreeItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: TaskTreeItem): Thenable<TaskTreeItem[]> {
    const cfg = this.runner.config;
    if (!cfg?.repoPath) {
      return Promise.resolve([]);
    }
    if (!el) {
      return Promise.resolve(
        ['pending', 'active', 'done'].map(
          (kind) => new TaskTreeItem(kind, kind, vscode.TreeItemCollapsibleState.Collapsed, ''),
        ),
      );
    }
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(path.join(cfg.repoPath, 'tasks', el.kind))
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      files.map((f) => {
        const full = path.join(cfg.repoPath, 'tasks', el.kind, f);
        let label = f.replace(/\.json$/, '');
        try {
          const t = readJson(full) as BridgeTask;
          label = t.title || t.id || label;
        } catch {
          /* keep filename */
        }
        const item = new TaskTreeItem(el.kind, label, vscode.TreeItemCollapsibleState.None, full);
        item.command = {
          command: 'vscode.open',
          title: 'Open task JSON',
          arguments: [vscode.Uri.file(full)],
        };
        item.tooltip = full;
        return item;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Muse Bridge');
  context.subscriptions.push(out);

  const runner = new BridgeRunner(out, context);
  const tree = new TaskTreeProvider(runner);
  runner.tree = tree;
  context.subscriptions.push(vscode.window.registerTreeDataProvider('museBridge.tasks', tree));

  context.subscriptions.push(
    vscode.commands.registerCommand('museBridge.start', () => {
      runner.start();
      out.show();
    }),
    vscode.commands.registerCommand('museBridge.stop', () => runner.stop()),
    vscode.commands.registerCommand('museBridge.runOnce', () => void runner.pollOnce()),
    vscode.commands.registerCommand('museBridge.showStatus', () => runner.showStatus()),
  );

  // Refresh the tree whenever the repo changes on disk (e.g. after git pull).
  const cfg = runner.config;
  if (cfg?.repoPath && fs.existsSync(cfg.repoPath)) {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(cfg.repoPath, 'tasks/**/*.json'),
      );
      const refresh = () => tree.refresh();
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      context.subscriptions.push(watcher);
    } catch {
      /* file watching is best-effort */
    }
  }

  if (runner.config?.autoStart) {
    runner.start();
  } else if (!runner.config) {
    out.appendLine('[bridge] set "museBridge.repoPath" to enable polling.');
  }

  out.appendLine('[bridge] extension activated');
}

export function deactivate(): void {
  // Interval timers are disposed with the extension host; nothing to persist.
}
