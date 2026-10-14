/**
 * Backseat — pure logic, no VS Code dependency.
 *
 * Everything in this module is a pure function (or a near-pure one with
 * explicit inputs) extracted from extension.ts so it can be unit-tested
 * with plain Node. extension.ts imports from here and keeps only the
 * VS Code / child-process wiring.
 */

import * as fs from 'fs';
import * as path from 'path';

export type TaskState = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';

/**
 * How to spawn the Cline CLI for a task run.
 *
 * On Windows the CLI is an npm `.cmd` shim, which needs cmd.exe — but
 * `shell: true` makes Node join file+args with plain spaces, so a
 * multi-word prompt arrives as separate argv entries and the CLI rejects
 * it ("Unknown command or unquoted prompt"). Routing through
 * `cmd.exe /d /s /c` with `shell: false` lets libuv quote each argv
 * element correctly instead.
 *
 */
export function clineSpawnTarget(
  clineCommand: string,
  prompt: string,
  platform: string = process.platform,
): { file: string; args: string[]; shell: boolean } {
  if (platform === 'win32') {
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', clineCommand, '--yolo', prompt],
      shell: false,
    };
  }
  return { file: clineCommand, args: ['--yolo', prompt], shell: false };
}

/** How a Cline run failed — drives retry policy. */
export type ErrorKind = 'transient' | 'no_credits' | 'context_overflow' | 'timeout' | 'failed';

export function utcnow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function tailLines(text: string, n = 40): string {
  return text.split('\n').slice(-n).join('\n');
}

/**
 * Classify Cline's failure output. Transient errors (rate limits, network
 * blips) are worth retrying with backoff; out-of-credits and context
 * overflow will fail identically on retry, so they fail fast for Muse to
 * triage (top-up, or split the task).
 */
export function classifyError(output: string): ErrorKind {
  const t = output.toLowerCase();
  if (
    /insufficient.*credit|out of.*credit|credits?.*(exhausted|depleted)|exceeded.*quota|quota.*exceeded|\bbilling\b/.test(
      t,
    )
  ) {
    return 'no_credits';
  }
  if (
    /context.*(too large|too long|exceed|length|limit)|maximum context|token.*limit|exceed.*token|input.*too long|prompt.*too long/.test(
      t,
    )
  ) {
    return 'context_overflow';
  }
  if (
    /rate.?limit|429|too many requests|overloaded|server error|\b5\d\d\b|econnreset|econnrefused|enotfound|etimedout|network|fetch failed|socket hang up|try again|temporar|unavailable|gateway/.test(
      t,
    )
  ) {
    return 'transient';
  }
  return 'failed';
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export type RunnerPath = 'api' | 'cli';

export interface RetryDecision {
  retry: boolean;
  /** Backoff minutes before the next attempt. */
  delayMin: number;
}

/**
 * Decide whether a finished attempt should be retried.
 *
 * Rules (from protocol.md):
 * - 'transient' is always retryable (with backoff).
 * - 'timeout' is retryable only on the CLI path — we killed the process, so
 *   retrying is safe. On the extension-API path the Cline task may still be
 *   running in the sidebar; retrying would run the prompt twice, so it is
 *   never auto-retried.
 * - 'no_credits' / 'context_overflow' / 'failed' never retry.
 * - At most `maxRetries` retries (attempt counting starts at 1).
 */
export function shouldRetryTask(
  result: TaskState,
  errorKind: ErrorKind,
  via: RunnerPath,
  attempt: number,
  maxRetries: number,
): RetryDecision {
  const retryable = errorKind === 'transient' || (errorKind === 'timeout' && via === 'cli');
  if (result === 'success' || !retryable || attempt > maxRetries) {
    return { retry: false, delayMin: 0 };
  }
  return { retry: true, delayMin: attempt === 1 ? 2 : 10 };
}

// ---------------------------------------------------------------------------
// Project nickname resolution
// ---------------------------------------------------------------------------

export interface ProjectCommandArgs {
  path?: string;
  name?: string;
  project?: string;
}

/**
 * Resolve a command task's target. Tasks may name a project
 * (args.project, looked up in the bridge repo's projects.json) instead of
 * a raw path, so a typo can't nuke the wrong folder.
 */
export function resolveProjectTarget(
  args: ProjectCommandArgs | undefined,
  projectMap: Record<string, string>,
): { targetPath: string; name: string } {
  const a = args ?? {};
  if (a.project) {
    const name = String(a.project);
    const mapped = projectMap[name];
    if (!mapped) {
      throw new Error(`unknown project "${name}" — add it to projects.json in the bridge repo`);
    }
    return { targetPath: mapped, name };
  }
  const rawPath = a.path?.trim();
  if (!rawPath) {
    throw new Error('command task needs args.project (a name from projects.json) or args.path');
  }
  const name = a.name?.trim() || path.basename(path.resolve(rawPath));
  return { targetPath: rawPath, name };
}

/** Merge rule for auto-learning a project nickname → path mapping. */
export function mergeLearnedProject(
  map: Record<string, string>,
  name: string,
  targetPath: string,
): { changed: boolean } {
  if (map[name] === targetPath) {
    return { changed: false };
  }
  map[name] = targetPath;
  return { changed: true };
}

/** Merge rule for forgetting a project mapping (after deleteProject). */
export function mergeForgottenProject(
  map: Record<string, string>,
  name: string,
  targetPath: string,
): { changed: boolean } {
  if (map[name] !== targetPath) {
    return { changed: false };
  }
  delete map[name];
  return { changed: true };
}

/**
 * Refusal check for deleteProject. Returns the refusal reason, or null when
 * the target is not a protected path. The caller still checks existence.
 */
export function deleteProtectionReason(
  resolvedTarget: string,
  homeDir: string,
  repoPath: string,
): string | null {
  const protectedPaths = [homeDir, repoPath, path.parse(resolvedTarget).root, '/'].map((p) =>
    path.resolve(p),
  );
  if (protectedPaths.includes(path.resolve(resolvedTarget))) {
    return `refusing to delete protected path: ${resolvedTarget}`;
  }
  return null;
}

/**
 * Read the ntfy topic currently published in the bridge repo's notify.json.
 * Returns '' when the file is missing, unreadable, or has no topic string —
 * which the caller treats as "changed, needs publishing".
 */
export function readPublishedNotifyTopic(repoDir: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(repoDir, 'notify.json'), 'utf8')) as {
      topic?: unknown;
    };
    return typeof data.topic === 'string' ? data.topic : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Completion-marker heuristics for Cline's (undocumented) history schema
