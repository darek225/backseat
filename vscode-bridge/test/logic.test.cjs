/** Backseat unit tests — pure logic (no VS Code dependency). Run: npm test */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logic = require('../out/logic.js');

test('utcnow: ISO format without millis', () => {
  const s = logic.utcnow();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('tailLines: keeps the last n lines', () => {
  assert.equal(logic.tailLines('a\nb\nc\nd', 2), 'c\nd');
  assert.equal(logic.tailLines('a\nb', 10), 'a\nb');
});

test('classifyError: credits', () => {
  assert.equal(logic.classifyError('Insufficient credits, please top up'), 'no_credits');
  assert.equal(logic.classifyError('You are out of credits'), 'no_credits');
  assert.equal(logic.classifyError('quota exceeded for this billing period'), 'no_credits');
});

test('classifyError: context overflow', () => {
  assert.equal(logic.classifyError('context window too large for model'), 'context_overflow');
  assert.equal(logic.classifyError('maximum context length exceeded'), 'context_overflow');
  assert.equal(logic.classifyError('prompt is too long'), 'context_overflow');
});

test('classifyError: transient', () => {
  assert.equal(logic.classifyError('429 rate limit, try again later'), 'transient');
  assert.equal(logic.classifyError('socket hang up'), 'transient');
  assert.equal(logic.classifyError('server error 503, temporarily unavailable'), 'transient');
  assert.equal(logic.classifyError('ENOTFOUND api.example.com'), 'transient');
});

test('classifyError: unknown output is failed', () => {
  assert.equal(logic.classifyError('syntax error on line 12'), 'failed');
  assert.equal(logic.classifyError(''), 'failed');
});

test('shouldRetryTask: transient retries with backoff', () => {
  assert.deepEqual(logic.shouldRetryTask('failed', 'transient', 'cli', 1, 2), { retry: true, delayMin: 2 });
  assert.deepEqual(logic.shouldRetryTask('failed', 'transient', 'cli', 2, 2), { retry: true, delayMin: 10 });
  assert.deepEqual(logic.shouldRetryTask('failed', 'transient', 'cli', 3, 2), { retry: false, delayMin: 0 });
});

test('shouldRetryTask: timeout only on CLI path', () => {
  assert.equal(logic.shouldRetryTask('timeout', 'timeout', 'cli', 1, 2).retry, true);
  assert.equal(logic.shouldRetryTask('timeout', 'timeout', 'api', 1, 2).retry, false);
});

test('shouldRetryTask: never retries credits/context/failed/success', () => {
  for (const kind of ['no_credits', 'context_overflow', 'failed']) {
    assert.equal(logic.shouldRetryTask('failed', kind, 'cli', 1, 2).retry, false, kind);
  }
  assert.equal(logic.shouldRetryTask('success', 'transient', 'cli', 1, 2).retry, false);
});

test('resolveProjectTarget: nickname lookup', () => {
  const map = { blog: '/home/u/code/blog' };
  assert.deepEqual(logic.resolveProjectTarget({ project: 'blog' }, map), {
    targetPath: '/home/u/code/blog',
    name: 'blog',
  });
  assert.throws(() => logic.resolveProjectTarget({ project: 'nope' }, map), /unknown project/);
});

test('resolveProjectTarget: raw path', () => {
  const r = logic.resolveProjectTarget({ path: '/tmp/x' }, {});
  assert.equal(r.targetPath, '/tmp/x');
  assert.equal(r.name, 'x');
  assert.throws(() => logic.resolveProjectTarget({}, {}), /needs args/);
});

test('mergeLearnedProject / mergeForgottenProject', () => {
  const map = {};
  assert.equal(logic.mergeLearnedProject(map, 'blog', '/a').changed, true);
  assert.equal(logic.mergeLearnedProject(map, 'blog', '/a').changed, false);
  assert.equal(logic.mergeLearnedProject(map, 'blog', '/b').changed, true);
  assert.equal(logic.mergeForgottenProject(map, 'blog', '/nope').changed, false);
  assert.equal(logic.mergeForgottenProject(map, 'blog', '/b').changed, true);
  assert.ok(!('blog' in map));
});

test('deleteProtectionReason: refuses home, repo, fs root', () => {
  const home = os.homedir();
  assert.ok(logic.deleteProtectionReason(home, home, '/repo'));
  assert.ok(logic.deleteProtectionReason('/repo', home, '/repo'));
  assert.ok(logic.deleteProtectionReason('/', home, '/repo'));
  assert.equal(logic.deleteProtectionReason(path.join(home, 'code', 'blog'), home, '/repo'), null);
});

test('readPublishedNotifyTopic: file / missing / malformed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  try {
    assert.equal(logic.readPublishedNotifyTopic(dir), '');
    fs.writeFileSync(path.join(dir, 'notify.json'), JSON.stringify({ topic: 'abc123' }));
    assert.equal(logic.readPublishedNotifyTopic(dir), 'abc123');
    fs.writeFileSync(path.join(dir, 'notify.json'), 'not json');
    assert.equal(logic.readPublishedNotifyTopic(dir), '');
    fs.writeFileSync(path.join(dir, 'notify.json'), JSON.stringify({ topic: 42 }));
    assert.equal(logic.readPublishedNotifyTopic(dir), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idOf / completionMarker', () => {
  assert.equal(logic.idOf({ taskId: 't1' }), 't1');
  assert.equal(logic.idOf({ task_id: 't2' }), 't2');
  assert.equal(logic.idOf({}), undefined);
  assert.equal(logic.completionMarker({ status: 'completed' }), 'done');
  assert.equal(logic.completionMarker({ state: 'FAILED' }), 'failed');
  assert.equal(logic.completionMarker({ status: 'incomplete' }), undefined);
  assert.equal(logic.completionMarker(null), undefined);
});

test('bridgeRepoUrl: shorthand, URLs, rejects junk', () => {
  assert.equal(logic.bridgeRepoUrl('darek225/MYbackseat'), 'https://github.com/darek225/MYbackseat.git');
  assert.equal(logic.bridgeRepoUrl('https://github.com/darek225/MYbackseat.git'), 'https://github.com/darek225/MYbackseat.git');
  assert.equal(logic.bridgeRepoUrl('git@github.com:darek225/MYbackseat.git'), 'git@github.com:darek225/MYbackseat.git');
  assert.equal(logic.bridgeRepoUrl(''), undefined);
  assert.equal(logic.bridgeRepoUrl('not a repo!!!'), undefined);
  assert.equal(logic.bridgeRepoUrl('a/b/c'), undefined);
});

test('clineSpawnTarget: win32 routes through cmd.exe with prompt as ONE argv element', () => {
  const t = logic.clineSpawnTarget('cline', 'Create a file named hello.txt', 'win32');
  assert.equal(t.file, 'cmd.exe');
  assert.equal(t.shell, false);
  assert.deepEqual(t.args.slice(0, 4), ['/d', '/s', '/c', 'cline']);
  assert.equal(t.args[4], '--yolo');
  assert.equal(t.args[5], 'Create a file named hello.txt', 'prompt must stay a single argv element');
});

test('clineSpawnTarget: win32 keeps special chars inside the single prompt arg', () => {
  const prompt = 'Write "hi" & done — 100% sure!';
  const t = logic.clineSpawnTarget('cline', prompt, 'win32');
  assert.equal(t.args[5], prompt);
});

test('clineSpawnTarget: posix spawns the CLI directly, no shell', () => {
  for (const plat of ['linux', 'darwin']) {
    const t = logic.clineSpawnTarget('cline', 'do the thing', plat);
    assert.equal(t.file, 'cline');
    assert.deepEqual(t.args, ['--yolo', 'do the thing']);
    assert.equal(t.shell, false);
  }
});

test('transcriptText: reads ClineMessage-shaped error transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  // Shape the Cline SDK actually persists (see message-translator.ts):
  // ask:"api_req_failed" with the provider error as text.
  const messages = [
    { ts: 1, type: 'say', say: 'text', text: 'I will add the placement rules now.' },
    { ts: 2, type: 'say', say: 'api_req_started', text: JSON.stringify({ streamingFailedMessage: 'provider rejected the request: invalid request' }) },
    { ts: 3, type: 'ask', ask: 'api_req_failed', text: 'provider rejected the request: invalid request error trace_id: [redacted]' },
  ];
  fs.writeFileSync(p, JSON.stringify(messages));
  const tail = logic.transcriptText(p, 4000);
  assert.ok(tail.includes('api_req_failed'), 'error ask kind visible, got: ' + tail.slice(0, 200));
  assert.ok(tail.includes('provider rejected the request'), 'error text visible');
  assert.ok(logic.TRANSCRIPT_ERROR_RE.test(tail), 'error regex matches the tail');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptText: still reads Anthropic-style messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }, { type: 'tool_use', name: 'write_to_file' }] },
  ];
  fs.writeFileSync(p, JSON.stringify(messages));
  const tail = logic.transcriptText(p, 4000);
  assert.ok(tail.includes('Working on it'));
  assert.ok(tail.includes('using tool: write_to_file'));
  assert.ok(!logic.TRANSCRIPT_ERROR_RE.test(tail), 'no false positive on normal transcript');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptText: missing file returns empty string', () => {
  assert.equal(logic.transcriptText('/nonexistent/messages.json', 1000), '');
});

