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
  deleteProtectionReason,
  mergeForgottenProject,
  mergeLearnedProject,
  readPublishedNotifyTopic,
  resolveProjectTarget as resolveProjectTargetPure,
  shouldRetryTask,
  tailLines,
  utcnow,
  transcriptText,
  transcriptInfo,
  TRANSCRIPT_ERROR_RE,
  transcriptErrorAction,
  isAwaitingUserAsk,
  isRemoteCancelled,
  findSessionIdByMarker,
  isClaimedByDeadRunner,
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
  resume_session?: string; // written by orphan recovery: adopt this Cline session instead of starting fresh
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
 * Cline's extension API surface, verified against cline 4.x
 * (apps/vscode/src/exports/cline.d.ts). Four fire-and-forget methods —
 * notably there is NO task-history getter and NO completion signal, so
 * Backseat cannot reliably finish a bridge task through this API and
 * stays on the CLI path (which shares the extension's provider settings
 * via ~/.cline/data/settings/providers.json anyway).
 */
interface ClineApi {
  startNewTask?: (task?: string, images?: string[]) => Promise<void>;
  sendMessage?: (message?: string, images?: string[]) => Promise<void>;
  pressPrimaryButton?: () => Promise<void>;
  pressSecondaryButton?: () => Promise<void>;
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
    // Re-queue tasks stranded by a dead runner (upgrade/reload/crash).
    await this.recoverOrphanedTasks(cfg);
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
        const resumeSessionId =
          typeof task.resume_session === 'string' ? task.resume_session : undefined;
        delete task.resume_session; // resume once — retries start fresh
        const viaApi = resumeSessionId
          ? await this.tryResumeViaClineApi(cfg, task, resumeSessionId)
          : await this.tryRunViaClineApi(cfg, task, prompt);
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
   * Drive the Cline sidebar through its programmatic API (the primary path:
   * the task runs visibly in the user's chat, at chat speed, with the
   * user's own settings). Completion is a file handshake — the prompt
   * instructs Cline to write `.backseat-done-<taskid>` when fully done.
   * Returns null when the API surface is not usable (caller falls back to CLI).
   *
   * IMPORTANT: once startNewTask() has been invoked we must NOT fall back —
   * the task is already running inside Cline, and launching the CLI too
   * would run the prompt twice. From that point on we stay on the API path.
   */
  /**
   * Cline's shared session store (~/.cline/data/sessions/): a plain-JSON
   * index plus per-session live transcripts, maintained by Cline itself and
   * read by the extension, the CLI, and the hub. Backseat reads it to watch
   * the sidebar task it started: status (running/completed/failed), live
   * transcript, and liveness. This is Cline's designed persistence — not
   * scraping — but it is best-effort: if the layout ever changes, the
   * done-file handshake still completes tasks.
   */
  private clineSessionsDir(): string {
    const explicit =
      process.env.CLINE_SESSION_DATA_DIR?.trim() ||
      (process.env.CLINE_DATA_DIR?.trim()
        ? path.join(process.env.CLINE_DATA_DIR.trim(), 'sessions')
        : '');
    if (explicit) return explicit;
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    return path.join(home, '.cline', 'data', 'sessions');
  }

  private readSessionsIndex(): Record<string, any> {
    try {
      const raw = fs.readFileSync(path.join(this.clineSessionsDir(), 'sessions.index.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
        return parsed.sessions as Record<string, any>;
      }
    } catch {
      /* index missing or unreadable — session tracking unavailable */
    }
    return {};
  }

  /**
   * Newest session belonging to a task. Two strategies:
   * 1. sessions.index.json prompt marker (CLI-created sessions pass the
   *    prompt at creation, so the row has it).
   * 2. Scan of session message files (extension-API tasks create the
   *    session with prompt:undefined, so the index row's prompt is null —
   *    the marker only survives in the first user message).
   */
  private findBackseatSession(taskId: string): { sessionId: string; row: any } | null {
    const marker = `[backseat:task:${taskId}]`;
    const sessions = this.readSessionsIndex();
    let best: { sessionId: string; row: any } | null = null;
    let bestStart = '';
    for (const [sessionId, row] of Object.entries(sessions)) {
      const prompt = typeof row?.prompt === 'string' ? row.prompt : '';
      if (!prompt.includes(marker)) continue;
      const startedAt = typeof row?.startedAt === 'string' ? row.startedAt : '';
      if (!best || startedAt >= bestStart) {
        best = { sessionId, row };
        bestStart = startedAt;
      }
    }
    if (best) return best;
    const scanned = findSessionIdByMarker(this.clineSessionsDir(), marker);
    if (scanned) {
      this.out.appendLine(
        `[backseat] found session ${scanned.sessionId} for ${taskId} via message-file scan (index row has no prompt).`,
      );
      return { sessionId: scanned.sessionId, row: { messagesPath: scanned.messagesPath } };
    }
    return null;
  }

  /** Read one session row straight from the index (works for any session). */
  private readSessionRow(sessionId: string): any | null {
    const sessions = this.readSessionsIndex();
    const row = (sessions as Record<string, any>)[sessionId];
    return row && typeof row === 'object' ? row : null;
  }

  /**
   * Find the Cline session a stranded task was running in, so recovery can
   * RESUME it (keeping Cline's context) instead of restarting from scratch.
   * First tries the [backseat:task:<id>] prompt marker; falls back (for
   * tasks that predate the marker) to the newest session whose prompt starts
   * with this task's prompt AND whose workspace matches the project dir —
   * the prompt-head check keeps us from ever adopting the user's own
   * manual chat.
   */
  private findResumeSession(
    task: BridgeTask,
    cfg: BridgeConfig,
  ): { sessionId: string; row: any } | null {
    const marked = this.findBackseatSession(task.id);
    if (marked) return marked;
    const projectDir =
      task.project_dir ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      cfg.repoPath;
    const promptHead = (task.prompt || '').slice(0, 80).trim();
    if (!promptHead) return null;
    const norm = (v: unknown) =>
      typeof v === 'string' ? v.replace(/\//g, '\\').toLowerCase() : '';
    const want = norm(projectDir);
    const sessions = this.readSessionsIndex();
    let best: { sessionId: string; row: any } | null = null;
    let bestStart = '';
    for (const [sessionId, row] of Object.entries(sessions)) {
      const r = row as any;
      if (r?.isSubagent || r?.parentSessionId) continue;
      const prompt = typeof r?.prompt === 'string' ? r.prompt : '';
      if (!prompt.includes(promptHead)) continue;
      if (norm(r?.cwd) !== want && norm(r?.workspaceRoot) !== want) continue;
      const startedAt = typeof r?.startedAt === 'string' ? r.startedAt : '';
      if (!best || startedAt >= bestStart) {
        best = { sessionId, row: r };
        bestStart = startedAt;
      }
    }
    return best;
  }


  /**
   * Pull readable text out of Cline's persisted session messages.
   * Implemented in logic.ts (pure, unit-tested) — this is a thin wrapper.
   */
  private transcriptText(messagesPath: string, maxChars: number): string {
    return transcriptText(messagesPath, maxChars);
  }

  private messagesMtimeMs(messagesPath: string | undefined): number {
    if (!messagesPath) return 0;
    try {
      return fs.statSync(messagesPath).mtimeMs;
    } catch {
      return 0;
    }
  }

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
    // Drive the Cline sidebar directly: the task runs visibly in the
    // user's chat, at chat speed, with the user's own settings. The
    // verified Cline 4.x API has no completion signal, so completion is a
    // handshake: the prompt instructs Cline to write a sentinel file when
    // fully done, and we poll the workspace for it.
    const projectDir =
      task.project_dir ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      cfg.repoPath;
    if (!fs.existsSync(projectDir)) {
      this.out.appendLine(`[backseat] Cline API path: project_dir does not exist: ${projectDir}`);
      return null;
    }
    const sentinelName = `.backseat-done-${task.id}`;
    const sentinelPath = path.join(projectDir, sentinelName);
    try {
      fs.unlinkSync(sentinelPath);
    } catch {
      /* no stale sentinel */
    }

    const taskMarker = `[backseat:task:${task.id}]`;
    const fullPrompt =
      `${taskMarker}\n${prompt}\n\n---\n` +
      `When you have FULLY completed everything above, write a file named ${sentinelName} ` +
      `in the current workspace root (${projectDir}). The first line of the file must be exactly ` +
      `DONE if you succeeded or FAILED if you could not complete the work. After that line, write a ` +
      `short summary of what you did or changed (file paths and key decisions). ` +
      `Do not write this file until you are completely finished. Do not stop early.`;

    this.out.appendLine(`[backseat] starting Cline sidebar task: ${task.id}`);
    await this.writeStatus(cfg, task.id, 'running', '', 'cline (sidebar) working');
    await pushChanges(cfg.repoPath, `task ${task.id}: running`, this.out);

    try {
      await api.startNewTask(fullPrompt);
    } catch (e: any) {
      return { result: 'failed', output: `startNewTask threw: ${e?.message ?? e}`, exitCode: 1 };
    }
    this.out.appendLine(`[backseat] starting Cline sidebar task: ${task.id} (fresh)`);
    return this.watchSidebarTask(cfg, task, api, {
      sessionId: null,
      messagesPath: undefined,
      sentinelPath,
    });
  }

  /**
   * Adopt an existing Cline sidebar session instead of starting a new one:
   * Cline keeps its full context and just keeps going. The watch loop is
   * shared with the fresh-start path — done-file first, then terminal
   * session status, then transcript-error retry (presses Resume), then
   * stall retry.
   */
  private async tryResumeViaClineApi(
    cfg: BridgeConfig,
    task: BridgeTask,
    sessionId: string,
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
    const projectDir =
      task.project_dir ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      cfg.repoPath;
    if (!fs.existsSync(projectDir)) {
      this.out.appendLine(`[backseat] resume: project_dir does not exist: ${projectDir}`);
      return null;
    }
    const sentinelName = `.backseat-done-${task.id}`;
    const sentinelPath = path.join(projectDir, sentinelName);
    // Fast path: Cline may have finished while the runner was dead.
    try {
      if (fs.existsSync(sentinelPath)) {
        const doneContent = fs.readFileSync(sentinelPath, 'utf8');
        try {
          fs.unlinkSync(sentinelPath);
        } catch {
          /* already gone */
        }
        const firstLine = doneContent.split('\n')[0].trim().toUpperCase();
        const ok = firstLine === 'DONE';
        this.out.appendLine(
          `[backseat] resumed task ${task.id}: done-file already present (${firstLine || '(empty)'})`,
        );
        return { result: ok ? 'success' : 'failed', output: doneContent.slice(0, 8000), exitCode: ok ? 0 : 1 };
      }
    } catch {
      /* ignore */
    }
    const row = this.readSessionRow(sessionId);
    let messagesPath = typeof row?.messagesPath === 'string' ? row.messagesPath : undefined;
    if (!messagesPath) {
      // Extension-API sessions may have no index row (or a row without
      // messagesPath) — the artifacts path is conventional.
      const conventional = path.join(this.clineSessionsDir(), sessionId, `${sessionId}.messages.json`);
      if (fs.existsSync(conventional)) {
        messagesPath = conventional;
      }
    }
    this.out.appendLine(`[backseat] resuming Cline session ${sessionId} for ${task.id} (context kept)`);
    await this.writeStatus(cfg, task.id, 'running', '', 'cline (sidebar) resumed');
    await pushChanges(cfg.repoPath, `task ${task.id}: resumed`, this.out);
    return this.watchSidebarTask(cfg, task, api, { sessionId, messagesPath, sentinelPath });
  }


  /**
   * Does tasks/active/<id>.json still exist on the remote? Used for
   * remote-cancel: the Muse side cancels by moving the active file to
   * tasks/done/ on origin. Returns null when it cannot be determined
   * (fetch failure) — the caller must fail open and keep running.
   * Fetch never touches the working tree, so this is safe mid-run.
   */
   private async remoteActiveTaskExists(
    repoPath: string,
    taskId: string,
  ): Promise<boolean | null> {
    try {
      const fetch = await git(repoPath, ['fetch', '--quiet', 'origin']);
      if (fetch.code !== 0) {
        return null;
      }
      const up = await git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      if (up.code !== 0) {
        return null;
      }
      const check = await git(repoPath, [
        'cat-file',
        '-e',
        `${up.out.trim()}:tasks/active/${taskId}.json`,
      ]);
      return check.code === 0;
    } catch {
      return null;
    }
  }

  /**
   * Watch a Cline sidebar session until it finishes: done-file handshake
   * first, then terminal session status, then transcript-error retry
   * (presses Cline's primary button = Resume/Retry), then stall retry.
   * Shared by fresh starts (sessionId null → discovers via marker) and
   * resumes (adopts the known session, keeping Cline's context).
   */
  private async watchSidebarTask(
    cfg: BridgeConfig,
    task: BridgeTask,
    api: ClineApi,
    init: { sessionId: string | null; messagesPath?: string; sentinelPath: string },
  ): Promise<{ result: TaskState; output: string; exitCode: number }> {
    let sessionId = init.sessionId;
    let messagesPath = init.messagesPath;
    const sentinelPath = init.sentinelPath;
    if (!sessionId) {
      const foundBy = Date.now() + 90_000;
      while (!sessionId && Date.now() < foundBy) {
        const found = this.findBackseatSession(task.id);
        if (found) {
          sessionId = found.sessionId;
          messagesPath = typeof found.row?.messagesPath === 'string' ? found.row.messagesPath : undefined;
          this.out.appendLine(`[backseat] tracking Cline session ${sessionId} for ${task.id}`);
        } else {
          await sleep(5_000);
        }
      }
      if (!sessionId) {
        this.out.appendLine('[backseat] Cline session not found in session store — done-file only.');
      }
    }

    const readDoneFile = (): string | null => {
      try {
        if (fs.existsSync(sentinelPath)) return fs.readFileSync(sentinelPath, 'utf8');
      } catch {
        /* ignore */
      }
      return null;
    };

    const timeoutMs = (task.timeout_sec ?? cfg.defaultTimeoutSec) * 1000;
    const started = Date.now();
    let lastHeartbeat = 0;
    // Liveness comes from the live transcript: new messages mean Cline is
    // progressing. When the transcript goes quiet:
    // - if the tail shows a provider error and Cline is NOT awaiting user
    //   input, press Cline's primary button (Resume/Retry) — up to 3 times
    //   per quiet spell, and never for credits/auth errors (those need a
    //   human: top-up or key fix).
    // - on a generic 3-minute stall with NO error showing, press once — but
    //   never when Cline is asking the user something (an approval or
    //   follow-up question must not be auto-answered).
    // The quiet delay (30s) lets Cline's error write-burst settle so the
    // press always lands on the real Retry button; the 5s poll keeps
    // detection tight. Meaningful notes are sticky — heartbeats must not
    // clobber them — and clear as soon as the transcript moves again.
    const STALL_MS = 3 * 60 * 1000;
    const ERROR_RETRY_MS = 30_000;
    const MAX_ERROR_RETRIES = 3;
    const ERROR_RE = TRANSCRIPT_ERROR_RE;
    let lastMsgMtime = messagesPath ? this.messagesMtimeMs(messagesPath) : Date.now();
    let lastMsgCount = 0;
    let retryAttempted = false;
    let errorRetryAttempted = false;
    let errorRetryBlocked = false;
    let consecutiveErrorRetries = 0;
    let stallAwaitingNoted = false;
    let stickyNote: string | null = sessionId ? `tracking Cline session ${sessionId.slice(-6)}` : null;
    const setNote = async (note: string | null): Promise<void> => {
      stickyNote = note;
      await this.writeStatus(cfg, task.id, 'running', '', note ?? 'cline (sidebar) working');
    };
    let iter = 0;
    for (;;) {
      await sleep(5_000);
      iter++;
      // Remote cancel (~every 30s): if the Muse side moved our active file
      // to tasks/done/ on origin, stop now so the next pending task can
      // run. Fail-open: an undeterminable state keeps the task running.
      if (iter % 6 === 0) {
        const stillActive = await this.remoteActiveTaskExists(cfg.repoPath, task.id);
        if (isRemoteCancelled(stillActive)) {
          this.out.appendLine(
            `[backseat] ${task.id} was cancelled remotely (active file gone from origin) — stopping.`,
          );
          return {
            result: 'cancelled',
            output: 'cancelled remotely via the bridge repo; the done record was written by the cancelling side',
            exitCode: 0,
          };
        }
      }
      if (Date.now() - lastHeartbeat > cfg.heartbeatSec * 1000) {
        lastHeartbeat = Date.now();
        await this.writeStatus(cfg, task.id, 'running', '', stickyNote ?? 'cline (sidebar) working');
        await this.pushThrottled(cfg.repoPath, `task ${task.id}: heartbeat`);
      }

      // 1. Done-file handshake (primary result carrier: Cline's summary).
      const doneContent = readDoneFile();
      if (doneContent !== null) {
        try {
          fs.unlinkSync(sentinelPath);
        } catch {
          /* already gone */
        }
        const firstLine = doneContent.split('\n')[0].trim().toUpperCase();
        const ok = firstLine === 'DONE';
        this.out.appendLine(`[backseat] Cline sidebar task ${task.id} finished via done-file: ${firstLine || '(empty)'}`);
        return { result: ok ? 'success' : 'failed', output: doneContent.slice(0, 8000), exitCode: ok ? 0 : 1 };
      }

      // 2. Session-store signals.
      let status: string | undefined;
      let transcriptTail = '';
      let transcriptLastKind = '';
      if (sessionId) {
        const row = this.readSessionRow(sessionId);
        if (row) {
          status = typeof row?.status === 'string' ? row.status : undefined;
          if (!messagesPath && typeof row?.messagesPath === 'string') {
            messagesPath = row.messagesPath;
          }
        }
        if (messagesPath) {
          const mtime = this.messagesMtimeMs(messagesPath);
          if (mtime > lastMsgMtime) {
            lastMsgMtime = mtime;
            lastMsgCount++;
            retryAttempted = false;
            errorRetryAttempted = false;
            errorRetryBlocked = false;
            consecutiveErrorRetries = 0;
            stallAwaitingNoted = false;
            stickyNote = null; // Cline is progressing — back to the generic note.
          }
          const info = transcriptInfo(messagesPath, 1500);
          transcriptTail = info.text;
          transcriptLastKind = info.lastKind;
        }
      }

      // 2a. Terminal session status completes the task even without a done-file.
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        const ok = status === 'completed';
        this.out.appendLine(`[backseat] Cline session ${sessionId} reached status '${status}'.`);
        const output = transcriptTail
          ? `Cline session ${status}. Last transcript:\n${transcriptTail}`
          : `Cline session ${status} (no transcript available).`;
        return { result: ok ? 'success' : 'failed', output: output.slice(0, 8000), exitCode: ok ? 0 : 1 };
      }

      // 2b. Provider error visible in the transcript + quiet spell -> press
      // Cline's primary button (Resume/Retry). Fires whenever the tail
      // shows an error and Cline is NOT awaiting user input for something
      // else — the error need not be the literal last message (Cline
      // sometimes writes follow-on lines after the ask).
      const quietMs = Date.now() - lastMsgMtime;
      if (
        sessionId &&
        !errorRetryAttempted &&
        !errorRetryBlocked &&
        quietMs > ERROR_RETRY_MS &&
        transcriptTail &&
        ERROR_RE.test(transcriptTail) &&
        !isAwaitingUserAsk(transcriptLastKind)
      ) {
        errorRetryAttempted = true;
        if (transcriptErrorAction(transcriptTail) === 'manual') {
          // Credits/quota/auth: retrying fails identically — surface it.
          errorRetryBlocked = true;
          this.out.appendLine(
            `[backseat] transcript shows a credits/auth error on ${task.id} — needs manual action, not auto-pressing.`,
          );
          await setNote('cline (sidebar) credits/auth issue — manual action needed');
        } else if (consecutiveErrorRetries >= MAX_ERROR_RETRIES) {
          errorRetryBlocked = true;
          this.out.appendLine(
            `[backseat] ${task.id}: provider still failing after ${MAX_ERROR_RETRIES} auto-retries — manual attention needed.`,
          );
          await setNote(
            `cline (sidebar) error persists after ${MAX_ERROR_RETRIES} auto-retries — manual attention needed`,
          );
        } else {
          consecutiveErrorRetries++;
          this.out.appendLine(
            `[backseat] transcript shows a provider error and Cline is quiet — pressing primary button (retry ${consecutiveErrorRetries}/${MAX_ERROR_RETRIES}).`,
          );
          await setNote(
            `cline (sidebar) error seen — retried (${consecutiveErrorRetries}/${MAX_ERROR_RETRIES})`,
          );
          try {
            await api.pressPrimaryButton?.();
          } catch (e: any) {
            this.out.appendLine(`[backseat] pressPrimaryButton failed: ${e?.message ?? e}`);
          }
        }
      } else if (
        sessionId &&
        !retryAttempted &&
        quietMs > STALL_MS &&
        !(transcriptTail && ERROR_RE.test(transcriptTail))
      ) {
        // 2c. Generic stall (no transcript movement at all, and no error
        // showing — the error path above owns error stalls) -> press once,
        // but never when Cline is asking the user something.
        if (isAwaitingUserAsk(transcriptLastKind)) {
          if (!stallAwaitingNoted) {
            stallAwaitingNoted = true;
            this.out.appendLine(
              `[backseat] ${task.id}: Cline is awaiting user input ('${transcriptLastKind}') — not pressing.`,
            );
            await setNote(`cline (sidebar) awaiting your input (${transcriptLastKind})`);
          }
        } else {
          retryAttempted = true;
          this.out.appendLine(
            `[backseat] no transcript activity for 3m on ${task.id} — pressing Cline's primary button (retry/approve).`,
          );
          await setNote('cline (sidebar) quiet — tried retry');
          try {
            await api.pressPrimaryButton?.();
          } catch (e: any) {
            this.out.appendLine(`[backseat] pressPrimaryButton failed: ${e?.message ?? e}`);
          }
        }
      }
      if (Date.now() - started >= timeoutMs) {
        return {
          result: 'timeout',
          output:
            'Timed out waiting for the Cline sidebar task (no done-file, no terminal session status). ' +
            'Cline may still be working — check the sidebar.',
          exitCode: 124,
        };
      }
    }
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
      // A remote cancel writes the done record itself (with the human's
      // note) before the runner notices — never overwrite it with the
      // runner's bare-bones version. If no record exists yet (race),
      // write ours as the backstop.
      const doneExists = fs.existsSync(donePath);
      if (!(result === 'cancelled' && doneExists)) {
        writeJsonAtomic(donePath, task);
      }
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

  /**
   * Orphan recovery: tasks left in tasks/active/ by a dead runner (extension
   * upgrade, window reload, crash) go back to pending so they run fresh.
   * A task is orphaned when it is claimed by a *different* runner id and
   * its heartbeat is older than 5 minutes — a live runner (e.g. another VS
   * Code window) keeps heartbeating, so we never steal those.
   */
  /**
   * Probe whether a pid is still alive (signal 0 — no actual signal sent).
   * ESRCH means the process is gone; EPERM means it exists but isn't ours
   * (conservative: treat as alive).
   */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code !== 'ESRCH';
    }
  }

