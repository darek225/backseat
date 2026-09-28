/**
 * Backseat — VS Code extension (PC side).
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
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  ErrorKind,
  TaskState,
  bridgeRepoUrl,
  classifyError,
  clineSpawnTarget,
  completionMarker,
  deleteProtectionReason,
  idOf,
  mergeForgottenProject,
  mergeLearnedProject,
  readPublishedNotifyTopic,
  resolveProjectTarget as resolveProjectTargetPure,
  shouldRetryTask,
  tailLines,
  utcnow,
} from './logic';
import {
  DashboardBackend,
  DashboardState,
  DashboardTask,
  SidebarProvider,
} from './sidebar';

const execFile = promisify(cp.execFile);

/** Marketplace ID of the Cline extension (kept since the "Claude Dev" era). */
const CLINE_EXTENSION_ID = 'saoudrizwan.claude-dev';

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
  // Command tasks (kind: "command") drive VS Code itself — open, create,
  // close, or delete projects — instead of running Cline. prompt may be
  // empty for command tasks.
  kind?: 'cline' | 'command';
  command?: 'openProject' | 'newProject' | 'closeWindow' | 'deleteProject';
  args?: { path?: string; name?: string; project?: string };
  confirm?: string; // deleteProject requires confirm: "delete"
  max_retries?: number; // retries for transient failures (default 2)
  claimed_by?: string; // written by this extension on claim: unique runner id
  attempts?: number; // written by this extension: total Cline attempts
  error_kind?: ErrorKind; // written by this extension on failure
  // written by this extension on completion (tasks/done/)
  result?: string;
  exit_code?: number;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
}

interface BridgeConfig {
  repoPath: string;
  /** Set when the repo is the extension's self-managed clone: URL to clone/verify. */
  cloneUrl?: string;
  pollIntervalSec: number;
  autoStart: boolean;
  clineCommand: string;
  preferClineApi: boolean;
  defaultTimeoutSec: number;
  heartbeatSec: number;
  notifyTopic: string; // ntfy.sh topic for instant task-finished pings ("" = off)
}

