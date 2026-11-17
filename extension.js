'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const X = require('./src/executors');
const { run } = require('./src/runner');
const { parseDiagnostics } = require('./src/diagnostics');

let out, statusItem, diag, term = null;
let running = null;          // { kill, done, label }
let lastRequest = null;      // request used for Re-run
let lastResult = null;       // { ok, code, ms }
let watch = null;            // { fsPath }
let watchTimer = null;
const history = [];
const lastArgs = new Map();
const lastStdin = new Map();

const cfg = res => vscode.workspace.getConfiguration('ignite', res);
const secs = ms => (ms / 1000).toFixed(3);

function setRunning(handle) {
  running = handle;
  vscode.commands.executeCommand('setContext', 'ignite.running', !!handle);
  updateStatus();
}

function updateStatus() {
  if (running) {
    statusItem.text = `$(sync~spin) Running ${running.label}`;
    statusItem.tooltip = 'Ignite Runner — click to stop (Ctrl+Alt+X)';
    statusItem.command = 'ignite.stop';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    let t = '$(play) Run';
    if (lastResult) t += lastResult.ok ? `  $(check) ${lastResult.ms < 1000 ? Math.round(lastResult.ms) + 'ms' : secs(lastResult.ms) + 's'}` : `  $(error) exit ${lastResult.code}`;
    if (watch) t += '  $(eye)';
    statusItem.text = t;
    statusItem.tooltip = 'Ignite Runner — run current file (Ctrl+Alt+R)' + (watch ? ' · Watch mode ON' : '');
    statusItem.command = 'ignite.run';
    statusItem.backgroundColor = undefined;
  }
  statusItem.show();
}

function pythonPath(res) {
  const p = vscode.workspace.getConfiguration('python', res).get('defaultInterpreterPath');
  return p && p !== 'python' ? p : undefined;
}

function writeSnippet(langId, text, c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ignite-'));
  let name = 'snippet';
  if (langId === 'java') { const m = /\b(?:public\s+)?class\s+(\w+)/.exec(text); name = m ? m[1] : 'Main'; }
  const file = path.join(dir, name + X.extFor(langId, c.get('languageIdToFileExtensionMap')));
  fs.writeFileSync(file, text);
  return { file, dir };
}

