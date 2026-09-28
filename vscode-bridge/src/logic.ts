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