  private async recoverOrphanedTasks(cfg: BridgeConfig): Promise<void> {
    const pull = await git(cfg.repoPath, ['pull', '--ff-only', '-q']);
    if (pull.code !== 0) {
      this.out.appendLine(`[backseat] orphan check: pull failed (${pull.out.slice(-200)}), skipping`);
      return;
    }
    const activeDir = path.join(cfg.repoPath, 'tasks', 'active');
    const pendingDir = path.join(cfg.repoPath, 'tasks', 'pending');
    let files: string[];
    try {
      files = fs.readdirSync(activeDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    const STALE_MS = 5 * 60 * 1000;
    let recovered = 0;
    for (const f of files) {
      const activePath = path.join(activeDir, f);
      let task: any;
      try {
        task = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      } catch {
        continue;
      }
      if (task?.claimed_by === this.runnerId) continue;
      // Our runner id embeds the extension-host pid
      // (`<hostname>-<pid>-<random>`). If that pid is gone, the claiming
      // runner is dead — reclaim immediately even if its last heartbeat
      // looks fresh (this is the upgrade/reload case). Otherwise fall back
      // to heartbeat staleness so we never steal from a live runner in
      // another window.
      const claimedBy = typeof task?.claimed_by === 'string' ? task.claimed_by : '';
      const runnerDead = isClaimedByDeadRunner(claimedBy, (pid) => this.isPidAlive(pid));
      // Heartbeat lives in the status file; fall back to the active file's mtime.
      let hbMs = 0;
      try {
        const st = JSON.parse(
          fs.readFileSync(path.join(cfg.repoPath, 'tasks', 'status', f), 'utf8'),
        );
        if (typeof st?.heartbeat_at === 'string') hbMs = Date.parse(st.heartbeat_at);
      } catch {
        /* no status file */
      }
      if (!hbMs) {
        try {
          hbMs = fs.statSync(activePath).mtimeMs;
        } catch {
          hbMs = 0;
        }
      }
      if (!runnerDead && hbMs && Date.now() - hbMs <= STALE_MS) continue; // live runner — hands off
      try {
        delete task.claimed_by;
        // Prefer RESUMING the stranded Cline session (keeps its context)
        // over restarting from scratch. Falls back to a fresh start when
        // no session can be matched.
        const resume = this.findResumeSession(task, cfg);
        if (resume) {
          task.resume_session = resume.sessionId;
          this.out.appendLine(
            `[backseat] recovered orphaned task ${task?.id ?? f} -> pending (will resume Cline session ${resume.sessionId})`,
          );
        } else {
          this.out.appendLine(`[backseat] recovered orphaned task ${task?.id ?? f} -> pending (fresh start)`);
        }
        writeJsonAtomic(path.join(pendingDir, f), task);
        fs.unlinkSync(activePath);
        recovered++;
      } catch (e: any) {
        this.out.appendLine(`[backseat] could not recover ${f}: ${e?.message ?? e}`);
      }
    }
    if (recovered > 0) {
      await pushChanges(cfg.repoPath, `recover ${recovered} orphaned task(s)`, this.out);
    }
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
      // The Cline CLI and the VS Code extension share one provider-settings
      // file (~/.cline/data/settings/providers.json), so task runs use the
      // user's own provider/model with no Backseat configuration. Surface
      // what that file declares so a mismatch is visible, not mysterious.
      try {
        const providersPath =
          process.env.CLINE_PROVIDER_SETTINGS_PATH?.trim() ||
          path.join(os.homedir(), '.cline', 'data', 'settings', 'providers.json');
        if (fs.existsSync(providersPath)) {
          const raw = JSON.parse(fs.readFileSync(providersPath, 'utf8')) as Record<string, unknown>;
          const keys = Object.keys(raw);
          // Never print secrets: report key names and non-secret values only.
          const safe: string[] = [];
          for (const k of keys.slice(0, 12)) {
            if (/key|secret|token/i.test(k)) {
              safe.push(`${k}=<redacted>`);
              continue;
            }
            const v = raw[k];
            safe.push(`${k}=${typeof v === 'object' ? '{…}' : String(v).slice(0, 60)}`);
          }
          mark(true, 'cline shared provider settings', `${providersPath} — ${safe.join(', ') || '(empty)'}`);
        } else {
          mark(true, 'cline shared provider settings', `no providers.json yet at ${providersPath} — run \`cline auth\` once to seed it`);
        }
      } catch (e: any) {
        mark(true, 'cline shared provider settings', `could not read providers.json: ${e?.message}`);
      }
    }

    const ext = vscode.extensions.getExtension(CLINE_EXTENSION_ID);
    mark(!!ext, 'Cline VS Code extension installed', ext ? ext.packageJSON?.version ?? '' : 'install Cline from the marketplace');
    if (ext) {
      try {
        const api = (await ext.activate()) as ClineApi;
        mark(typeof api?.startNewTask === 'function', 'Cline API: startNewTask');
        // The sidebar path is primary: tasks run visibly in the Cline chat
        // and Backseat tracks the session through Cline's shared session
        // store (~/.cline/data/sessions): live status, transcript, and
        // liveness, plus the done-file handshake for Cline's summary.
        // CLI remains as fallback.
        mark(true, 'Cline API: task path', 'sidebar chat via startNewTask + session-store tracking');
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