async function prepare(req) {
  const editor = vscode.window.activeTextEditor;
  let doc = null, file = null, langId, text = '', tmpDir = null;

  if (req.snippetText === undefined) {
    doc = req.uri ? await vscode.workspace.openTextDocument(req.uri) : editor && editor.document;
    if (!doc && req.mode !== 'custom') { vscode.window.showWarningMessage('Ignite: open a file or select some code first.'); return null; }
  }
  const res = doc ? doc.uri : editor && editor.document.uri;
  const c = cfg(res);
  const wsFolder = res && vscode.workspace.getWorkspaceFolder(res) || (vscode.workspace.workspaceFolders || [])[0];
  const wsRoot = wsFolder && wsFolder.uri.fsPath;

  if (req.snippetText !== undefined) {
    langId = req.languageOverride || req.snippetLang; text = req.snippetText;
  } else if (doc) {
    req.uri = doc.uri;
    langId = req.languageOverride || doc.languageId; text = doc.getText();
    if (doc.uri.scheme === 'file' && !doc.isUntitled) {
      file = doc.fileName;
      if (c.get('saveAllFilesBeforeRun')) await vscode.workspace.saveAll(false);
      else if (c.get('saveFileBeforeRun') && doc.isDirty) await doc.save();
      text = doc.getText();
    } else { req.snippetText = text; req.snippetLang = doc.languageId; }
  }

  let command;
  if (req.mode === 'custom') {
    command = await vscode.window.showInputBox({ prompt: 'Custom command ($fullFileName, $dir, $workspaceRoot… allowed)', value: req.lastCustom || c.get('customCommand', 'echo Hello') });
    if (!command) return null;
    req.lastCustom = command;
  } else {
    if (req.snippetText !== undefined) { const s = writeSnippet(langId || c.get('defaultLanguage'), req.snippetText, c); file = s.file; tmpDir = s.dir; }
    const ex = X.resolveExecutor({
      languageId: langId, fileName: file, relPath: wsRoot ? path.relative(wsRoot, file) : file, text,
      userMap: c.get('executorMap'), userExt: c.get('executorMapByFileExtension'), userGlob: c.get('executorMapByGlob'),
      defaultLanguage: c.get('defaultLanguage'), respectShebang: c.get('respectShebang'), skipGlob: !!req.languageOverride
    });
    if (!ex) {
      const b = await vscode.window.showErrorMessage(`Ignite: no executor for "${langId}". Add one in ignite.executorMap.`, 'Open Settings');
      if (b) vscode.commands.executeCommand('workbench.action.openSettings', 'ignite.executorMap');
      return null;
    }
    const pick = X.pickCandidate(ex.candidates);
    command = pick.command;
    if (pick.missing) {
      const hint = X.HINTS[pick.missing];
      const btns = hint && hint.startsWith('http') ? ['Open install page', 'Run anyway'] : ['Run anyway'];
      const b = await vscode.window.showWarningMessage(`Ignite: "${pick.missing}" was not found in PATH.` + (hint && !hint.startsWith('http') ? ` Try: ${hint}` : ''), ...btns);
      if (b === 'Open install page') vscode.env.openExternal(vscode.Uri.parse(hint.split(' ')[0]));
      if (b !== 'Run anyway') return null;
    }
  }

  const vars = X.buildVars(file, wsRoot, pythonPath(res));
  command = X.substitute(command, vars, { appendFile: req.mode !== 'custom' });
  if (req.args) command += ' ' + req.args;

  let cwd = c.get('cwd');
  if (cwd) cwd = X.substitute(cwd, vars, { appendFile: false, quoteValues: false });
  else if (c.get('fileDirectoryAsCwd') && file && !tmpDir) cwd = path.dirname(file);
  else cwd = wsRoot || (file ? path.dirname(file) : os.homedir());

  // stdin
  let stdin;
  const mode = c.get('inputMode', 'smart');
  if (!c.get('runInTerminal') && mode !== 'never' && req.mode !== 'custom') {
    if (req.forceInput || mode === 'always' || (mode === 'smart' && X.INPUT_RE.test(text))) {
      const key = file || 'snippet';
      const v = await vscode.window.showInputBox({
        title: 'Ignite — standard input', prompt: 'Input for your program. Use \\n for new lines. Leave empty for none. Esc cancels.',
        value: lastStdin.get(key) || '', ignoreFocusOut: true
      });
      if (v === undefined) return null;
      lastStdin.set(key, v);
      stdin = v.replace(/\\n/g, '\n') + (v ? '\n' : '');
    }
  }
  return { command, cwd, stdin, file, tmpDir, res, label: file ? path.basename(file) : 'command', text };
}

