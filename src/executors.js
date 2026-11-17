'use strict';
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const CR = c => `cd $dir && ${c} && $dir$fileNameWithoutExt`;

/** language id -> command | [candidates tried in order; first installed wins] */
const DEFAULT_EXECUTORS = {
  javascript: ['node', 'bun run', 'deno run -A'],
  typescript: ['tsx', 'ts-node', 'bun run', 'deno run -A', 'npx --yes tsx'],
  python: isWin ? ['python -u', 'py -u', 'python3 -u'] : ['python3 -u', 'python -u'],
  java: 'cd $dir && javac $fileName && java $fileNameWithoutExt',
  c: [CR('gcc $fileName -o $fileNameWithoutExt'), CR('clang $fileName -o $fileNameWithoutExt')],
  cpp: [CR('g++ $fileName -o $fileNameWithoutExt'), CR('clang++ $fileName -o $fileNameWithoutExt')],
  'cuda-cpp': CR('nvcc $fileName -o $fileNameWithoutExt'),
  'objective-c': CR('gcc -framework Cocoa $fileName -o $fileNameWithoutExt'),
  csharp: ['dotnet-script', 'scriptcs'],
  go: 'go run',
  rust: CR('rustc $fileName'),
  zig: 'zig run',
  php: 'php',
  perl: 'perl',
  perl6: ['raku', 'perl6'],
  ruby: 'ruby',
  lua: 'lua',
  groovy: 'groovy',
  powershell: ['pwsh -ExecutionPolicy ByPass -File', 'powershell -ExecutionPolicy ByPass -File'],
  bat: 'cmd /c',
  shellscript: ['bash', 'sh'],
  fsharp: 'dotnet fsi',
  vbscript: 'cscript //Nologo',
  coffeescript: 'coffee',
  scala: 'scala',
  swift: 'swift',
  julia: 'julia',
  crystal: 'crystal',
  ocaml: 'ocaml',
  r: 'Rscript',
  applescript: 'osascript',
  elixir: 'elixir',
  erlang: 'escript',
  clojure: 'lein exec',
  haxe: 'haxe --cwd $dirWithoutTrailingSlash --run $fileNameWithoutExt',
  racket: 'racket',
  scheme: 'csi -script',
  ahk: 'autohotkey',
  autoit: 'autoit3',
  kotlin: 'cd $dir && kotlinc $fileName -include-runtime -d $fileNameWithoutExt.jar && java -jar $dir$fileNameWithoutExt.jar',
  dart: 'dart',
  pascal: CR('fpc $fileName'),
  d: CR('dmd $fileName'),
  haskell: 'runghc',
  nim: 'nim compile --verbosity:0 --hints:off --run',
  lisp: 'sbcl --script',
  kit: 'kitc --run',
  v: 'v run',
  sass: 'sass --style expanded',
  scss: 'scss --style expanded',
  less: 'cd $dir && lessc $fileName $fileNameWithoutExt.css',
  fortran: CR('gfortran $fileName -o $fileNameWithoutExt'),
  sml: 'cd $dir && sml $fileName',
  mojo: 'mojo run',
  spwn: 'spwn build',
  pkl: 'cd $dir && pkl eval -f yaml $fileName',
  gleam: 'gleam run -m $fileNameWithoutExt',
  ring: 'ring',
  tcl: 'tclsh',
  awk: 'awk -f',
  prolog: 'swipl -q -f',
  odin: 'odin run',
  fish: 'fish',
  nushell: 'nu',
  makefile: 'make -f',
  vb: CR('vbc /nologo $fileName')
};
if (!isMac) delete DEFAULT_EXECUTORS['objective-c'];

const DEFAULT_GLOB = { 'pom.xml': 'cd $dir && mvn clean package' };
const DEFAULT_EXT_EXEC = {
  '.csproj': 'dotnet run --project',
  '.fsproj': 'dotnet run --project',
  '.kts': 'kotlinc -script',
  '.vb': CR('vbc /nologo $fileName'),
  '.vsh': 'v run'
};