/** Where the extension keeps its self-managed bridge clone. */
function managedBridgeDir(): string {
  return path.join(os.homedir(), '.backseat', 'bridge');
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    out.appendLine(`[backseat] git add failed: ${r.out.slice(-300)}`);
    return false;
  }
  r = await git(repoDir, ['commit', '-m', message]);
  if (r.code !== 0) {
    if (/nothing to commit/i.test(r.out)) {
      return true; // nothing changed — treat as success
    }
    out.appendLine(`[backseat] git commit failed: ${r.out.slice(-300)}`);
    return false;
  }
  r = await git(repoDir, ['push']);
  if (r.code !== 0) {
    out.appendLine(`[backseat] git push failed (will retry next cycle): ${r.out.slice(-500)}`);
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
  /** ntfy wake-up stream (Muse → PC instant wake, outbound HTTPS only — no open ports). */
  private ntfyReq: ReturnType<typeof https.request> | undefined;
  private ntfyReconnectTimer: NodeJS.Timeout | undefined;
  private ntfyWatchdog: NodeJS.Timeout | undefined;
  private ntfyStopped = true;
  private ntfyBackoffMs = 5000;
  private wakePollQueued = false;
  private statusBar: vscode.StatusBarItem;
  private currentTaskLabel = '';
  private lastPushAt = 0;
  /**
   * Unique id for this extension-host process. Stamped into every claim as
   * `claimed_by` so that when two runners race for the same task, the loser
   * can tell the winner's claim from its own after a rejected push.
   */
  private readonly runnerId = `${os.hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  /** Heartbeats push at most this often — a commit every 30s all night is noise. */
  private static readonly PUSH_THROTTLE_MS = 120_000;

  // Dashboard state (mirrored from setStatus so the sidebar can render it).
  private statusKind: 'idle' | 'stopped' | 'working' | 'error' = 'stopped';
  private statusDetail = '';
  private readonly stateChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever polling state, status, or task state changes. */
  readonly onDidChangeState = this.stateChangeEmitter.event;

  tree: TaskTreeProvider | undefined;

  constructor(private out: vscode.OutputChannel, private ctx: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'backseat.showStatus';
    ctx.subscriptions.push(this.statusBar);
  }

  get config(): BridgeConfig | undefined {
    const c = vscode.workspace.getConfiguration('backseat');
    const resolved = this.resolveRepo(c);
    if (!resolved) {
      return undefined;
    }
    return {
      repoPath: resolved.repoPath,
      cloneUrl: resolved.cloneUrl,
      pollIntervalSec: Number(c.get('pollIntervalSec') ?? 30),
      autoStart: Boolean(c.get('autoStart') ?? true),
      clineCommand: String(c.get('clineCommand') ?? 'cline'),
      preferClineApi: Boolean(c.get('preferClineApi') ?? true),
      defaultTimeoutSec: Number(c.get('defaultTimeoutSec') ?? 1800),
      heartbeatSec: Number(c.get('heartbeatSec') ?? 30),
      notifyTopic: String(c.get('notifyTopic') ?? '').trim(),
    };
  }

  /**
   * Where should the bridge repo live? Priority:
   * 1. `backseat.repoPath` — explicit local path (advanced override).
   * 2. `backseat.bridgeRepo` — "owner/repo" or git URL; the extension keeps
   *    its own clone in ~/.backseat/bridge, so Backseat works in every VS Code
   *    window without opening any special folder.
   * 3. Previously auto-detected path persisted in globalState.
   * 4. Zero-config: an open workspace folder that looks like the bridge repo.
   */
  private resolveRepo(
    c: vscode.WorkspaceConfiguration,
  ): { repoPath: string; cloneUrl?: string } | undefined {
    const explicit = String(c.get('repoPath') ?? '').trim();
    if (explicit) {
      return { repoPath: path.resolve(explicit.replace(/^~(?=$|[\\/])/, os.homedir())) };
    }
    const cloneUrl = bridgeRepoUrl(String(c.get('bridgeRepo') ?? ''));
    if (cloneUrl) {
      return { repoPath: managedBridgeDir(), cloneUrl };
    }
    // Survives window reloads (e.g. after switching projects): prefer the
    // persisted path from the last successful detection.
    const stored = this.ctx.globalState.get<string>('backseat.repoPath') ?? '';
    if (stored && fs.existsSync(path.join(stored, 'protocol.md'))) {
      return { repoPath: stored };
    }
    // Zero-config: if an open workspace folder looks like the bridge repo,
    // just use it — no settings needed. (Match on the docs, not the task
    // dirs: a fresh template clone has no task dirs until we bootstrap
    // them in start().)
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found = folders.find(
      (f) =>
        fs.existsSync(path.join(f.uri.fsPath, 'protocol.md')) &&
        fs.existsSync(path.join(f.uri.fsPath, 'MUSE.md')),
    );
    if (found) {
      const repoPath = found.uri.fsPath;
      this.out.appendLine(`[backseat] auto-detected bridge repo: ${repoPath}`);
      void this.ctx.globalState.update('backseat.repoPath', repoPath);
      return { repoPath };
    }
    return undefined;
  }

  async start(): Promise<void> {
    this.stop();
    const cfg = this.config;
    if (!cfg) {
      vscode.window.showWarningMessage(
        'Backseat: set "backseat.bridgeRepo" to your private bridge repo (e.g. "you/backseat-bridge"). The extension clones and manages it automatically — no folder to open.',
      );
      return;
    }
    if (cfg.cloneUrl) {
      // Self-managed clone: create it on first run, sanity-check it after.
      if (!fs.existsSync(path.join(cfg.repoPath, '.git'))) {
        if (fs.existsSync(cfg.repoPath)) {
          // Leftover from a failed clone (or the doctor's bootstrapping):
          // the managed dir is fully owned by the extension, so clear it
          // and start clean instead of making the user delete it by hand.
          this.out.appendLine(`[backseat] clearing incomplete managed clone at ${cfg.repoPath}`);
          try {
            fs.rmSync(cfg.repoPath, { recursive: true, force: true });
          } catch (e: any) {
            vscode.window.showErrorMessage(
              `Backseat: could not clear ${cfg.repoPath} (${e?.message}). Delete it manually and reload.`,
            );
            return;
          }
        }
        this.out.appendLine(`[backseat] cloning bridge repo to ${cfg.repoPath} ...`);
        try {
          fs.mkdirSync(path.dirname(cfg.repoPath), { recursive: true });
        } catch {
          /* ignore */
        }
        const clone = await git(os.homedir(), ['clone', cfg.cloneUrl, cfg.repoPath]);
        if (clone.code !== 0 || !fs.existsSync(path.join(cfg.repoPath, '.git'))) {
          this.out.appendLine(`[backseat] clone failed: ${clone.out.slice(-500)}`);
          // The usual cause is GitHub auth: the extension can't do the
          // interactive sign-in, so hand the user a terminal with the exact
          // command ready to run — the login popup works fine there.
          const choice = await vscode.window.showErrorMessage(
            'Backseat: could not clone the bridge repo (usually the GitHub sign-in — the extension can\'t do that part).',
            'Run clone in terminal',
          );
          if (choice === 'Run clone in terminal') {
            const term = vscode.window.createTerminal('Backseat setup');
            term.show();
            term.sendText(`git clone "${cfg.cloneUrl}" "${cfg.repoPath}"`, true);
            vscode.window.showInformationMessage(
              'Backseat: sign in to GitHub in the terminal, then reload the window (Ctrl+Shift+P → Reload Window).',
            );
          }
          return;
        }
        this.out.appendLine('[backseat] bridge repo cloned.');
      } else {
        // Guard against a changed backseat.bridgeRepo pointing at a new repo
        // while the old clone is still on disk.
        const origin = (await git(cfg.repoPath, ['remote', 'get-url', 'origin'])).out.trim();
        const norm = (u: string) => u.replace(/\.git$/, '').replace(/\/$/, '');
        if (origin && norm(origin) !== norm(cfg.cloneUrl)) {
          vscode.window.showErrorMessage(
            `Backseat: the managed clone at ${cfg.repoPath} points at ${origin}, but "backseat.bridgeRepo" wants ${cfg.cloneUrl}. Delete the folder to re-clone, or fix the setting.`,
          );
          return;
        }
      }
    } else if (!fs.existsSync(path.join(cfg.repoPath, '.git'))) {
      vscode.window.showErrorMessage(`Backseat: not a git repo: ${cfg.repoPath}`);
      return;
    }
    // Bootstrap a fresh template clone: git won't track empty dirs, so make
    // sure the queue layout exists before polling.
    for (const d of ['tasks/pending', 'tasks/active', 'tasks/done', 'tasks/status', 'reports']) {
      try {
        fs.mkdirSync(path.join(cfg.repoPath, d), { recursive: true });
      } catch {
        /* non-fatal */
      }
    }
    // Publish the ntfy topic (if configured) so any Muse can discover it
    // from the repo — pairing stays repo-based, no extra setup step.
    // Only write/push when the topic actually changed: rewriting
    // updated_at on every restart would commit noise each time.
    if (cfg.notifyTopic && readPublishedNotifyTopic(cfg.repoPath) !== cfg.notifyTopic) {
      writeJsonAtomic(path.join(cfg.repoPath, 'notify.json'), {
        topic: cfg.notifyTopic,
        events: ['task_finished', 'new_task'],
        updated_at: utcnow(),
      });
      await pushChanges(cfg.repoPath, 'notify.json: publish ntfy topic', this.out);
    }
    this.out.appendLine(`[backseat] starting, repo=${cfg.repoPath} every ${cfg.pollIntervalSec}s`);
    this.setStatus('idle');
    // Check immediately, then on the interval.
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), cfg.pollIntervalSec * 1000);
    // Instant wake-ups: the Muse side pings the ntfy topic after pushing a
    // task, so pickup is ~1s instead of up to one poll interval. The stream
    // is best-effort — timer polling always remains the fallback.
    this.startNtfyWake(cfg);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.stopNtfyWake();
    this.setStatus('stopped');
    this.out.appendLine('[backseat] stopped');
  }

  /**
   * Instant wake-up subscription (Muse → PC). Holds an outbound SSE/JSON
   * stream on the ntfy topic — no open ports, no server. When the Muse side
   * publishes a ping after pushing a task file, we poll immediately instead
   * of waiting for the next interval. Never throws: a dead stream just
   * means we fall back to timer polling.
   */
  private startNtfyWake(cfg: BridgeConfig): void {
    this.stopNtfyWake();
    const topic = cfg.notifyTopic?.trim();
    if (!topic) {
      return;
    }
    this.ntfyStopped = false;
    this.ntfyBackoffMs = 5000;
    const streamPath = `/${encodeURIComponent(topic)}/json`;
    const WATCHDOG_MS = 5 * 60_000;

    const armWatchdog = () => {
      if (this.ntfyWatchdog) {
        clearTimeout(this.ntfyWatchdog);
      }
      this.ntfyWatchdog = setTimeout(() => {
        this.out.appendLine('[backseat] ntfy wake stream quiet too long, reconnecting');
        this.ntfyReq?.destroy();
        // 'close'/'error' on the request schedules the reconnect.
      }, WATCHDOG_MS);
    };

    const scheduleReconnect = () => {
      if (this.ntfyStopped) {
        return;
      }
      const delay = this.ntfyBackoffMs;
      this.ntfyBackoffMs = Math.min(this.ntfyBackoffMs * 2, 60_000);
      this.ntfyReconnectTimer = setTimeout(connect, delay);
      this.out.appendLine(`[backseat] ntfy wake stream reconnecting in ${Math.round(delay / 1000)}s`);
    };

    const connect = () => {
      if (this.ntfyStopped) {
        return;
      }
      let buf = '';
      const req = https.request(
        { hostname: 'ntfy.sh', path: streamPath, method: 'GET', headers: { Accept: 'application/json' } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            this.out.appendLine(`[backseat] ntfy wake stream HTTP ${res.statusCode} (non-fatal)`);
            scheduleReconnect();
            return;
          }
          this.ntfyBackoffMs = 5000; // healthy connection: reset backoff
          this.out.appendLine('[backseat] ntfy wake stream connected — task pickup is instant');
          armWatchdog();
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            armWatchdog();
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) {
                continue;
              }
              try {
                const msg = JSON.parse(line);
                // Any published message on our topic is a doorbell: pull
                // now instead of waiting for the next interval.
                if (msg && msg.event === 'message') {
                  this.queueWakePoll();
                }
              } catch {
                /* ignore malformed lines */
              }
            }
          });
          res.on('end', scheduleReconnect);
          res.on('close', scheduleReconnect);
        },
      );
      req.on('error', (e) => {
        this.out.appendLine(`[backseat] ntfy wake stream error (non-fatal): ${(e as Error).message}`);
        scheduleReconnect();
      });
      req.end();
      this.ntfyReq = req;
    };

    connect();
  }

  private stopNtfyWake(): void {
    this.ntfyStopped = true;
    if (this.ntfyReconnectTimer) {
      clearTimeout(this.ntfyReconnectTimer);
      this.ntfyReconnectTimer = undefined;
    }
    if (this.ntfyWatchdog) {
      clearTimeout(this.ntfyWatchdog);
      this.ntfyWatchdog = undefined;
    }
    if (this.ntfyReq) {
      this.ntfyReq.destroy();
      this.ntfyReq = undefined;
    }
  }

  /** Wake-up from the ntfy stream: poll now, debounced so a burst of pings = one pull. */
  private queueWakePoll(): void {
    if (this.wakePollQueued) {
      return;
    }
    this.wakePollQueued = true;
    setTimeout(() => {
      this.wakePollQueued = false;
      void this.pollOnce();
    }, 500);
  }

  get isRunning(): boolean {
    return !!this.timer;
  }

  private setStatus(kind: 'idle' | 'stopped' | 'working' | 'error', detail = ''): void {
    this.statusKind = kind;
    this.statusDetail = detail;
    this.stateChangeEmitter.fire();
    const icons: Record<string, string> = {
      idle: '$(check) Backseat: idle',
      stopped: '$(circle-slash) Backseat: off',
      working: '$(sync~spin) Backseat: working',
      error: '$(warning) Backseat: error',
    };
    this.statusBar.text = detail ? `${icons[kind]} ${detail}` : icons[kind];
    this.statusBar.tooltip = 'Muse ↔ Cline bridge — click for status';
    this.statusBar.show();
  }

  /** Timer-driven poll cycle (no-op unless polling is running). */
  async pollOnce(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    await this.doPoll();
  }

  /** Manual "check now": one full poll cycle even while the timer is stopped. */
  async checkNow(): Promise<void> {
    if (!this.config) {
      this.setStatus('error', 'set your bridge repo first');
      return;
    }
    await this.doPoll();
  }

  /** One poll cycle: pull, claim the oldest pending task, run it, report back. */
  private async doPoll(): Promise<void> {
    const cfg = this.config;
    if (!cfg || this.taskRunning) {
      return;
    }
    // Both sides commit to this repo (Muse queues tasks, we push heartbeats),
    // so rebase rather than fast-forward-only: a diverged history must not
    // wedge the bridge.
    const pull = await git(cfg.repoPath, ['pull', '--rebase']);
    if (pull.code !== 0) {
      this.out.appendLine(`[backseat] pull failed: ${pull.out.slice(-300)}`);
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
      if (task.kind === 'command') {
        await this.executeCommandTask(cfg, task);
      } else {
        await this.executeTask(cfg, task);
      }
    } catch (e: any) {
      this.out.appendLine(`[backseat] unexpected error running ${task.id}: ${e?.stack ?? e}`);
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
      this.out.appendLine(`[backseat] skipping unreadable task ${filename}: ${e?.message}`);
      return undefined;
    }
    task.id = task.id || filename.replace(/\.json$/, '');

    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst); // local claim
      task.claimed_by = this.runnerId;
      writeJsonAtomic(dst, task); // the stamp travels with the pushed claim
    } catch (e: any) {
      this.out.appendLine(`[backseat] could not claim ${task.id}: ${e?.message}`);
      return undefined;
    }

    // The local move is the claim; executeTask() publishes it with git
    // (push = the distributed lock) before launching Cline.
    return task;
  }

  /** Upstream ref of the bridge clone's current branch (e.g. "origin/main"). */
  private async upstreamRef(repoPath: string): Promise<string | undefined> {
    const r = await git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (r.code !== 0) {
      return undefined;
    }
    const ref = r.out.trim().split('\n')[0].trim();
    return ref && ref !== '@{u}' ? ref : undefined;
  }

  /** Read a JSON file as it exists on the given ref, without touching the working tree. */
  private async readRefJson(repoPath: string, ref: string, relPath: string): Promise<any | undefined> {
    const r = await git(repoPath, ['show', `${ref}:${relPath}`]);
    if (r.code !== 0) {
      return undefined;
    }
    try {
      return JSON.parse(r.out);
    } catch {
      return undefined;
    }
  }

  /**
   * Publish the local claim (the distributed lock). Returns false when the
   * claim was lost to another runner (caller should stop).
   *
   * The push is the arbiter: whoever's push lands first wins. On a rejected
   * push we fetch and read the winner's `claimed_by` stamp. (The old code
   * only checked that *a* claim file exists, which can't tell our claim from
   * theirs — so both runners ran the task.)
   */
  private async publishClaim(cfg: BridgeConfig, task: BridgeTask): Promise<boolean> {
    if (await pushChanges(cfg.repoPath, `claim task ${task.id}`, this.out)) {
      return true;
    }
    // Push rejected. Fetch and see who actually holds the claim.
    await git(cfg.repoPath, ['fetch', 'origin']);
    const upstream = await this.upstreamRef(cfg.repoPath);
    const winner = upstream
      ? await this.readRefJson(cfg.repoPath, upstream, `tasks/active/${task.id}.json`)
      : undefined;
    const winnerId = typeof winner?.claimed_by === 'string' ? winner.claimed_by : '';
    if (!winnerId) {
      // Nobody holds the claim on origin — the push failed for a transient
      // reason (network/auth). The local move stands and the next push will
      // carry it. Continue.
      this.out.appendLine(`[backseat] claim push failed transiently for ${task.id}; continuing`);
      return true;
    }
    if (winnerId === this.runnerId) {
      // Our push actually landed despite the error report. Continue.
      return true;
    }
    // Lost the race. Uncommit ONLY our claim (it is always the tip here —
    // single-threaded poll loop), point these two paths at the winner's
    // state, and commit that as a sync commit. The sync commit's tree matches
    // origin exactly, so the next pull --rebase drops it as empty and any
    // older unpushed work (heartbeats, finished-task results) rebases cleanly.
    this.out.appendLine(`[backseat] claim lost for ${task.id} (held by ${winnerId})`);
    const tip = await git(cfg.repoPath, ['log', '-1', '--format=%s']);
    if (tip.code === 0 && tip.out.trim().startsWith(`claim task ${task.id}`)) {
      await git(cfg.repoPath, ['reset', '--soft', 'HEAD~1']);
      const w = await git(cfg.repoPath, ['show', `${upstream}:tasks/active/${task.id}.json`]);
      let winnerJson = '';
      try {
        winnerJson = JSON.parse(w.out);
      } catch {
        winnerJson = '';
      }
      if (w.code === 0 && winnerJson) {
        // pending/<id>.json stays deleted (staged) — origin doesn't have it
        // either. active/<id>.json becomes the winner's version.
        fs.writeFileSync(
          path.join(cfg.repoPath, 'tasks', 'active', `${task.id}.json`),
          JSON.stringify(winnerJson, null, 2),
          'utf8',
        );
        await git(cfg.repoPath, ['add', '--', `tasks/active/${task.id}.json`]);
        await git(cfg.repoPath, ['commit', '-m', `backseat: drop losing claim for ${task.id} (held by ${winnerId})`]);
      } else {
        this.out.appendLine(`[backseat] WARNING: could not read winner's claim; leaving uncommitted for manual review`);
      }
    } else {
      this.out.appendLine(`[backseat] WARNING: claim commit is not the tip; leaving working tree for manual review`);
    }
    return false;
  }

  /** Map a CLI run's outcome to an ErrorKind for the retry policy. */
  private classifyCliResult(result: TaskState, output: string): ErrorKind {
    if (result === 'success') {
      return 'failed'; // unused on success
    }
    if (result === 'timeout') {
      return 'timeout'; // we killed the process, so retrying is safe
    }
    return classifyError(output);
  }

  /** Push, but throttle routine heartbeats so the repo history stays readable. */
  private async pushThrottled(repoPath: string, message: string, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPushAt < BridgeRunner.PUSH_THROTTLE_MS) {
      return;
    }
    this.lastPushAt = now;
    await pushChanges(repoPath, message, this.out);
  }

  /** Sleep that aborts early when the bridge is stopped. */
  private async sleepInterruptible(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!this.isRunning) {
        return false;
      }
      await sleep(Math.min(5000, end - Date.now()));
    }
    return this.isRunning;
  }

  private async executeTask(cfg: BridgeConfig, task: BridgeTask): Promise<void> {
    this.setStatus('working', task.title || task.id);
    this.out.appendLine(`[backseat] claimed task ${task.id}: ${task.title ?? '(no title)'}`);
    this.tree?.refresh();

    // Publish the claim (the distributed lock) before doing any work.
    if (!(await this.publishClaim(cfg, task))) {
      return;
    }

    task.started_at = utcnow();
    await this.writeStatus(cfg, task.id, 'queued', '', 'starting');
    await pushChanges(cfg.repoPath, `task ${task.id}: queued`, this.out);

    // Ask Cline to end with a short summary — it lands in the done file and
    // powers the morning digest. (Not stored in the task JSON.)
    const summaryTrailer =
      task.mode === 'plan'
        ? '\n\nWhen you are finished, end your reply with a brief summary of your findings.'
        : '\n\nWhen you are finished, end your reply with a brief summary: what you changed (files touched) and how to verify it works.';
    const prompt = `${task.prompt}${summaryTrailer}`;

    const startedAt = Date.now();
    let result: TaskState = 'failed';
    let output = '';
    let exitCode = 1;
    let errorKind: ErrorKind = 'failed';

    // Retry loop: transient failures (rate limits, network blips) get
    // retried with backoff so one flaky run doesn't stall the queue.
    // no_credits and context_overflow fail fast — retrying identically
    // would fail identically; Muse triages those instead.
    const maxRetries = task.max_retries ?? 2;
    let attempt = 0;
    for (;;) {
      attempt++;
      task.attempts = attempt;
      let via: 'api' | 'cli' = 'cli';
      if (cfg.preferClineApi) {
        const viaApi = await this.tryRunViaClineApi(cfg, task, prompt);
        if (viaApi) {
          via = 'api';
          ({ result, output, exitCode } = viaApi);
          errorKind = result === 'success' ? 'failed' : classifyError(output);
          if (result === 'timeout') {
            // The API task may still be working in the sidebar — never
            // auto-retry those, or the prompt would run twice.
            errorKind = 'timeout';
          }
        } else {
          this.out.appendLine('[backseat] Cline API path unavailable — falling back to Cline CLI.');
          ({ result, output, exitCode } = await this.runViaCli(cfg, task, prompt));
          errorKind = this.classifyCliResult(result, output);
        }
      } else {
        ({ result, output, exitCode } = await this.runViaCli(cfg, task, prompt));
        errorKind = this.classifyCliResult(result, output);
      }

      const decision = shouldRetryTask(result, errorKind, via, attempt, maxRetries);
      if (!decision.retry) {
        break;
      }
      const delayMin = decision.delayMin;
      this.out.appendLine(
        `[backseat] task ${task.id} hit ${errorKind}; retrying in ${delayMin}m (attempt ${attempt + 1}/${maxRetries + 1})`,
      );
      await this.writeStatus(
        cfg,
        task.id,
        'running',
        tailLines(output),
        `retrying in ${delayMin}m (attempt ${attempt + 1})`,
      );
      await pushChanges(cfg.repoPath, `task ${task.id}: retrying`, this.out);
      if (!(await this.sleepInterruptible(delayMin * 60_000))) {
        output += '\n[stopped during retry backoff]';
        result = 'failed';
        errorKind = 'failed';
        break;
      }
    }
    task.error_kind = result === 'success' ? undefined : errorKind;

    this.out.appendLine(
      `[backseat] task ${task.id} finished: ${result} (exit ${exitCode}, ${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    await this.finishTask(cfg, task, result, output, exitCode);
  }

  // -- VS Code command tasks ----------------------------------------------
  // kind: "command" tasks drive VS Code itself — open, create, close, or
  // delete projects — instead of running Cline. This is how the user manages
  // projects entirely from their phone.

  private async executeCommandTask(cfg: BridgeConfig, task: BridgeTask): Promise<void> {
    this.setStatus('working', task.title || task.id);
    this.out.appendLine(`[backseat] command task ${task.id}: ${task.command ?? '(no command)'}`);
    this.tree?.refresh();

    if (!(await this.publishClaim(cfg, task))) {
      return;
    }

    task.started_at = utcnow();
    await this.writeStatus(cfg, task.id, 'queued', '', 'starting');
    await pushChanges(cfg.repoPath, `task ${task.id}: queued`, this.out);
    await this.writeStatus(cfg, task.id, 'running', '', String(task.command));
    await pushChanges(cfg.repoPath, `task ${task.id}: running`, this.out);

    let result: TaskState = 'failed';
    let output = '';
    try {
      output = await this.runCommand(cfg, task);
      result = 'success';
    } catch (e: any) {
      output = e?.message ?? String(e);
      this.out.appendLine(`[backseat] command task ${task.id} failed: ${output}`);
    }
    await this.finishTask(cfg, task, result, output, result === 'success' ? 0 : 1);

    // Close the window only after the done state is published.
    if (task.command === 'closeWindow' && result === 'success') {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
    }
  }

  private async runCommand(cfg: BridgeConfig, task: BridgeTask): Promise<string> {
    const cmd = task.command;
    if (!cmd) {
      throw new Error('command task is missing "command"');
    }
    switch (cmd) {
      case 'openProject': {
        const { targetPath, name } = this.resolveProjectTarget(cfg, task);
        if (!fs.existsSync(targetPath)) {
          throw new Error(`project does not exist: ${targetPath}`);
        }
        await this.switchProjectRoot(targetPath, name);
        await this.learnProject(cfg, name, targetPath);
        return `opened project: ${targetPath}`;
      }
      case 'newProject': {
        const { targetPath, name } = this.resolveProjectTarget(cfg, task);
        if (fs.existsSync(targetPath)) {
          throw new Error(`path already exists: ${targetPath}`);
        }
        fs.mkdirSync(targetPath, { recursive: true });
        // Best-effort git init so the project starts versioned.
        try {
          await git(targetPath, ['init']);
        } catch {
          /* non-fatal */
        }
        fs.writeFileSync(path.join(targetPath, 'README.md'), `# ${name}\n`);
        await this.switchProjectRoot(targetPath, name);
        await this.learnProject(cfg, name, targetPath);
        return `created and opened project: ${targetPath}`;
      }
      case 'closeWindow': {
        return 'closing VS Code window';
      }
      case 'deleteProject': {
        if (task.confirm !== 'delete') {
          throw new Error('deleteProject requires "confirm": "delete" in the task');
        }
        const { targetPath, name } = this.resolveProjectTarget(cfg, task);
        const resolved = path.resolve(targetPath);
        if (!fs.existsSync(resolved)) {
          throw new Error(`project does not exist: ${resolved}`);
        }
        const refusal = deleteProtectionReason(resolved, os.homedir(), cfg.repoPath);
        if (refusal) {
          throw new Error(refusal);
        }
        this.out.appendLine(`[backseat] DELETING project directory: ${resolved}`);
        fs.rmSync(resolved, { recursive: true, force: true });
        // Drop it from the workspace and the project map if present.
        const folders = vscode.workspace.workspaceFolders ?? [];
        const idx = folders.findIndex((f) => path.resolve(f.uri.fsPath) === resolved);
        if (idx >= 0) {
          vscode.workspace.updateWorkspaceFolders(idx, 1);
        }
        await this.forgetProject(cfg, name, resolved);
        return `deleted project: ${resolved}`;
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  }

  /**
   * Resolve a command task's target. Tasks may name a project
   * (args.project, looked up in the bridge repo's projects.json) instead of
   * a raw path, so a typo can't nuke the wrong folder.
   */
  private resolveProjectTarget(
    cfg: BridgeConfig,
    task: BridgeTask,
  ): { targetPath: string; name: string } {
    return resolveProjectTargetPure(task.args, this.readProjectMap(cfg));
  }

  private readProjectMap(cfg: BridgeConfig): Record<string, string> {
    try {
      const m = readJson(path.join(cfg.repoPath, 'projects.json')) as Record<string, string>;
      return m && typeof m === 'object' ? m : {};
    } catch {
      return {};
    }
  }

  /** Remember a project name → path mapping so future tasks can use the name. */
  private async learnProject(cfg: BridgeConfig, name: string, targetPath: string): Promise<void> {
    const file = path.join(cfg.repoPath, 'projects.json');
    const map = this.readProjectMap(cfg);
    if (!mergeLearnedProject(map, name, targetPath).changed) {
      return;
    }
    writeJsonAtomic(file, map);
    await pushChanges(cfg.repoPath, `projects.json: learned "${name}"`, this.out);
  }

  private async forgetProject(cfg: BridgeConfig, name: string, targetPath: string): Promise<void> {
    const file = path.join(cfg.repoPath, 'projects.json');
    const map = this.readProjectMap(cfg);
    if (!mergeForgottenProject(map, name, targetPath).changed) {
      return;
    }
    writeJsonAtomic(file, map);
    await pushChanges(cfg.repoPath, `projects.json: forgot "${name}"`, this.out);
  }

  /**
   * Show a project folder WITHOUT dropping the bridge repo from the window.
   * vscode.openFolder would reload the window onto the project alone and
   * kill remote control; instead we add the project as an extra workspace
   * root (multi-root) and remove project roots we added previously.
   */
  private async switchProjectRoot(targetPath: string, label: string): Promise<void> {
    const cfg = this.config;
    const bridgePath = cfg ? path.resolve(cfg.repoPath) : undefined;
    const target = path.resolve(targetPath);
    const prevTargets = (this.ctx.globalState.get<string[]>('backseat.projectRoots') ?? []).map((p) =>
      path.resolve(p),
    );
    const folders = vscode.workspace.workspaceFolders ?? [];
    const kept: { uri: vscode.Uri; name: string }[] = [];
    for (const f of folders) {
      const p = path.resolve(f.uri.fsPath);
      if (p === target) {
        kept.push({ uri: f.uri, name: f.name });
        continue;
      }
      if (bridgePath && p === bridgePath) {
        kept.push({ uri: f.uri, name: f.name }); // never drop the bridge
        continue;
      }
      if (prevTargets.includes(p)) {
        continue; // drop project roots we added on earlier switches
      }
      kept.push({ uri: f.uri, name: f.name }); // keep the user's other folders
    }
    if (!kept.some((r) => path.resolve(r.uri.fsPath) === target)) {
      kept.push({ uri: vscode.Uri.file(target), name: label });
    }
    const ok = vscode.workspace.updateWorkspaceFolders(0, folders.length, ...kept);
    if (ok === false) {
      this.out.appendLine('[backseat] multi-root switch failed; falling back to openFolder');
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
      return;
    }
    await this.ctx.globalState.update('backseat.projectRoots', [target]);
    this.out.appendLine(`[backseat] workspace now: ${kept.map((r) => r.name).join(', ')}`);
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
    prompt: string,
  ): Promise<{ result: TaskState; output: string; exitCode: number } | null> {
    const ext = vscode.extensions.getExtension(CLINE_EXTENSION_ID);
    if (!ext) {
      this.out.appendLine('[backseat] Cline extension not installed/active.');
      return null;
    }
    let api: ClineApi;
    try {
      api = (await ext.activate()) as ClineApi;
    } catch (e: any) {
      this.out.appendLine(`[backseat] could not activate Cline extension: ${e?.message}`);
      return null;
    }
    if (typeof api?.startNewTask !== 'function') {
      this.out.appendLine(
        `[backseat] Cline API has no startNewTask (exports: ${Object.keys(api ?? {}).join(', ') || 'none'}).`,
      );
      return null;
    }
    if (typeof api.getTaskHistory !== 'function') {
      // Without a completion signal we cannot reliably finish the bridge
      // task, so stay on the tested CLI path instead of half-driving Cline.
      this.out.appendLine('[backseat] Cline API has no task-history/completion signal; using CLI.');
      return null;
    }

    // Snapshot history so we can recognise the task we are about to start.
    let beforeIds = new Set<string>();
    try {
      const hist = await api.getTaskHistory();
      beforeIds = new Set(hist.map((h) => idOf(h)).filter(Boolean) as string[]);
    } catch (e: any) {
      this.out.appendLine(`[backseat] getTaskHistory failed: ${e?.message}; using CLI.`);
      return null;
    }

    this.out.appendLine(`[backseat] starting Cline task via extension API: ${task.id}`);
    await this.writeStatus(cfg, task.id, 'running', '', 'cline (extension) working');
    await pushChanges(cfg.repoPath, `task ${task.id}: running`, this.out);

    try {
      await api.startNewTask(prompt);
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
        await this.pushThrottled(cfg.repoPath, `task ${task.id}: heartbeat`);
      }
      try {
        const hist = await api.getTaskHistory();        const fresh = hist.filter((h) => {
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
        this.out.appendLine(`[backseat] history poll error: ${e?.message}`);
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
    prompt: string,
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

    this.out.appendLine(`[backseat] launching: ${cfg.clineCommand} --yolo (cwd=${projectDir})`);

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
        // Spawn target is a pure function (logic.ts) so the Windows
        // cmd.exe/argv quoting is unit-testable — see clineSpawnTarget.
        const target = clineSpawnTarget(cfg.clineCommand, prompt);
        child = cp.spawn(target.file, target.args, {
          cwd: projectDir,
          shell: target.shell,
          windowsHide: true,
          // stdin closed: if the CLI ever prompts interactively (first-run
          // trust, login), it gets EOF and fails fast instead of hanging
          // silently until the task timeout.
          stdio: ['ignore', 'pipe', 'pipe'],
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
          output: `cline not found (tried '${cfg.clineCommand}'). Set backseat.clineCommand to the full path.\n${err.message}`,
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
          await this.pushThrottled(cfg.repoPath, `task ${task.id}: heartbeat`);
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
      this.out.appendLine(`[backseat] could not move task file for ${task.id}: ${e?.message}`);
    }

    await this.writeStatus(cfg, task.id, result, tailLines(output), `finished: ${result} (exit ${exitCode})`);
    await pushChanges(cfg.repoPath, `task ${task.id}: ${result}`, this.out);
    await this.notifyNtfy(cfg, task, result);
  }

  /**
   * Instant "task finished" ping via ntfy.sh (optional, off by default).
   * Git stays the source of truth — this is just the doorbell so Muse
   * doesn't have to poll blind. Never throws: a failed ping must not
   * break task finishing.
   */
  private async notifyNtfy(cfg: BridgeConfig, task: BridgeTask, result: TaskState): Promise<void> {
    const topic = cfg.notifyTopic?.trim();
    if (!topic) {
      return;
    }
    const label = task.title || task.id;
    const emoji = result === 'success' ? '✅' : result === 'cancelled' ? '🚫' : '❌';
    const body = `${emoji} Backseat: "${label}" finished: ${result}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'ntfy.sh',
            path: `/${encodeURIComponent(topic)}`,
            method: 'POST',
            headers: {
              Title: 'Backseat task finished',
              Tags: result === 'success' ? 'white_check_mark' : 'x',
              'Content-Type': 'text/plain',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 15_000,
          },
          (res) => {
            res.resume(); // drain
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`ntfy HTTP ${res.statusCode}`));
            }
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('ntfy timeout')));
        req.end(body);
      });
      this.out.appendLine(`[backseat] ntfy ping sent for ${task.id}`);
    } catch (e: any) {
      this.out.appendLine(`[backseat] ntfy ping failed (non-fatal): ${e?.message ?? e}`);
    }
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
      `Backseat: ${this.isRunning ? 'polling' : 'stopped'}`,
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
    this.out.appendLine('[backseat] ' + lines.join(' | '));
    vscode.window.showInformationMessage(lines.join('\n'));
  }

  // ------------------------------------------------------------------
  // Sidebar dashboard backend (see sidebar.ts)
  // ------------------------------------------------------------------

  /** Snapshot of everything the dashboard renders. */
  getDashboardState(): DashboardState {
    const cfg = this.config;
    const c = vscode.workspace.getConfiguration('backseat');
    return {
      version: this.ctx.extension.packageJSON.version ?? '?',
      running: this.isRunning,
      status: this.statusKind,
      statusDetail: this.statusDetail,
      repoPath: cfg?.repoPath ?? '',
      bridgeRepo: String(c.get('bridgeRepo') ?? ''),
      notifyTopic: String(c.get('notifyTopic') ?? ''),
      pollIntervalSec: cfg?.pollIntervalSec ?? 30,
      currentTask: this.taskRunning ? this.currentTaskLabel || 'yes' : '',
      tasks: this.getTasks(),
    };
  }

  /** Task rows for the dashboard, newest-ish first per queue. */
  getTasks(): DashboardTask[] {
    const cfg = this.config;
    if (!cfg?.repoPath) {
      return [];
    }
    const out: DashboardTask[] = [];
    for (const kind of ['pending', 'active', 'done'] as const) {
      let files: string[] = [];
      try {
        files = fs
          .readdirSync(path.join(cfg.repoPath, 'tasks', kind))
          .filter((f) => f.endsWith('.json'))
          .sort()
          .reverse();
      } catch {
        continue;
      }
      for (const f of files.slice(0, 20)) {
        let title = f.replace(/\.json$/, '');
        let id = title;
        try {
          const t = readJson(path.join(cfg.repoPath, 'tasks', kind, f)) as BridgeTask;
          id = t.id || id;
          title = t.title || t.id || title;
        } catch {
          /* keep filename */
        }
        out.push({ kind, id, title });
      }
    }
    return out;
  }

  /** Save setup from the dashboard and (re)connect. */
  async saveSettings(bridgeRepo: string, notifyTopic: string): Promise<void> {
    const c = vscode.workspace.getConfiguration('backseat');
    await c.update('bridgeRepo', bridgeRepo.trim(), vscode.ConfigurationTarget.Global);
    await c.update('notifyTopic', notifyTopic.trim(), vscode.ConfigurationTarget.Global);
    await this.start();
  }

  async startPolling(): Promise<void> {
    await this.start();
  }

  stopPolling(): void {
    this.stop();
  }

  /**
   * Run every setup check and return the report lines. No UI side effects —
   * safe to call from the sidebar dashboard.
   */
  async collectDoctorReport(): Promise<string[]> {
    const ver = this.ctx.extension.packageJSON.version ?? '?';
    const lines: string[] = [`Backseat doctor v${ver}`];
    const mark = (good: boolean, label: string, detail = '') =>
      lines.push(`${good ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);

    const cfg = this.config;
    mark(!!cfg, 'bridge repo detected', cfg?.repoPath ?? 'set backseat.bridgeRepo to your private bridge repo (owner/repo)');
    const repoOk = !!cfg && fs.existsSync(path.join(cfg.repoPath, '.git'));
    if (cfg?.cloneUrl) {
      mark(
        repoOk,
        'bridge repo cloned',
        repoOk ? '' : 'not cloned yet — run Backseat: Start polling (or reload the window) and complete the GitHub sign-in',
      );
    }
    if (cfg && repoOk) {
      for (const d of ['tasks/pending', 'tasks/active', 'tasks/done', 'tasks/status']) {
        try {
          fs.mkdirSync(path.join(cfg.repoPath, d), { recursive: true });
        } catch {
          /* reported below */
        }
      }
      const dirsOk = ['tasks/pending', 'tasks/active', 'tasks/done', 'tasks/status'].every((d) =>
        fs.existsSync(path.join(cfg.repoPath, d)),
      );
      mark(dirsOk, 'task directories present');

      const gitv = await git(cfg.repoPath, ['--version']);
      mark(gitv.code === 0, 'git available', gitv.out.trim().split('\n')[0] || 'not found');

      // Fail fast on auth prompts — never hang the doctor on a credential popup.
      const lsRemote = await new Promise<{ code: number; out: string }>((resolve) => {
        cp.execFile(
          'git',
          ['ls-remote', 'origin', 'HEAD'],
          {
            cwd: cfg.repoPath,
            timeout: 20_000,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          },
          (err: any, stdout: string, stderr: string) =>
            resolve({ code: err ? 1 : 0, out: String(stdout ?? '') + String(stderr ?? '') }),
        );
      });
      mark(
        lsRemote.code === 0,
        'git read access works (ls-remote)',
        lsRemote.code === 0 ? 'reached origin' : lsRemote.out.slice(-200).trim() || 'failed',
      );

      // ls-remote only proves READ. The whole bridge is push-based (claims,
      // statuses, results), so also prove WRITE without pushing anything:
      // `git push --dry-run` exercises push auth and dies on permission
      // errors, but never sends objects. Fetch first: a clone that is behind
      // origin would be rejected as non-fast-forward — that's a sync issue,
      // not an auth failure, so report it accurately instead of crying
      // "permission denied".
      const fetch = await new Promise<{ code: number }>((resolve) => {
        cp.execFile(
          'git',
          ['fetch', 'origin'],
          {
            cwd: cfg.repoPath,
            timeout: 20_000,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          },
          (err: any) => resolve({ code: err ? 1 : 0 }),
        );
      });
      let behindNote = '';
      if (fetch.code === 0) {
        // rev-list is local-only: no network, no credential prompt.
        const behind = await git(cfg.repoPath, ['rev-list', '--count', 'HEAD..@{u}']);
        const n = parseInt(behind.out.trim(), 10);
        if (behind.code === 0 && n > 0) {
          behindNote =
            `clone is ${n} commit(s) behind origin — hit Check now to sync, ` +
            `then re-run the doctor`;
        }
      }
      if (behindNote) {
        mark(false, 'git push permission works (dry-run, pushes nothing)', behindNote);
      } else {
        const pushDry = await new Promise<{ code: number; out: string }>((resolve) => {
          cp.execFile(
            'git',
            ['push', '--dry-run', 'origin', 'HEAD'],
            {
              cwd: cfg.repoPath,
              timeout: 20_000,
              windowsHide: true,
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            },
            (err: any, stdout: string, stderr: string) =>
              resolve({ code: err ? 1 : 0, out: String(stdout ?? '') + String(stderr ?? '') }),
          );
        });
        mark(
          pushDry.code === 0,
          'git push permission works (dry-run, pushes nothing)',
          pushDry.code === 0 ? 'push auth OK' : pushDry.out.slice(-200).trim() || 'failed',
        );
      }

      const clineCmd = cfg.clineCommand || 'cline';
      const clinev = await new Promise<{ code: number; out: string }>((resolve) => {
        cp.execFile(
          clineCmd,
          ['--version'],
          { timeout: 20_000, windowsHide: true, shell: process.platform === 'win32' },
          (err: any, stdout: string, stderr: string) =>
            resolve({ code: err ? 1 : 0, out: String(stdout ?? stderr ?? '').trim().split('\n')[0] }),
        );
      });
      mark(clinev.code === 0, `cline CLI ("${clineCmd}") found`, clinev.out || `not on PATH — set backseat.clineCommand`);
    }

    const ext = vscode.extensions.getExtension(CLINE_EXTENSION_ID);
    mark(!!ext, 'Cline VS Code extension installed', ext ? ext.packageJSON?.version ?? '' : 'install Cline from the marketplace');
    if (ext) {
      try {
        const api = (await ext.activate()) as ClineApi;
        mark(typeof api?.startNewTask === 'function', 'Cline API: startNewTask');
        mark(
          typeof api?.getTaskHistory === 'function',
          'Cline API: completion signal',
          typeof api?.getTaskHistory === 'function'
            ? ''
            : 'missing — Backseat will use the CLI fallback (fine)',
        );
      } catch (e: any) {
        mark(false, 'Cline extension activates', e?.message ?? String(e));
      }
    }

    return lines;
  }

  /**
   * The `backseat.doctor` command: collect the report, then show it in the
   * Output panel with a summary notification. The sidebar dashboard calls
   * collectDoctorReport() directly so results render inside the tab.
   */
  async doctor(): Promise<string[]> {
    const lines = await this.collectDoctorReport();
    this.out.show();
    this.out.appendLine('[backseat] ' + lines.join('\n[backseat] '));
    const fails = lines.filter((l) => l.startsWith('FAIL')).length;
    await vscode.window.showInformationMessage(
      fails === 0
        ? 'Backseat doctor: all checks passed.'
        : `Backseat doctor: ${fails} check(s) failed — details in Output > Backseat.`,
    );
    return lines;
  }
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
  const out = vscode.window.createOutputChannel('Backseat');
  context.subscriptions.push(out);

  const runner = new BridgeRunner(out, context);
  const tree = new TaskTreeProvider(runner);
  runner.tree = tree;
  context.subscriptions.push(vscode.window.registerTreeDataProvider('backseat.tasks', tree));

  // Sidebar dashboard tab.
  const sidebar = new SidebarProvider(context, runner);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  runner.onDidChangeState(() => sidebar.refresh());

  context.subscriptions.push(
    vscode.commands.registerCommand('backseat.start', () => {
      void runner.start();
      out.show();
    }),
    vscode.commands.registerCommand('backseat.stop', () => runner.stop()),
    vscode.commands.registerCommand('backseat.runOnce', () => void runner.pollOnce()),
    vscode.commands.registerCommand('backseat.showStatus', () => runner.showStatus()),
    vscode.commands.registerCommand('backseat.doctor', () => void runner.doctor()),
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
    void runner.start();
  } else if (!runner.config) {
    out.appendLine('[backseat] set "backseat.bridgeRepo" to your private bridge repo (owner/repo) to enable polling.');
  }

  out.appendLine('[backseat] extension activated');
}

export function deactivate(): void {
  // Interval timers are disposed with the extension host; nothing to persist.
}