async function launch(plan) {
  const c = cfg(plan.res);
  if (running) { running.kill(); await running.done.catch(() => {}); }
  if (term) { try { term.dispose(); } catch (_) {} term = null; }
  diag.clear();

  if (c.get('runInTerminal')) {
    term = vscode.window.createTerminal({ name: 'Ignite Runner', cwd: plan.cwd, env: c.get('env') });
    term.show(c.get('preserveFocus'));
    term.sendText(plan.command);
    addHistory(plan, { code: null, ms: 0 });
    return;
  }

  if (c.get('clearPreviousOutput')) out.clear();
  out.show(c.get('preserveFocus'));
  const msg = c.get('showExecutionMessage');
  if (msg) out.appendLine(`▶ [Running] ${plan.command}`);
  const timeout = c.get('timeout', 0);
  let buf = '';
  const handle = run({
    command: plan.command, cwd: plan.cwd, env: c.get('env'), stdin: plan.stdin, timeoutMs: timeout * 1000,
    onData: d => { buf += d; out.append(d); }
  });
  handle.label = plan.label;
  setRunning(handle);
  const r = await handle.done;
  if (running === handle) setRunning(null);
  if (plan.tmpDir) fs.rm(plan.tmpDir, { recursive: true, force: true }, () => {});

  const ok = r.code === 0 && !r.timedOut;
  if (r.error) out.appendLine('\n✖ ' + r.error.message);
  if (msg) {
    if (!buf.endsWith('\n') && buf) out.appendLine('');
    if (r.timedOut) out.appendLine(`⏱ [Timeout] killed after ${timeout}s`);
    else if (r.killed) out.appendLine(`■ [Stopped] after ${secs(r.durationMs)}s`);
    else out.appendLine(`${ok ? '✔' : '✖'} [Done] exit code ${r.code} in ${secs(r.durationMs)}s`);
  }
  if (!r.killed || r.timedOut) lastResult = { ok, code: r.timedOut ? 'timeout' : r.code, ms: r.durationMs };
  updateStatus();
  addHistory(plan, { code: r.code, ms: r.durationMs, ok, tail: buf.slice(-4000) });

  if (c.get('diagnostics') && !ok && !r.killed) {
    const items = parseDiagnostics(buf, plan.cwd);
    const byFile = new Map();
    for (const d of items) {
      const sev = d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
      const range = new vscode.Range(d.line - 1, d.col - 1, d.line - 1, 1000);
      const dg = new vscode.Diagnostic(range, d.message, sev); dg.source = 'Ignite';
      if (!byFile.has(d.file)) byFile.set(d.file, []);
      byFile.get(d.file).push(dg);
    }
    for (const [f, list] of byFile) diag.set(vscode.Uri.file(f), list);
  }
}

function addHistory(plan, r) {
  history.unshift({ plan: Object.assign({}, plan, { tmpDir: null }), time: new Date(), code: r.code, ms: r.ms, ok: r.ok, tail: r.tail || '' });
  const max = cfg().get('historySize', 25);
  if (history.length > max) history.length = max;
}

async function perform(req) {
  const plan = await prepare(req);
  if (plan) await launch(plan);
}

async function runCommand(uri, extra) {
  const editor = vscode.window.activeTextEditor;
  const req = Object.assign({}, extra);
  if (uri && uri.fsPath && !(editor && editor.document.uri.toString() === uri.toString())) req.uri = uri;
  if (!req.uri && req.mode !== 'custom' && editor && req.snippetText === undefined) {
    const c0 = cfg(editor.document.uri);
    if (!editor.selection.isEmpty && !c0.get('ignoreSelection')) { req.snippetText = editor.document.getText(editor.selection); req.snippetLang = editor.document.languageId; }
  }
  lastRequest = req;
  await perform(req);
}

function stop() {
  if (running) running.kill();
  if (term) { try { term.dispose(); } catch (_) {} term = null; }
}

class LensProvider {
  constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeCodeLenses = this._e.event; }
  provideCodeLenses(doc) {
    const c = cfg(doc.uri);
    if (!c.get('codeLens') || doc.uri.scheme !== 'file') return [];
    const r = X.resolveExecutor({ languageId: doc.languageId, fileName: doc.fileName, text: '', userMap: c.get('executorMap'), skipGlob: true });
    if (!r || !r.lang) return [];
    const m = X.MAIN_RE.exec(doc.getText());
    const line = m ? doc.positionAt(m.index).line : 0;
    const range = new vscode.Range(line, 0, line, 0);
    return [
      new vscode.CodeLens(range, { title: '$(play) Run', command: 'ignite.run', arguments: [doc.uri] }),
      new vscode.CodeLens(range, { title: '$(terminal) Args', command: 'ignite.runWithArgs', arguments: [doc.uri] }),
      new vscode.CodeLens(range, { title: '$(eye) Watch', command: 'ignite.toggleWatch', arguments: [doc.uri] })
    ];
  }
}

