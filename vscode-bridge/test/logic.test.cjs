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

test('clineSpawnTarget: provider/model flags are passed through', () => {
  const t = logic.clineSpawnTarget('cline', 'do it', 'win32', { provider: 'openrouter', model: 'deepseek/deepseek-chat' });
  assert.deepEqual(t.args, ['/d', '/s', '/c', 'cline', '--yolo', '-P', 'openrouter', '-m', 'deepseek/deepseek-chat', 'do it']);
});

test('clineSpawnTarget: posix passes provider/model flags too', () => {
  const t = logic.clineSpawnTarget('cline', 'do it', 'linux', { provider: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(t.args, ['--yolo', '-P', 'deepseek', '-m', 'deepseek-chat', 'do it']);
});

test('clineSpawnTarget: prompt stays the LAST argv element with flags set', () => {
  const t = logic.clineSpawnTarget('cline', 'the prompt', 'win32', { provider: 'p', model: 'm' });
  assert.equal(t.args[t.args.length - 1], 'the prompt');
});
