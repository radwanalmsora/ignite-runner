'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const X = require('../src/executors');
const { run } = require('../src/runner');
const { parseDiagnostics } = require('../src/diagnostics');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ignite-test-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- executors
  const r1 = X.resolveExecutor({ languageId: 'python', fileName: '/x/a.py', text: '' });
  assert(r1 && r1.candidates[0].includes('python'));
  assert(X.resolveExecutor({ languageId: 'plaintext', fileName: '/x/a.rs', text: '' }).candidates[0].includes('rustc'), 'ext fallback');
  assert.strictEqual(X.resolveExecutor({ languageId: 'python', fileName: '/x/a', text: '#!/usr/bin/env ruby\n', respectShebang: true }).source, 'shebang');
  assert.strictEqual(X.resolveExecutor({ languageId: 'x', fileName: '/x/pom.xml', text: '' }).source, 'glob:pom.xml');
  assert.strictEqual(X.resolveExecutor({ languageId: 'zzz', fileName: '/x/a.zzz', text: '' }), null);
  const v = X.buildVars('/my dir/Main.java', '/my dir');
  const cmd = X.substitute('cd $dir && javac $fileName && java $fileNameWithoutExt', v);
  if (process.platform !== 'win32') assert.strictEqual(cmd, 'cd "/my dir/" && javac Main.java && java Main');
  assert(X.substitute('node', v).endsWith('"/my dir/Main.java"'), 'file appended + quoted');
  assert(X.substitute('cd $dir && gcc $fileName -o $fileNameWithoutExt && $dir$fileNameWithoutExt', X.buildVars('/a/b.c', '/a')).includes('/a/b'));
  assert(X.which('node'), 'node on PATH');
  assert.strictEqual(X.detectToken('cd $dir && gcc $fileName'), 'gcc');
  assert.strictEqual(X.pickCandidate(['definitely-missing-xyz', 'node']).command, 'node');
  assert(X.pickCandidate(['definitely-missing-xyz']).missing === 'definitely-missing-xyz');
  assert(Object.keys(X.DEFAULT_EXECUTORS).length >= 65);

  // ---- runner: output, stdin, timeout, exit code
  let o = '';
  let r = await run({ command: 'node -e "console.log(1+1)"', cwd: tmp, onData: d => (o += d) }).done;
  assert.strictEqual(o.trim(), '2'); assert.strictEqual(r.code, 0);
  o = '';
  r = await run({ command: 'node -e "process.stdin.on(\'data\',d=>console.log(\'got:\'+d.toString().trim()))"', cwd: tmp, stdin: 'hello\n', onData: d => (o += d) }).done;
  assert(o.includes('got:hello'));
  r = await run({ command: 'node -e "setInterval(()=>{},1000)"', cwd: tmp, timeoutMs: 300 }).done;
  assert(r.timedOut, 'timeout kills infinite loop');
  r = await run({ command: 'node -e "process.exit(3)"', cwd: tmp }).done; assert.strictEqual(r.code, 3);

  // ---- diagnostics
  fs.writeFileSync(path.join(tmp, 'a.c'), 'int main(){}\n');
  let d = parseDiagnostics('a.c:3:5: error: expected ; before }\n', tmp);
  assert.strictEqual(d.length, 1); assert.strictEqual(d[0].line, 3); assert.strictEqual(d[0].severity, 'error');
  fs.writeFileSync(path.join(tmp, 'p.py'), 'x\n');
  d = parseDiagnostics(`Traceback (most recent call last):\n  File "${path.join(tmp, 'p.py')}", line 1, in <module>\nNameError: name 'x' is not defined\n`, tmp);
  assert.strictEqual(d.length, 1); assert(d[0].message.startsWith('NameError'));
  fs.writeFileSync(path.join(tmp, 'e.js'), 'x\n');
  d = parseDiagnostics(`${path.join(tmp, 'e.js')}:1\nx\n^\n\nReferenceError: x is not defined\n    at Object.<anonymous> (${path.join(tmp, 'e.js')}:1:1)\n`, tmp);
  assert(d.length >= 1 && d[0].message.startsWith('ReferenceError'));

  // ---- extension integration with a vscode mock
  const pkg = require('../package.json').contributes.configuration.properties;
  const cmds = {}, outLines = [], warnings = [];
  let active = null;
  const settings = k => (pkg['ignite.' + k] ? pkg['ignite.' + k].default : undefined);
  const vsMock = {
    window: {
      createOutputChannel: () => ({ append: s => outLines.push(s), appendLine: s => outLines.push(s + '\n'), clear: () => (outLines.length = 0), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      get activeTextEditor() { return active; },
      showWarningMessage: async m => { warnings.push(m); }, showErrorMessage: async m => { warnings.push(m); },
      showInputBox: async () => '', setStatusBarMessage() {}, createTerminal: () => ({ show() {}, sendText() {}, dispose() {} })
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => { const v = settings(k); return v === undefined ? d : v; } }),
      getWorkspaceFolder: () => ({ uri: { fsPath: tmp } }), workspaceFolders: [{ uri: { fsPath: tmp } }],
      openTextDocument: async u => mkDoc(u.fsPath), saveAll: async () => {}, onDidSaveTextDocument: () => ({ dispose() {} })
    },
    commands: { registerCommand: (id, fn) => { cmds[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
    languages: { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }), registerCodeLensProvider: () => ({ dispose() {} }) },
    StatusBarAlignment: { Left: 1 }, ThemeColor: class {}, EventEmitter: class { constructor() { this.event = () => {}; } },
    Range: class {}, Diagnostic: class {}, DiagnosticSeverity: { Error: 0, Warning: 1 }, Uri: { file: f => ({ fsPath: f }), parse: s => s }, CodeLens: class {},
    env: { openExternal() {} }
  };
  const mkDoc = (fsPath, text) => ({
    fileName: fsPath, languageId: fsPath.endsWith('.py') ? 'python' : 'javascript', isDirty: false, isUntitled: false,
    uri: { fsPath, scheme: 'file', toString: () => 'file://' + fsPath }, getText: () => text !== undefined ? text : fs.readFileSync(fsPath, 'utf8')
  });
  const origLoad = Module._load;
  Module._load = function (req, ...a) { return req === 'vscode' ? vsMock : origLoad.call(this, req, ...a); };
  const ext = require('../extension.js');
  ext.activate({ subscriptions: [] });
  assert(Object.keys(cmds).length >= 12, 'commands registered');

  fs.writeFileSync(path.join(tmp, 'hello.js'), 'console.log("hello from ignite")\n');
  active = { document: mkDoc(path.join(tmp, 'hello.js')), selection: { isEmpty: true } };
  await cmds['ignite.run']();
  const text = outLines.join('');
  assert(text.includes('hello from ignite'), 'output captured: ' + text);
  assert(text.includes('[Done] exit code 0'));

  // selection snippet
  active = { document: mkDoc(path.join(tmp, 'hello.js'), 'console.log(40+2)'), selection: { isEmpty: false } };
  active.document.getText = r => (r ? 'console.log(40+2)' : 'x');
  await cmds['ignite.run']();
  assert(outLines.join('').includes('42'), 'snippet run');

  // failing run reports exit code
  fs.writeFileSync(path.join(tmp, 'bad.js'), 'process.exit(5)\n');
  active = { document: mkDoc(path.join(tmp, 'bad.js')), selection: { isEmpty: true } };
  await cmds['ignite.run']();
  assert(outLines.join('').includes('exit code 5'));
  await cmds['ignite.rerun']();
  assert(outLines.join('').includes('exit code 5'), 'rerun');
  Module._load = origLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✔ all Ignite Runner tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