async function doctor() {
  const rows = [];
  for (const [lang, v] of Object.entries(X.DEFAULT_EXECUTORS)) {
    const cands = X.asList(v);
    let found = null, tok = null;
    for (const cd of cands) { tok = X.detectToken(cd); const p = tok && X.which(tok); if (p) { found = p; break; } }
    rows.push(`| ${found ? '✅' : '❌'} | ${lang} | ${found ? '`' + tok + '`' : '`' + (X.detectToken(cands[0]) || '') + '` missing'} | ${found ? found : (X.HINTS[X.detectToken(cands[0])] || '')} |`);
  }
  rows.sort((a, b) => (a.startsWith('| ✅') ? 0 : 1) - (b.startsWith('| ✅') ? 0 : 1));
  const ok = rows.filter(r => r.startsWith('| ✅')).length;
  const md = `# ⚡ Ignite Runner — Environment Doctor\n\n**${ok} / ${rows.length}** languages are ready to run.\n\n| | Language | Runtime | Path / Install |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  const d = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  await vscode.window.showTextDocument(d, { preview: true });
}

async function showHistory() {
  if (!history.length) return vscode.window.showInformationMessage('Ignite: no runs yet.');
  const pick = await vscode.window.showQuickPick(history.map((h, i) => ({
    label: `${h.ok === undefined ? '$(terminal)' : h.ok ? '$(check)' : '$(error)'} ${h.plan.label}`,
    description: h.plan.command, detail: `${h.time.toLocaleTimeString()} · ${h.code === null ? 'terminal' : 'exit ' + h.code} · ${h.ms < 1000 ? Math.round(h.ms) + 'ms' : secs(h.ms) + 's'}`, i
  })), { placeHolder: 'Pick a run to re-run' });
  if (pick) await launch(history[pick.i].plan);
}

function activate(context) {
  out = vscode.window.createOutputChannel('Ignite Runner');
  diag = vscode.languages.createDiagnosticCollection('ignite');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  updateStatus();
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('ignite.run', uri => runCommand(uri));
  reg('ignite.stop', stop);
  reg('ignite.rerun', async () => { if (!lastRequest) return runCommand(); await perform(lastRequest); });
  reg('ignite.runWithArgs', async uri => {
    const ed = vscode.window.activeTextEditor;
    const key = (uri && uri.fsPath) || (ed && ed.document.fileName) || '';
    const v = await vscode.window.showInputBox({ title: 'Ignite — arguments', prompt: 'Command-line arguments', value: lastArgs.get(key) || '', ignoreFocusOut: true });
    if (v === undefined) return;
    lastArgs.set(key, v);
    await runCommand(uri, { args: v });
  });
  reg('ignite.runWithInput', uri => runCommand(uri, { forceInput: true }));
  reg('ignite.runByLanguage', async uri => {
    const langs = Object.keys(Object.assign({}, X.DEFAULT_EXECUTORS, cfg().get('executorMap')));
    const pick = await vscode.window.showQuickPick(langs.sort(), { placeHolder: 'Run as which language?' });
    if (pick) await runCommand(uri, { languageOverride: pick });
  });
  reg('ignite.runCustomCommand', () => runCommand(undefined, { mode: 'custom' }));
  reg('ignite.toggleWatch', async uri => {
    if (watch) { watch = null; updateStatus(); vscode.window.setStatusBarMessage('$(eye-closed) Ignite watch mode OFF', 2500); return; }
    const ed = vscode.window.activeTextEditor;
    const f = (uri && uri.fsPath) || (ed && ed.document.fileName);
    if (!f) return;
    watch = { fsPath: f };
    updateStatus();
    vscode.window.setStatusBarMessage('$(eye) Ignite watch mode ON — re-runs on save', 3000);
    await runCommand(uri);
  });
  reg('ignite.history', showHistory);
  reg('ignite.doctor', doctor);
  reg('ignite.showOutput', () => out.show());
  reg('ignite.clearOutput', () => out.clear());

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (!watch || doc.fileName !== watch.fsPath) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => lastRequest && perform(lastRequest), 150);
    }),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new LensProvider()),
    out, diag, statusItem
  );
}

function deactivate() { stop(); }

module.exports = { activate, deactivate };
