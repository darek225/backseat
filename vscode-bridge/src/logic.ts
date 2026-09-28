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

export function transcriptInfo(messagesPath: string, maxChars: number): TranscriptInfo {
  try {
    const raw = fs.readFileSync(messagesPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed) ? parsed : (parsed as any)?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return { text: '', lastKind: '' };
    const chunks: { kind: string; text: string }[] = [];
    for (const m of messages.slice(-8)) {
      const anyM = m as any;
      if (typeof anyM?.text === 'string' && anyM.text.trim()) {
        const kind = anyM?.say || anyM?.ask || anyM?.type || 'msg';
        chunks.push({ kind, text: `${kind}: ${anyM.text.trim()}`.slice(0, 1200) });
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
          chunks.push({ kind: role || 'msg', text: `${role}: ${b.text.trim()}`.slice(0, 1200) });
        } else if (b && b.type === 'tool_use' && typeof b.name === 'string') {
          chunks.push({ kind: role || 'msg', text: `${role} using tool: ${b.name}` });
        }
      }
    }
    const lastKind = chunks.length ? chunks[chunks.length - 1].kind : '';
    return { text: chunks.map((c) => c.text).join('\n').slice(-maxChars), lastKind };
  } catch {
    return { text: '', lastKind: '' };
  }
}

/** Backwards-compatible text-only wrapper. */
export function transcriptText(messagesPath: string, maxChars: number): string {
  return transcriptInfo(messagesPath, maxChars).text;
}

/**
 * Matches a provider/agent error visible in a transcript tail —
 * including the ask:'api_req_failed' marker Cline persists on errors.
 */
export const TRANSCRIPT_ERROR_RE =
  /api_req_failed|api[ _-]?req[ _-]?failed|rejected the request|request failed|rate.?limit|\b429\b|\b401\b|\b5\d\d\b|insufficient[ _-]?credits|quota|invalid_request/i;

/**
 * Decide what Backseat may do about a transcript-visible provider error.
 * Credits/quota/auth failures will fail identically on retry, so they are
 * 'manual' — surface them, never auto-press. Everything else is 'retry'.
 */
export function transcriptErrorAction(tail: string): 'retry' | 'manual' {
  const t = tail.toLowerCase();
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
