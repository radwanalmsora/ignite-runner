'use strict';
const { spawn } = require('child_process');
const isWin = process.platform === 'win32';

/**
 * Run a shell command, streaming output.
 * Returns { kill(), done: Promise<{code, signal, timedOut, killed, durationMs, error?}> }
 */
function run({ command, cwd, env, stdin, timeoutMs, onData }) {
  const start = process.hrtime.bigint();
  const child = spawn(command, {
    cwd, shell: true, detached: !isWin, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, env || {})
  });
  let timedOut = false, killed = false, timer = null;
  const kill = () => {
    killed = true;
    if (!child.pid) return;
    try {
      if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGKILL');
    } catch (e) { try { child.kill('SIGKILL'); } catch (_) {} }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => onData && onData(d, 'stdout'));
  child.stderr.on('data', d => onData && onData(d, 'stderr'));
  child.stdin.on('error', () => {});
  if (stdin) child.stdin.write(stdin);
  child.stdin.end(); // programs that read input get EOF instead of hanging
  if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  const ms = () => Number(process.hrtime.bigint() - start) / 1e6;
  const done = new Promise(resolve => {
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, error, timedOut, killed, durationMs: ms() }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, killed, durationMs: ms() }); });
  });
  return { child, kill, done };
}

module.exports = { run };