const LANG_EXT = {
  javascript: 'js', typescript: 'ts', python: 'py', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', rust: 'rs',
  php: 'php', ruby: 'rb', perl: 'pl', perl6: 'raku', lua: 'lua', shellscript: 'sh', powershell: 'ps1', bat: 'bat',
  swift: 'swift', kotlin: 'kt', dart: 'dart', r: 'r', julia: 'jl', groovy: 'groovy', fsharp: 'fsx', vbscript: 'vbs',
  coffeescript: 'coffee', scala: 'scala', crystal: 'cr', ocaml: 'ml', applescript: 'scpt', clojure: 'clj', haxe: 'hx',
  'objective-c': 'm', racket: 'rkt', scheme: 'scm', ahk: 'ahk', autoit: 'au3', pascal: 'pas', d: 'd', haskell: 'hs',
  nim: 'nim', lisp: 'lisp', kit: 'kit', v: 'v', sass: 'sass', scss: 'scss', less: 'less', fortran: 'f90', sml: 'sml',
  mojo: 'mojo', erlang: 'erl', elixir: 'exs', spwn: 'spwn', pkl: 'pkl', gleam: 'gleam', zig: 'zig', ring: 'ring', 'cuda-cpp': 'cu', tcl: 'tcl', awk: 'awk', prolog: 'pl2', odin: 'odin', fish: 'fish', nushell: 'nu'
};
const EXT_TO_LANG = {};
for (const [l, e] of Object.entries(LANG_EXT)) EXT_TO_LANG['.' + e] = l;
Object.assign(EXT_TO_LANG, {
  '.mjs': 'javascript', '.cjs': 'javascript', '.tsx': 'typescript', '.jsx': 'javascript', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'c',
  '.pm': 'perl', '.bash': 'shellscript', '.zsh': 'shellscript', '.cmd': 'bat', '.pp': 'pascal', '.f': 'fortran', '.f95': 'fortran',
  '.f03': 'fortran', '.for': 'fortran', '.exs': 'elixir', '.ex': 'elixir', '.hsc': 'haskell', '.kit': 'kit', '.🔥': 'mojo'
});
const LANG_ALIASES = {
  FortranFreeForm: 'fortran', 'fortran-modern': 'fortran', 'fortran_fixed-form': 'fortran', sh: 'shellscript', zsh: 'shellscript',
  bash: 'shellscript', javascriptreact: 'javascript', typescriptreact: 'typescript', autohotkey: 'ahk', raku: 'perl6', cs: 'csharp', csx: 'csharp'
};

const HINTS = {
  node: 'https://nodejs.org', python: 'https://www.python.org/downloads', python3: 'https://www.python.org/downloads', py: 'https://www.python.org/downloads',
  javac: 'https://adoptium.net', java: 'https://adoptium.net', gcc: 'https://gcc.gnu.org (Windows: https://winlibs.com)', 'g++': 'https://gcc.gnu.org (Windows: https://winlibs.com)',
  clang: 'https://clang.llvm.org', go: 'https://go.dev/dl', rustc: 'https://rustup.rs', php: 'https://www.php.net/downloads', ruby: 'https://www.ruby-lang.org',
  dotnet: 'https://dotnet.microsoft.com/download', swift: 'https://www.swift.org/install', kotlinc: 'https://kotlinlang.org/docs/command-line.html',
  dart: 'https://dart.dev/get-dart', Rscript: 'https://cran.r-project.org', julia: 'https://julialang.org/downloads', lua: 'https://www.lua.org',
  perl: 'https://www.perl.org', bun: 'https://bun.sh', deno: 'https://deno.com', tsx: 'npm install -g tsx', 'ts-node': 'npm install -g ts-node typescript',
  zig: 'https://ziglang.org/download', elixir: 'https://elixir-lang.org/install.html', ghc: 'https://www.haskell.org/ghcup', runghc: 'https://www.haskell.org/ghcup'
};

function globToRegex(g) {
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { r += '.*'; i++; if (g[i + 1] === '/') i++; } else r += '[^/]*'; }
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + r + '$', 'i');
}

const asList = v => (Array.isArray(v) ? v : v ? [v] : []);

