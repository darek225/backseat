/**
 * Backseat dashboard static tests — the webview can't run headless, so we
 * assert on the compiled output's security contract instead:
 * - a Content-Security-Policy meta tag exists
 * - the inline script carries the CSP nonce (VS Code blocks it otherwise)
 * - acquireVsCodeApi is called exactly once
 * - no inline event-handler attributes (CSP would block them)
 * - every message type the UI posts is handled by the provider
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'out', 'sidebar.js'), 'utf8');

test('dashboard: CSP meta tag present', () => {
  assert.ok(src.includes('Content-Security-Policy'), 'missing CSP meta tag');
});

test('dashboard: inline script carries the nonce', () => {
  assert.ok(/script nonce=/.test(src), 'script tag has no nonce — VS Code will block it');
  assert.ok(src.includes('nonce-${nonce}') || src.includes("nonce-' + nonce") || /nonce=/.test(src));
});

test('dashboard: acquireVsCodeApi called exactly once', () => {
  const calls = (src.match(/acquireVsCodeApi\(\)/g) || []).length;
  assert.equal(calls, 1, `expected 1 call, found ${calls}`);
});

test('dashboard: no inline event handlers (CSP blocks them)', () => {
  assert.ok(!/\son(click|change|submit|input)=/i.test(src), 'inline event handler found');
});

test('dashboard: UI->provider message types all handled by provider', () => {
  // vscode.postMessage = webview -> provider direction only
  const posted = [...src.matchAll(/vscode\.postMessage\(\{\s*type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
  const handled = [...src.matchAll(/case '([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(posted.length > 0, 'no vscode.postMessage types found');
  for (const t of new Set(posted)) {
    assert.ok(handled.includes(t), `message type '${t}' posted by UI but not handled`);
  }
});

test('dashboard: provider->UI message types all handled by webview', () => {
  // webview.postMessage = provider -> webview direction only
  const posted = [...src.matchAll(/webview\.postMessage\(\{\s*type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
  for (const t of new Set(posted)) {
    assert.ok(
      src.includes(`m.type === '${t}'`),
      `message type '${t}' posted by provider but not handled by webview`,
    );
  }
});

test('dashboard: backend interface methods exist on provider wiring', () => {
  for (const m of ['getDashboardState', 'saveSettings', 'collectDoctorReport', 'checkNow', 'startPolling', 'stopPolling']) {
    assert.ok(src.includes(`backend.${m}`), `provider never calls backend.${m}`);
  }
});
