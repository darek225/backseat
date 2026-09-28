/**
 * Backseat sidebar dashboard — a clean tab instead of settings JSON + logs.
 *
 * sidebar.ts owns the webview HTML/JS and a small backend interface.
 * extension.ts implements the backend (no import cycle: this module never
 * imports extension.ts).
 */

import * as vscode from 'vscode';

/** One task row for the dashboard. */
export interface DashboardTask {
  kind: 'pending' | 'active' | 'done';
  id: string;
  title: string;
}

/** Everything the dashboard renders. */
export interface DashboardState {
  version: string;
  running: boolean;
  status: 'idle' | 'stopped' | 'working' | 'error';
  statusDetail: string;
  repoPath: string;
  bridgeRepo: string;
  notifyTopic: string;
  pollIntervalSec: number;
  currentTask: string;
  tasks: DashboardTask[];
}

/** What the dashboard needs from the extension side. */
export interface DashboardBackend {
  getDashboardState(): DashboardState;
  onDidChangeState: vscode.Event<void>;
  saveSettings(bridgeRepo: string, notifyTopic: string): Promise<void>;
  doctor(): Promise<string[]>;
  pollOnce(): Promise<void>;
  startPolling(): Promise<void>;
  stopPolling(): void;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'backseat.dashboard';

