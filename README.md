# ▶ Ignite Runner

**Run any code in one click.** 65+ languages, zero dependencies, and the power-user features the classic runners never had.

## Why Ignite?

| Feature | Ignite | Classic runners |
|---|:-:|:-:|
| Run file / selection / snippet / untitled | ✅ | ✅ |
| Run by language, custom command, stop | ✅ | ✅ |
| Output panel **or** integrated terminal | ✅ | ✅ |
| executorMap / ByGlob / ByFileExtension, shebang, variables | ✅ | ✅ |
| Multi-root workspaces | ✅ | ✅ |
| **Smart runtime detection** (`python3` vs `python` vs `py`, `tsx` vs `ts-node` vs `bun`...) | ✅ | ❌ |
| **Missing runtime helper** with install link | ✅ | ❌ |
| **Smart stdin** – asks for input only if your code reads it | ✅ | ❌ |
| **Timeout** – kills infinite loops | ✅ | ❌ |
| **Exit code + execution time** on every run, status bar result | ✅ | ❌ |
| **Error squiggles** from compiler/runtime output (Problems panel) | ✅ | ❌ |
| **Watch mode** – re-run on save | ✅ | ❌ |
| **Run history** + re-run | ✅ | ❌ |
| **Run with arguments** (remembered per file) | ✅ | ❌ |
| **CodeLens** above `main` – Run · Args · Watch | ✅ | ❌ |
| **Environment Doctor** – see which languages are ready | ✅ | ❌ |
| Kills the whole process tree on stop | ✅ | ⚠️ |

## Shortcuts
`Ctrl+Alt+R` run · `Ctrl+Alt+X` stop · `Ctrl+Alt+Shift+R` re-run · `Ctrl+Alt+A` run with args · `Ctrl+Alt+W` watch · `Ctrl+Alt+Shift+L` run by language (Cmd on macOS)

## Settings (`ignite.*`)
`executorMap`, `executorMapByGlob`, `executorMapByFileExtension`, `languageIdToFileExtensionMap`, `defaultLanguage`, `customCommand`, `runInTerminal`, `clearPreviousOutput`, `saveFileBeforeRun`, `saveAllFilesBeforeRun`, `preserveFocus`, `showExecutionMessage`, `ignoreSelection`, `respectShebang`, `cwd`, `fileDirectoryAsCwd`, `timeout`, `inputMode`, `env`, `codeLens`, `diagnostics`, `historySize`, and the menu toggles.

```jsonc
{
  "ignite.timeout": 10,
  "ignite.executorMap": {
    "python": "python3 -u",
    "javascript": ["bun run", "node"],       // first installed one wins
    "rust": "cd $dir && cargo run"
  }
}
```
Variables: `$workspaceRoot` `$dir` `$dirWithoutTrailingSlash` `$fullFileName` `$fileName` `$fileNameWithoutExt` `$driveLetter` `$pythonPath`

## Build the VSIX
Push to GitHub: the **Build Ignite Runner VSIX** workflow tests, packages and uploads `ignite-runner.vsix`. Push a `v*` tag for a Release. Local: `npm test && npm run package`.

## Security
Ignite executes code you choose to run. It is disabled in untrusted workspaces.

MIT