// ---------------------------------------------------------------------------

export function idOf(entry: unknown): string | undefined {
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
export function completionMarker(entry: unknown): 'done' | 'failed' | undefined {
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

/**
 * Turn the `backseat.bridgeRepo` setting into a cloneable git URL.
 * Accepts "owner/repo" shorthand or a full URL / SSH string.
 * Returns undefined for blank or unrecognized input.
 */
export function bridgeRepoUrl(repo: string): string | undefined {
  const r = (repo ?? '').trim().replace(/\/$/, '');
  if (!r) {
    return undefined;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) {
    return `https://github.com/${r}.git`;
  }
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(r) || r.endsWith('.git')) {
    return r;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Cline session transcript reading (session store: ~/.cline/data/sessions/)
// ---------------------------------------------------------------------------

/**
 * Pull readable text out of Cline's persisted session messages.
 * Handles BOTH shapes: ClineMessage ({type:'say'|'ask', say/ask, text} —
 * this is what the SDK persists, including ask:'api_req_failed' error
 * payloads) and Anthropic-style ({role, content:[...]}).
 *
 * Also reports the kind of the LAST chunk (e.g. 'api_req_failed',
 * 'followup', 'text', 'assistant') so callers can tell whether Cline is
 * showing a provider error, waiting on user input, or mid-stream.
 */
export interface TranscriptInfo {
  text: string;
  lastKind: string;
}

/**
 * One parsed, renderable transcript message. `label` is the compact
 * display tag (e.g. "say:text", "ask:api_req_failed", "assistant");
 * `kind` is the machine-usable sub-kind (e.g. "api_req_failed").
 */
export interface TranscriptChunk {
  label: string;
  kind: string;
  text: string;
}

/**
 * Parse a Cline session messages file into renderable chunks. Pure and
 * shared by transcriptInfo/transcriptTail/transcriptStats — handles BOTH
 * shapes: ClineMessage ({type:'say'|'ask', say/ask, text}) and
 * Anthropic-style ({role, content:[...]}). Returns [] on any read/parse
 * failure (never throws).
 */
export function parseTranscriptChunks(messagesPath: string): TranscriptChunk[] {
  try {
    const raw = fs.readFileSync(messagesPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed) ? parsed : (parsed as any)?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const chunks: TranscriptChunk[] = [];
    for (const m of messages) {
      const anyM = m as any;
      if (typeof anyM?.text === 'string' && anyM.text.trim()) {
        const type = typeof anyM?.type === 'string' && anyM.type ? anyM.type : 'msg';
        const sub = typeof anyM?.say === 'string' && anyM.say
          ? anyM.say
          : typeof anyM?.ask === 'string' && anyM.ask
            ? anyM.ask
            : '';
        chunks.push({
          label: sub ? `${type}:${sub}` : type,
          kind: sub || type,
          text: anyM.text.trim().slice(0, 1200),
        });
        continue;
      }
      const role = typeof anyM?.role === 'string' ? anyM.role : '';
      const content = anyM?.content;
      const blocks = Array.isArray(content)
        ? content
        : typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : [];
      for (const b of blocks) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          chunks.push({ label: role || 'msg', kind: role || 'msg', text: b.text.trim().slice(0, 1200) });
        } else if (b && b.type === 'tool_use' && typeof b.name === 'string') {
          const t = `${role || 'msg'} using tool: ${b.name}`;
          chunks.push({ label: role || 'msg', kind: role || 'msg', text: t });
        }
      }
    }
    return chunks;
  } catch {
    return [];
  }
}

export function transcriptInfo(messagesPath: string, maxChars: number): TranscriptInfo {
  const chunks = parseTranscriptChunks(messagesPath);
  // Keep the historical rendering: "<kind>: <text>" over the last 8
  // messages, cut to maxChars from the end.
  const tail = chunks.slice(-8).map((c) => `${c.kind}: ${c.text}`);
  const lastKind = chunks.length ? chunks[chunks.length - 1].kind : '';
  return { text: tail.join('\n').slice(-maxChars), lastKind };
}

/** Backwards-compatible text-only wrapper. */
export function transcriptText(messagesPath: string, maxChars: number): string {
  return transcriptInfo(messagesPath, maxChars).text;
}

export const TRANSCRIPT_TAIL_MAX_CHARS = 3000;
export const TRANSCRIPT_TAIL_MAX_MESSAGES = 12;
const TRANSCRIPT_TAIL_OMITTED = '[... earlier transcript omitted ...]';

/**
 * Render the last N transcript messages as compact one-per-line entries
 * like "[say:text] ..." / "[ask:api_req_failed] ...", bounded to
 * ~3000 chars total. When the transcript is longer, older messages are
 * dropped and a clear truncation marker heads the output. Empty
 * transcript → empty string. Never throws.
 *
 * This is what lands in tasks/done/<id>.json as `transcript_tail` so the
 * Muse side can see where Cline got stuck — especially on timeouts, where
 * the done record previously said nothing useful.
 */
export function transcriptTail(
  messagesPath: string,
  maxMessages: number = TRANSCRIPT_TAIL_MAX_MESSAGES,
  maxChars: number = TRANSCRIPT_TAIL_MAX_CHARS,
): string {
  const chunks = parseTranscriptChunks(messagesPath);
  if (!chunks.length) return '';
  const tail = chunks.slice(-Math.max(1, maxMessages));
  const lines = tail.map((c) => {
    const oneLine = c.text.replace(/\s+/g, ' ').trim().slice(0, 240);
    return `[${c.label}] ${oneLine}`;
  });
  let out = lines.join('\n');
  const omitted = chunks.length - tail.length;
  if (out.length > maxChars) {
    out = TRANSCRIPT_TAIL_OMITTED + '\n' + out.slice(-(maxChars - TRANSCRIPT_TAIL_OMITTED.length - 1));
  } else if (omitted > 0) {
    out = TRANSCRIPT_TAIL_OMITTED + '\n' + out;
    if (out.length > maxChars) {
      out = out.slice(0, maxChars);
    }
  }
  return out;
}

export interface TranscriptStats {
  messages: number;
  errorsSeen: number;
}

/** Cheap counts over the whole transcript: parsed messages and how many
 *  chunks match the provider-error regex. Never throws. */
export function transcriptStats(messagesPath: string): TranscriptStats {
  const chunks = parseTranscriptChunks(messagesPath);
  let errorsSeen = 0;
  for (const c of chunks) {
    if (TRANSCRIPT_ERROR_RE.test(c.text) || TRANSCRIPT_ERROR_RE.test(c.label)) errorsSeen++;
  }
  return { messages: chunks.length, errorsSeen };
}

/**
 * Attach `transcript_tail` + `transcript_stats` to a done-record-shaped
 * task object. Additive and backward compatible: with no messagesPath
 * the task is returned unchanged. The tail stays in the private bridge
 * repo — callers must never print it to logs.
 */
export function attachTranscriptTail<T>(
  task: T,
  messagesPath?: string,
): T & { transcript_tail?: string; transcript_stats?: TranscriptStats } {
  if (!messagesPath) return task as T & { transcript_tail?: string; transcript_stats?: TranscriptStats };
  return {
    ...task,
    transcript_tail: transcriptTail(messagesPath),
    transcript_stats: transcriptStats(messagesPath),
  };
}

/**
 * Matches a provider/agent error visible in a transcript tail —
 * including the ask:'api_req_failed' marker Cline persists on errors.
 */
export const TRANSCRIPT_ERROR_RE =
  /api_req_failed|api[ _-]?req[ _-]?failed|rejected the request|request failed|rate.?limit|\b429\b|\b401\b|\b5\d\d\b|insufficient[ _-]?credits|quota|invalid_request/i;

/**
 * Ask kinds where Cline is waiting on the USER (approval, follow-up
 * question, etc.) — Backseat must never auto-press those.
 */
const USER_AWAIT_ASKS = new Set([
  'followup',
  'tool',
  'command',
  'completion_result',
  'mistake_limit_reached',
  'browser_action_launch',
  'use_mcp_server',
  'ask_cline_question',
  'new_task',
  'condense',
]);

export function isAwaitingUserAsk(lastKind: string): boolean {
  return USER_AWAIT_ASKS.has(lastKind);
}

/**
 * Remote-cancel decision. The Muse side cancels a running task by moving
 * tasks/active/<id>.json to tasks/done/<id>.json on origin. The watch loop
 * never pulls (it would disturb its own heartbeat commits), so it checks
 * the remote ref directly via fetch + cat-file.
 *   true  -> the task file is still on origin: keep running.
 *   false -> gone from origin: someone cancelled it, stop now.
 *   null  -> could not determine (network/fetch failure): FAIL OPEN, keep
 *            running. A network blip must never cancel a task.
 */
export function isRemoteCancelled(remoteActiveExists: boolean | null): boolean {
  return remoteActiveExists === false;
}

/**
 * Decide what Backseat may do about a transcript-visible provider error.
 * Credits/quota/auth failures will fail identically on retry, so they are
 * 'manual' — surface them, never auto-press. Everything else is 'retry'.
 */
export function transcriptErrorAction(tail: string): 'retry' | 'manual' {  const t = tail.toLowerCase();
  if (
    /insufficient.*credit|out of.*credit|credits?.*(exhausted|depleted)|exceeded.*quota|quota.*exceeded|\bbilling\b|unauthorized|\b401\b|invalid[ _-]?api[ _-]?key|authentication/.test(
      t,
    )
  ) {
    return 'manual';
  }
  return 'retry';
}

/**
 * Find a Cline session by scanning session message files for a marker.
 *
 * WHY: tasks started via the extension API (`startNewTask`) create the
 * session with prompt:undefined — the row in sessions.index.json ends up
 * with prompt:null, so a marker search on the index can never match.
 * The full prompt (with our marker) only survives in the first user
 * message of the session's `<sessionId>.messages.json`.
 *
 * Scans session dirs newest-first, reads only the first 8KB of each
 * messages file (the marker is in the first user message), and stops at
 * the first match. Returns the session id and messages path.
 */
export function findSessionIdByMarker(
  sessionsDir: string,
  marker: string,
  maxDirs = 60,
): { sessionId: string; messagesPath: string } | null {
  let entries: any[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs: { name: string; mtime: number }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      dirs.push({
        name: e.name,
        mtime: fs.statSync(path.join(sessionsDir, e.name)).mtimeMs,
      });
    } catch {
      /* unreadable — skip */
    }
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const d of dirs.slice(0, maxDirs)) {
    const candidates = [path.join(sessionsDir, d.name, `${d.name}.messages.json`)];
    // Fall back to any *.messages.json in the dir (layout drift).
    try {
      for (const f of fs.readdirSync(path.join(sessionsDir, d.name))) {
        if (f.endsWith('.messages.json') && f !== `${d.name}.messages.json`) {
          candidates.push(path.join(sessionsDir, d.name, f));
        }
      }
    } catch {
      continue;
    }
    for (const mp of candidates) {
      let head = '';
      try {
        const fd = fs.openSync(mp, 'r');
        try {
          const buf = Buffer.alloc(8192);
          const n = fs.readSync(fd, buf, 0, 8192, 0);
          head = buf.subarray(0, n).toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      if (head.includes(marker)) {
        return { sessionId: d.name, messagesPath: mp };
      }
    }
  }
  return null;
}

/**
 * Decide whether a task's claim belongs to a dead runner.
 * Runner ids embed the extension-host pid as `<hostname>-<pid>-<random>`.
 * Returns true only when a pid parses AND the probe says it is gone;
 * unparseable ids fall back to heartbeat-staleness elsewhere (false here).
 */
export function isClaimedByDeadRunner(
  claimedBy: string,
  pidAlive: (pid: number) => boolean,
): boolean {
  const m = typeof claimedBy === 'string' ? claimedBy.match(/-(\d+)-[a-z0-9]{6,}$/) : null;
  if (!m) return false;
  return !pidAlive(parseInt(m[1], 10));
}

// ---------------------------------------------------------------------------
// Activity-based deadlines (0.9.14)
//
// A fixed wall-clock timeout cannot tell "working fine, 80% done" from
// "dead at minute 2" — field evidence from the Oct 2026 UE5 task series
// (BACKSEAT_BUGS_2026-10-12.md). Backseat now tracks ACTIVITY (transcript
// growth, CLI output bytes, stage commits pushed to the project repo) and
// only declares a timeout when the task goes quiet for
// `inactivityTimeoutMs`, OR when the absolute `timeout_sec` cap is hit.
// Timeout is then a *state*, not a *verdict*: on the sidebar path the
// extension keeps watching for a late completion and revises the record.
// ---------------------------------------------------------------------------

export interface ActivityDeadlineInput {
  startedAtMs: number;
  lastActivityMs: number;
  /** Absolute cap from task.timeout_sec (ms); <= 0 means no cap. */
  totalTimeoutMs: number;
  /** Quiet cap (ms); <= 0 means no cap. */
  inactivityTimeoutMs: number;
  nowMs: number;
}

export interface ActivityDeadline {
  /** Earliest epoch-ms at which the task times out (Infinity when uncapped). */
  deadlineMs: number;
  timedOut: boolean;
  reason: 'inactivity' | 'total' | null;
}

export function activityDeadline(i: ActivityDeadlineInput): ActivityDeadline {
  const total = i.totalTimeoutMs > 0 ? i.startedAtMs + i.totalTimeoutMs : Infinity;
  const quiet =
    i.inactivityTimeoutMs > 0 ? i.lastActivityMs + i.inactivityTimeoutMs : Infinity;
  const deadlineMs = Math.min(total, quiet);
  if (deadlineMs === Infinity || i.nowMs < deadlineMs) {
    return { deadlineMs, timedOut: false, reason: null };
  }
  return { deadlineMs, timedOut: true, reason: total <= quiet ? 'total' : 'inactivity' };
}

/** One project-repo commit linked to a task window (see linkedCommits). */
export interface LinkedCommit {
  sha: string;
  subject: string;
  /** True when the commit message names the task id (staged pushes do). */
  attributed: boolean;
}

/**
 * Link project-repo commits landed during a task's window into the task
 * record as evidence. Commits whose message names the task id are
 * `attributed`; everything else in the window is listed unattributed so
 * the architect can judge. Never throws on junk input.
 */
export function linkedCommits(
  commits: { sha: string; subject: string }[] | null | undefined,
  taskId: string,
): LinkedCommit[] {
  if (!Array.isArray(commits)) return [];
  const needle = String(taskId || '').toLowerCase();
  return commits.map((c) => ({
    sha: String(c?.sha ?? ''),
    subject: String(c?.subject ?? ''),
    attributed: needle !== '' && String(c?.subject ?? '').toLowerCase().includes(needle),
  }));
}

/**
 * Branch name for the non-disruptive worktree checkpoint. The checkpoint
 * commit is built with `git stash create -u` (worktree snapshot without
 * touching the user's branch/index), so it must never be a name the user
 * would use. Sanitized to valid git ref characters.
 */
export function checkpointBranchName(taskId: string): string {
  const safe =
    String(taskId || '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task';
  return `backseat/${safe}`;
}

/**
 * Turn parsed transcript chunks into a short progress summary: the last
 * user-visible text (skipping provider-error payloads) and the last tool
 * Cline reached for. Pure — the caller feeds parseTranscriptChunks().
 */
export function transcriptProgress(chunks: TranscriptChunk[]): {
  lastText: string;
  lastTool: string;
} {
  let lastText = '';
  let lastTool = '';
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i];
    if (!lastTool) {
      const m = /using tool: ([A-Za-z0-9_.-]+)/.exec(c.text);
      if (m) lastTool = m[1];
    }
    if (!lastText && !/api_req_failed/i.test(c.label) && c.text.trim().length > 8) {
      lastText = c.text.replace(/\s+/g, ' ').trim().slice(0, 140);
    }
    if (lastText && lastTool) break;
  }
  return { lastText, lastTool };
}

export interface ProgressNoteInput {
  messages: number;
  errorsSeen: number;
  lastText: string;
  lastTool: string;
  commitCount: number;
  minutesActive: number;
}

/**
 * One compact line for the status record's progress_note, e.g.
 * "transcript 107 msgs · 2 provider errors · last tool: write_to_file ·
 * last: edited VoxelWorld.cpp … · 2 stage commits · 41m active".
 */
export function buildProgressNote(p: ProgressNoteInput): string {
  const parts: string[] = [`transcript ${Math.max(0, Math.floor(p.messages))} msgs`];
  if (p.errorsSeen > 0) parts.push(`${p.errorsSeen} provider error${p.errorsSeen === 1 ? '' : 's'}`);
  if (p.lastTool) parts.push(`last tool: ${p.lastTool}`);
  if (p.lastText) parts.push(`last: ${p.lastText.slice(0, 90)}`);
  if (p.commitCount > 0) parts.push(`${p.commitCount} stage commit${p.commitCount === 1 ? '' : 's'}`);
  parts.push(`${Math.max(0, Math.round(p.minutesActive))}m active`);
  return parts.join(' · ');
}

/** Late completion observed after a sidebar-path timeout. */
export interface LateOutcome {
  result: 'success' | 'failed' | 'cancelled';
  output: string;
  exitCode: number;
  transcriptTail: string;
  transcriptStats: TranscriptStats;
  linkedCommits: LinkedCommit[];
}

/**
 * Merge a late completion into a timeout done record. The original
 * timeout verdict is preserved (`original_result`, `timed_out_at`) so
 * nothing already read becomes a lie — but `result` now says what
 * actually happened, with `completed_late: true`. This is the "timeout
 * is a state, not a verdict" rule from BACKSEAT_BUGS_2026-10-12.md.
 */
export function applyLateResult<T extends Record<string, unknown>>(
  done: T,
  late: LateOutcome,
  nowIso: string,
): T & Record<string, unknown> {
  return {
    ...done,
    original_result: done['result'],
    result: late.result,
    exit_code: late.exitCode,
    error: late.result === 'success' ? null : tailLines(late.output, 20) || 'no output',
    completed_late: true,
    timed_out_at: done['finished_at'],
    late_finished_at: nowIso,
    finished_at: nowIso,
    late_output_tail: late.output.slice(-2000),
    transcript_tail: late.transcriptTail,
    transcript_stats: late.transcriptStats,
    linked_commits: late.linkedCommits,
    late_watch: false,
    timeout_pending_late: false,
  };
}

/**
 * Decide whether a finished timeout record still wants late watching.
 * True only for sidebar-path timeouts (the process may still be running)
 * inside the configured window.
 */
export function wantsLateWatch(
  done: Record<string, unknown> | null | undefined,
  nowIso: string,
): boolean {
  if (!done || typeof done !== 'object') return false;
  if (done['timeout_pending_late'] !== true) return false;
  const until = done['late_watch_until'];
  if (typeof until !== 'string' || until <= nowIso) return false;
  return true;
}