/** Find an executable on PATH (no caching: installs are picked up immediately). */
function which(cmd) {
  if (/[\\/]/.test(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').concat(['']) : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, cmd + e);
    try { const st = fs.statSync(p); if (st.isFile() && (isWin || (st.mode & 0o111))) return p; } catch (_) {}
  }
  return null;
}

/** The program a command needs (skips `cd x &&`). */
function detectToken(cmd) {
  const segs = cmd.split('&&').map(s => s.trim()).filter(Boolean);
  const seg = segs.find(s => !/^cd(\s|$)/i.test(s)) || segs[0] || '';
  let tok = (seg.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '');
  return !tok || tok.startsWith('$') ? null : tok;
}

function pickCandidate(cands) {
  for (const c of cands) { const t = detectToken(c); if (!t || which(t)) return { command: c, missing: null }; }
  return { command: cands[0], missing: detectToken(cands[0]) };
}

function normLang(id) { return LANG_ALIASES[id] || id; }
function extFor(langId, userMap) {
  const e = (userMap && userMap[langId]) || LANG_EXT[normLang(langId)] || 'txt';
  return e.startsWith('.') ? e : '.' + e;
}

/**
 * Resolve how to run a file.
 * o: { languageId, fileName, relPath, text, userMap, userExt, userGlob, defaultLanguage, respectShebang, skipGlob }
 * -> { candidates:[], source, lang } | null
 */
function resolveExecutor(o) {
  const ext = path.extname(o.fileName || '').toLowerCase();
  const base = path.basename(o.fileName || '');
  if (!o.skipGlob) {
    const globs = Object.assign({}, DEFAULT_GLOB, o.userGlob || {});
    for (const [g, cmd] of Object.entries(globs)) {
      const re = globToRegex(g);
      if (re.test(base) || (o.relPath && re.test(o.relPath.split(path.sep).join('/')))) return { candidates: asList(cmd), source: 'glob:' + g };
    }
    if (o.respectShebang && o.text && o.text.startsWith('#!')) {
      const sb = o.text.split(/\r?\n/)[0].slice(2).trim();
      if (sb) return { candidates: [sb], source: 'shebang' };
    }
  }
  const user = o.userMap || {};
  const lid = o.languageId;
  const nid = normLang(lid);
  const direct = user[lid] || user[nid] || DEFAULT_EXECUTORS[lid] || DEFAULT_EXECUTORS[nid];
  if (direct) return { candidates: asList(direct), source: 'language', lang: nid };
  const ue = (o.userExt || {})[ext] || DEFAULT_EXT_EXEC[ext];
  if (ue) return { candidates: asList(ue), source: 'extension' };
  const el = EXT_TO_LANG[ext];
  if (el && (user[el] || DEFAULT_EXECUTORS[el])) return { candidates: asList(user[el] || DEFAULT_EXECUTORS[el]), source: 'extension', lang: el };
  if (o.defaultLanguage) {
    const d = user[o.defaultLanguage] || DEFAULT_EXECUTORS[normLang(o.defaultLanguage)];
    if (d) return { candidates: asList(d), source: 'default' };
  }
  return null;
}

function quote(s) {
  if (!/[\s&|;<>()$`'"!*?\[\]{}~#^%]/.test(s)) return s;
  return isWin ? `"${s}"` : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function buildVars(file, workspaceRoot, pythonPath) {
  const dir = file ? path.dirname(file) : workspaceRoot || process.cwd();
  const name = file ? path.basename(file) : '';
  return {
    workspaceRoot: workspaceRoot || dir,
    dir: dir.endsWith(path.sep) ? dir : dir + path.sep,
    dirWithoutTrailingSlash: dir,
    fullFileName: file || '',
    fileName: name,
    fileNameWithoutExt: file ? path.basename(file, path.extname(file)) : '',
    driveLetter: isWin && file ? path.parse(file).root.slice(0, 2) : '',
    pythonPath: pythonPath || (isWin ? 'python' : 'python3')
  };
}

function substitute(cmd, v, { appendFile = true, quoteValues = true } = {}) {
  const q = quoteValues ? quote : x => x;
  let out = cmd;
  if (v.fullFileName) out = out.split('$dir$fileNameWithoutExt').join(q(v.dir + v.fileNameWithoutExt));
  const hasFileVar = /\$(fullFileName|fileName|fileNameWithoutExt)\b/.test(cmd);
  out = out.replace(/\$(workspaceRoot|dirWithoutTrailingSlash|dir|fullFileName|fileNameWithoutExt|fileName|driveLetter|pythonPath)\b/g, (_, n) => q(v[n]));
  if (isWin) out = out.replace(/(^|&&\s*)cd\s+(?!\/d\b)/gi, '$1cd /d ');
  if (appendFile && !hasFileVar && v.fullFileName) out += ' ' + q(v.fullFileName);
  return out;
}

const MAIN_RE = /(^\s*if\s+__name__\s*==)|(\bpublic\s+static\s+void\s+main\b)|(^\s*func\s+main\s*\()|(\b(?:int|void)\s+main\s*\()|(^\s*fn\s+main\s*\()|(\bstatic\s+(?:async\s+)?(?:void|Task|int)\s+Main\s*\()|(^\s*fun\s+main\s*\()/m;
const INPUT_RE = /\b(input\s*\(|raw_input|scanf|fscanf|fgets|getchar|gets\s*\(|cin\s*>>|getline|Scanner\s*\(|System\.in|readLine|readline|stdin|ReadLine|read_line|Console\.Read|bufio\.NewReader|fmt\.Scan|gets\.chomp|STDIN|\$stdin|readln|io\.read|<STDIN>)/;

module.exports = {
  DEFAULT_EXECUTORS, DEFAULT_GLOB, DEFAULT_EXT_EXEC, LANG_EXT, EXT_TO_LANG, HINTS, MAIN_RE, INPUT_RE,
  which, detectToken, pickCandidate, resolveExecutor, buildVars, substitute, quote, extFor, normLang, globToRegex, asList
};