test('transcriptInfo: lastKind is api_req_failed for error transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  const messages = [
    { ts: 1, type: 'say', say: 'text', text: 'I will add the placement rules now.' },
    { ts: 2, type: 'ask', ask: 'api_req_failed', text: 'provider rejected the request: invalid request' },
  ];
  fs.writeFileSync(p, JSON.stringify(messages));
  const info = logic.transcriptInfo(p, 4000);
  assert.equal(info.lastKind, 'api_req_failed');
  assert.ok(info.text.includes('provider rejected the request'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptInfo: lastKind follows a followup ask (awaiting user)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  const messages = [
    { ts: 1, type: 'say', say: 'text', text: 'Working.' },
    { ts: 2, type: 'ask', ask: 'followup', text: 'Should I continue with the scoring system?' },
  ];
  fs.writeFileSync(p, JSON.stringify(messages));
  const info = logic.transcriptInfo(p, 4000);
  assert.equal(info.lastKind, 'followup');
  assert.ok(!logic.TRANSCRIPT_ERROR_RE.test(info.text), 'no false positive on followup');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptInfo: Anthropic shape lastKind is the role', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] }];
  fs.writeFileSync(p, JSON.stringify(messages));
  const info = logic.transcriptInfo(p, 4000);
  assert.equal(info.lastKind, 'assistant');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findSessionIdByMarker: finds newest session with marker in messages head', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const mkSession = (name, firstUserText, mtimeOffsetMs) => {
    const sd = path.join(dir, name);
    fs.mkdirSync(sd);
    fs.writeFileSync(
      path.join(sd, `${name}.messages.json`),
      JSON.stringify([{ ts: 1, type: 'say', say: 'text', text: firstUserText }]),
    );
    const t = new Date(Date.now() - mtimeOffsetMs);
    fs.utimesSync(sd, t, t);
  };
  mkSession('sess-old', '[backseat:task:20260928-blokus-2-rules]\nDo the rules.', 600_000);
  mkSession('sess-new', '[backseat:task:20260928-blokus-2-rules]\nDo the rules (retry).', 60_000);
  mkSession('sess-other', 'Just chatting about the weather.', 10_000);
  const found = logic.findSessionIdByMarker(dir, '[backseat:task:20260928-blokus-2-rules]');
  assert.ok(found, 'marker session found');
  assert.equal(found.sessionId, 'sess-new', 'newest match wins');
  assert.ok(found.messagesPath.endsWith('sess-new.messages.json'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findSessionIdByMarker: null when nothing matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const sd = path.join(dir, 'sess-1');
  fs.mkdirSync(sd);
  fs.writeFileSync(
    path.join(sd, 'sess-1.messages.json'),
    JSON.stringify([{ ts: 1, type: 'say', say: 'text', text: 'hello' }]),
  );
  assert.equal(logic.findSessionIdByMarker(dir, '[backseat:task:nope]'), null);
  assert.equal(logic.findSessionIdByMarker(path.join(dir, 'missing'), '[backseat:task:nope]'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findSessionIdByMarker: marker past the 8KB head is not found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const sd = path.join(dir, 'sess-big');
  fs.mkdirSync(sd);
  const padding = 'x'.repeat(9000);
  fs.writeFileSync(
    path.join(sd, 'sess-big.messages.json'),
    JSON.stringify([{ ts: 1, type: 'say', say: 'text', text: padding + '[backseat:task:late]' }]),
  );
  assert.equal(logic.findSessionIdByMarker(dir, '[backseat:task:late]'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptErrorAction: credits and auth are manual, provider errors retry', () => {
  assert.equal(logic.transcriptErrorAction('api_req_failed: insufficient credits, please top up'), 'manual');
  assert.equal(logic.transcriptErrorAction('api_req_failed: 401 unauthorized, invalid api key'), 'manual');
  assert.equal(logic.transcriptErrorAction('api_req_failed: provider rejected the request: invalid request'), 'retry');
  assert.equal(logic.transcriptErrorAction('api_req_failed: 429 rate limit, try again later'), 'retry');
});

test('isRemoteCancelled: only a definite remote deletion cancels, unknown fails open', () => {
  assert.equal(logic.isRemoteCancelled(false), true);
  assert.equal(logic.isRemoteCancelled(true), false);
  assert.equal(logic.isRemoteCancelled(null), false);
});

test('isAwaitingUserAsk: user-facing asks blocked, error and say kinds allowed', () => {
  assert.equal(logic.isAwaitingUserAsk('followup'), true);
  assert.equal(logic.isAwaitingUserAsk('tool'), true);
  assert.equal(logic.isAwaitingUserAsk('completion_result'), true);
  assert.equal(logic.isAwaitingUserAsk('api_req_failed'), false);
  assert.equal(logic.isAwaitingUserAsk('text'), false);
  assert.equal(logic.isAwaitingUserAsk('assistant'), false);
  assert.equal(logic.isAwaitingUserAsk(''), false);
});

test('isClaimedByDeadRunner: dead pid reclaims', () => {
  assert.equal(logic.isClaimedByDeadRunner('DESKTOP-ABC-20384-z9b5sicb', () => false), true);
  assert.equal(logic.isClaimedByDeadRunner('myhost-20384-z9b5sicb', () => true), false);
  assert.equal(logic.isClaimedByDeadRunner('legacy-claim-without-pid', () => false), false);
  assert.equal(logic.isClaimedByDeadRunner('', () => false), false);
});

test('transcriptTail: renders both message shapes as compact lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  const messages = [
    { ts: 1, type: 'say', say: 'text', text: 'I will add the placement rules now.' },
    { ts: 2, type: 'ask', ask: 'api_req_failed', text: 'provider rejected the request: invalid request' },
    { role: 'assistant', content: [{ type: 'text', text: 'Retrying with a smaller edit.' }] },
  ];
  fs.writeFileSync(p, JSON.stringify(messages));
  const tail = logic.transcriptTail(p);
  assert.ok(tail.includes('[say:text] I will add the placement rules now.'), 'say line, got: ' + tail);
  assert.ok(tail.includes('[ask:api_req_failed] provider rejected the request'), 'ask line');
  assert.ok(tail.includes('[assistant] Retrying with a smaller edit.'), 'Anthropic line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptTail: empty transcript yields empty string', () => {
  assert.equal(logic.transcriptTail('/nonexistent/messages.json'), '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  fs.writeFileSync(p, JSON.stringify([]));
  assert.equal(logic.transcriptTail(p), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptTail: bounded with truncation marker on long transcripts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  const messages = [];
  for (let i = 0; i < 60; i++) {
    messages.push({ ts: i, type: 'say', say: 'text', text: `progress update number ${i}: ` + 'x'.repeat(200) });
  }
  messages.push({ ts: 61, type: 'say', say: 'text', text: 'FINAL-MARKER final message' });
  fs.writeFileSync(p, JSON.stringify(messages));
  const tail = logic.transcriptTail(p);
  assert.ok(tail.length <= 3000, `bounded to 3000 chars, got ${tail.length}`);
  assert.ok(tail.includes('[... earlier transcript omitted ...]'), 'truncation marker present');
  assert.ok(tail.includes('FINAL-MARKER'), 'most recent message kept');
  assert.ok(!tail.includes('progress update number 0:'), 'oldest messages dropped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptTail: no truncation marker when transcript fits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  fs.writeFileSync(p, JSON.stringify([
    { ts: 1, type: 'say', say: 'text', text: 'short one' },
    { ts: 2, type: 'say', say: 'text', text: 'short two' },
  ]));
  const tail = logic.transcriptTail(p);
  assert.ok(!tail.includes('omitted'), 'no truncation marker for short transcript');
  assert.ok(tail.includes('short one') && tail.includes('short two'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcriptStats: counts messages and errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  fs.writeFileSync(p, JSON.stringify([
    { ts: 1, type: 'say', say: 'text', text: 'working' },
    { ts: 2, type: 'ask', ask: 'api_req_failed', text: 'provider rejected the request' },
    { ts: 3, type: 'ask', ask: 'api_req_failed', text: '429 rate limit' },
  ]));
  const stats = logic.transcriptStats(p);
  assert.deepEqual(stats, { messages: 3, errorsSeen: 2 });
  assert.deepEqual(logic.transcriptStats('/nonexistent/messages.json'), { messages: 0, errorsSeen: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attachTranscriptTail: timeout-shaped task gets tail and stats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backseat-test-'));
  const p = path.join(dir, 'messages.json');
  fs.writeFileSync(p, JSON.stringify([
    { ts: 1, type: 'say', say: 'text', text: 'editing index.html scoring' },
    { ts: 2, type: 'say', say: 'text', text: 'verifying game-end logic' },
  ]));
  const task = { id: 't1', result: 'timeout', exit_code: 124 };
  const out = logic.attachTranscriptTail(task, p);
  assert.equal(out.result, 'timeout', 'original fields preserved');
  assert.ok(typeof out.transcript_tail === 'string' && out.transcript_tail.includes('verifying game-end logic'));
  assert.deepEqual(out.transcript_stats, { messages: 2, errorsSeen: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attachTranscriptTail: no messagesPath leaves task unchanged', () => {
  const task = { id: 't2', result: 'success' };
  const out = logic.attachTranscriptTail(task, undefined);
  assert.ok(!('transcript_tail' in out), 'no tail field added');
  assert.ok(!('transcript_stats' in out), 'no stats field added');
});
