'use strict';
const fs = require('fs');
const path = require('path');

/** Turn compiler / runtime error output into [{file,line,col,severity,message}] (max 50). */
function parseDiagnostics(text, cwd) {
  const res = [], seen = new Set();
  const push = (file, line, col, severity, message) => {
    if (!file) return;
    const f = path.isAbsolute(file) ? file : path.resolve(cwd || process.cwd(), file);
    if (/node_modules|node:internal/.test(f)) return;
    try { if (!fs.statSync(f).isFile()) return; } catch (_) { return; }
    const k = `${f}:${line}:${message}`;
    if (seen.has(k) || res.length >= 50) return;
    seen.add(k);
    res.push({ file: f, line: Math.max(1, +line), col: col ? Math.max(1, +col) : 1, severity, message: (message || 'Error').trim() });
  };
  const lines = text.split(/\r?\n/);
  const gcc = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning)\s*[:\s]\s*(.+)$/;
  const goErr = /^((?:\.{1,2}\/)?[^:\s]+\.go):(\d+):(\d+):\s*(.+)$/;
  const rustAt = /^\s*-->\s*(.+?):(\d+):(\d+)/;
  const rustMsg = /^(error|warning)(?:\[\w+\])?:\s*(.+)$/;
  const nodeLoc = /^((?:[A-Za-z]:)?[^:\n]+\.(?:m?js|cjs|ts)):(\d+)$/;
  const frame = /^\s+at .*?\(?((?:[A-Za-z]:)?[^():\n]+):(\d+):(\d+)\)?\s*$/;
  let pyFrame = null, nodeAt = null, firstFrame = null, errMsg = null, rustLast = null;
  for (const l of lines) {
    let m;
    if ((m = /^\s*File "(.+?)", line (\d+)/.exec(l))) { pyFrame = { file: m[1], line: m[2] }; continue; }
    if ((m = gcc.exec(l))) { push(m[1], m[2], m[3], /warning/.test(m[4]) ? 'warning' : 'error', m[5]); continue; }
    if ((m = rustMsg.exec(l))) { rustLast = { sev: m[1], msg: m[2] }; continue; }
    if ((m = rustAt.exec(l)) && rustLast) { push(m[1], m[2], m[3], rustLast.sev, rustLast.msg); continue; }
    if ((m = goErr.exec(l))) { push(m[1], m[2], m[3], 'error', m[4]); continue; }
    if ((m = nodeLoc.exec(l)) && !nodeAt) { nodeAt = { file: m[1], line: m[2] }; continue; }
    if ((m = frame.exec(l)) && !firstFrame && !/node_modules|node:internal/.test(l)) { firstFrame = { file: m[1], line: m[2], col: m[3] }; continue; }
    if (!errMsg && (m = /^(\w*(?:Error|Exception)\b.*)$/.exec(l.trim()))) errMsg = m[1];
  }
  if (pyFrame) {
    const last = lines.map(s => s.trim()).filter(Boolean).pop() || 'Error';
    push(pyFrame.file, pyFrame.line, 1, 'error', last);
  }
  if (errMsg) {
    const loc = nodeAt || firstFrame;
    if (loc) push(loc.file, loc.line, loc.col, 'error', errMsg);
  }
  return res;
}

module.exports = { parseDiagnostics };