  private view?: vscode.WebviewView;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly backend: DashboardBackend,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready':
          this.pushState();
          break;
        case 'saveSettings':
          await this.backend.saveSettings(String(msg.bridgeRepo ?? ''), String(msg.notifyTopic ?? ''));
          this.pushState();
          break;
        case 'runDoctor': {
          const lines = await this.backend.doctor();
          this.view?.webview.postMessage({ type: 'doctor', lines });
          this.pushState();
          break;
        }
        case 'pollNow':
          await this.backend.pollOnce();
          this.pushState();
          break;
        case 'toggle':
          if (this.backend.getDashboardState().running) {
            this.backend.stopPolling();
          } else {
            await this.backend.startPolling();
          }
          this.pushState();
          break;
      }
    });
    this.pushState();
  }

  /** Push fresh state to the dashboard (called on every runner state change). */
  refresh(): void {
    this.pushState();
  }

  private pushState(): void {
    if (!this.view) {
      return;
    }
    try {
      this.view.webview.postMessage({ type: 'state', state: this.backend.getDashboardState() });
    } catch {
      /* view disposed */
    }
  }

  private html(): string {
    // Note: plain string concat would be unreadable; the template literal
    // below contains no backticks, so it's safe.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 12px;
    margin: 0;
  }
  h1 { font-size: 15px; margin: 0 0 10px 0; display: flex; align-items: center; gap: 8px; }
  .pill {
    font-size: 11px; font-weight: 600; padding: 2px 10px; border-radius: 20px;
    text-transform: uppercase; letter-spacing: 0.4px;
  }
  .pill.idle { background: var(--vscode-charts-green, #2d7d46); color: #fff; }
  .pill.working { background: var(--vscode-charts-blue, #1a6fc4); color: #fff; }
  .pill.stopped { background: var(--vscode-disabledForeground); color: var(--vscode-editor-background); }
  .pill.error { background: var(--vscode-charts-red, #c41a1a); color: #fff; }
  .card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;
  }
  .card h2 { font-size: 12px; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.75; }
  .row { display: flex; gap: 8px; margin-bottom: 8px; }
  .row:last-child { margin-bottom: 0; }
  label { font-size: 11px; opacity: 0.8; display: block; margin-bottom: 3px; }
  input[type=text] {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px 8px;
  }
  input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 7px 12px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .btnrow { display: flex; gap: 8px; flex-wrap: wrap; }
  .kv { font-size: 12px; margin: 3px 0; word-break: break-all; }
  .kv b { opacity: 0.7; font-weight: 600; }
  .task { font-size: 12px; padding: 4px 0; border-top: 1px solid var(--vscode-panel-border); }
  .task:first-of-type { border-top: none; }
  .kind { font-size: 10px; font-weight: 700; text-transform: uppercase; margin-right: 6px; opacity: 0.7; }
  .kind.pending { color: var(--vscode-charts-yellow, #c4a11a); }
  .kind.active { color: var(--vscode-charts-blue, #1a6fc4); }
  .kind.done { color: var(--vscode-charts-green, #2d7d46); }
  .doc-pass { color: var(--vscode-charts-green, #2d7d46); font-size: 12px; margin: 2px 0; }
  .doc-fail { color: var(--vscode-charts-red, #c41a1a); font-size: 12px; margin: 2px 0; }
  .hint { font-size: 11px; opacity: 0.65; margin-top: 6px; }
  .hidden { display: none; }
</style>
</head>
<body>
  <h1>Backseat <span id="pill" class="pill stopped">…</span></h1>

  <div class="card">
    <h2>Status</h2>
    <div class="kv"><b>State:</b> <span id="st-state">–</span></div>
    <div class="kv"><b>Bridge repo:</b> <span id="st-repo">–</span></div>
    <div class="kv"><b>Current task:</b> <span id="st-task">–</span></div>
    <div class="kv"><b>Poll every:</b> <span id="st-poll">–</span>s</div>
  </div>

  <div class="card">
    <h2>Setup</h2>
    <div class="row"><div style="flex:1">
      <label for="in-repo">Private bridge repo (owner/repo)</label>
      <input type="text" id="in-repo" placeholder="you/backseat-bridge" />
    </div></div>
    <div class="row"><div style="flex:1">
      <label for="in-topic">Instant-ping topic (optional)</label>
      <input type="text" id="in-topic" placeholder="backseat-9f3k7q2x" />
    </div></div>
    <div class="btnrow"><button id="btn-save">Save &amp; connect</button></div>
    <div class="hint">The extension clones the repo into ~/.backseat/bridge itself. No folder to open.</div>
  </div>

  <div class="card">
    <h2>Actions</h2>
    <div class="btnrow">
      <button id="btn-toggle">Start</button>
      <button id="btn-poll" class="secondary">Check now</button>
      <button id="btn-doctor" class="secondary">Run setup doctor</button>
    </div>
  </div>

  <div class="card hidden" id="card-doctor">
    <h2>Doctor <span id="doc-ver" style="text-transform:none"></span></h2>
    <div id="doc-lines"></div>
  </div>

  <div class="card">
    <h2>Tasks</h2>
    <div id="tasks"><div class="hint">No tasks yet.</div></div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let S = null;

  function $(id) { return document.getElementById(id); }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { S = m.state; render(); }
    if (m.type === 'doctor') { renderDoctor(m.lines); }
  });

  function render() {
    if (!S) return;
    const pill = $('pill');
    pill.className = 'pill ' + S.status;
    pill.textContent = S.running ? (S.status === 'working' ? 'working' : 'on') : 'off';
    $('st-state').textContent = S.running ? ('polling' + (S.statusDetail ? ' — ' + S.statusDetail : '')) : 'stopped';
    $('st-repo').textContent = S.repoPath || '(not set)';
    $('st-task').textContent = S.currentTask || 'none';
    $('st-poll').textContent = S.pollIntervalSec;
    if (document.activeElement !== $('in-repo')) $('in-repo').value = S.bridgeRepo || '';
    if (document.activeElement !== $('in-topic')) $('in-topic').value = S.notifyTopic || '';
    $('btn-toggle').textContent = S.running ? 'Stop' : 'Start';
    const box = $('tasks');
    if (!S.tasks.length) {
      box.innerHTML = '<div class="hint">No tasks yet. Queue one from your Muse: queue: &lt;description&gt;</div>';
    } else {
      box.innerHTML = S.tasks.map((t) =>
        '<div class="task"><span class="kind ' + t.kind + '">' + t.kind + '</span>' +
        escapeHtml(t.title || t.id) + '</div>'
      ).join('');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function renderDoctor(lines) {
    const card = $('card-doctor');
    card.classList.remove('hidden');
    const first = lines[0] || '';
    const mver = first.match(/v(\\d+\\.\\d+\\.\\d+)/);
    $('doc-ver').textContent = mver ? 'v' + mver[1] : '';
    $('doc-lines').innerHTML = lines.slice(1).map((l) => {
      const pass = l.indexOf('PASS') === 0;
      return '<div class="' + (pass ? 'doc-pass' : 'doc-fail') + '">' + escapeHtml(l) + '</div>';
    }).join('');
  }

  $('btn-save').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveSettings', bridgeRepo: $('in-repo').value, notifyTopic: $('in-topic').value });
  });
  $('btn-toggle').addEventListener('click', () => vscode.postMessage({ type: 'toggle' }));
  $('btn-poll').addEventListener('click', () => vscode.postMessage({ type: 'pollNow' }));
  $('btn-doctor').addEventListener('click', () => vscode.postMessage({ type: 'runDoctor' }));

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
