import type { EngineInterface, Register } from 'claude-code'

const STORE_KEY = 'pycharmPath'
const TOOL = 'mcp__open-in-pycharm__pycharm_open'

type Os = 'windows' | 'mac' | 'linux'
type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string }>

// Prints the first PyCharm launcher found on PATH or in the usual install places.
const FIND_UNIX = `
for c in pycharm pycharm.sh charm pycharm-professional pycharm-community; do
  p=$(command -v "$c") && { echo "$p"; exit 0; }
done
for p in \\
  "$HOME/.local/share/JetBrains/Toolbox/scripts/pycharm" \\
  "$HOME/Library/Application Support/JetBrains/Toolbox/scripts/pycharm" \\
  /snap/bin/pycharm-professional /snap/bin/pycharm-community /usr/local/bin/pycharm \\
  /opt/pycharm*/bin/pycharm.sh /opt/pycharm*/bin/pycharm /usr/share/pycharm*/bin/pycharm.sh \\
  "$HOME"/.local/share/JetBrains/Toolbox/apps/*/ch-*/*/bin/pycharm.sh \\
  /Applications/PyCharm*.app "$HOME"/Applications/PyCharm*.app \\
  "$HOME"/Applications/*/PyCharm*.app \\
  "$HOME"/Library/Application\\ Support/JetBrains/Toolbox/apps/*/ch-*/*/PyCharm*.app; do
  [ -e "$p" ] && { echo "$p"; exit 0; }
done
exit 1`

const FIND_WINDOWS = `
foreach ($n in 'pycharm.cmd','pycharm64.exe','pycharm.bat') {
  $c = Get-Command $n -ErrorAction SilentlyContinue
  if ($c) { $c.Source; exit 0 }
}
$globs = @(
  "$env:LOCALAPPDATA\\JetBrains\\Toolbox\\scripts\\pycharm.cmd",
  "$env:LOCALAPPDATA\\Programs\\PyCharm*\\bin\\pycharm64.exe",
  "$env:ProgramFiles\\JetBrains\\PyCharm*\\bin\\pycharm64.exe",
  "\${env:ProgramFiles(x86)}\\JetBrains\\PyCharm*\\bin\\pycharm64.exe",
  "$env:LOCALAPPDATA\\JetBrains\\Toolbox\\apps\\*\\ch-*\\*\\bin\\pycharm64.exe"
)
foreach ($g in $globs) {
  $f = Get-ChildItem -Path $g -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { $f.FullName; exit 0 }
}
exit 1`

const powershell = (script: string): string[] => [
  'powershell',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  script,
]

// Single-quoted PowerShell literal.
const ps = (text: string): string => `'${text.replace(/'/g, "''")}'`

async function detectOs($: EngineInterface): Promise<Os> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const { stdout } = await $.process.run(['uname', '-s'])

  return stdout.trim() === 'Darwin' ? 'mac' : 'linux'
}

async function exists(run: Run, os: Os, path: string): Promise<boolean> {
  try {
    const { exitCode } =
      os === 'windows'
        ? await run(powershell(`if (Test-Path -LiteralPath ${ps(path)}) { exit 0 } else { exit 1 }`))
        : await run(['test', '-e', path])

    return exitCode === 0
  } catch {
    return false
  }
}

async function findPyCharm(run: Run, os: Os): Promise<string | undefined> {
  try {
    const { exitCode, stdout } =
      os === 'windows' ? await run(powershell(FIND_WINDOWS)) : await run(['sh', '-c', FIND_UNIX])
    const first = stdout.split('\n')[0]?.trim()

    return exitCode === 0 && first ? first : undefined
  } catch {
    return undefined
  }
}

// Starts the IDE without waiting for it.
async function launch(run: Run, os: Os, bin: string, target: string): Promise<boolean> {
  try {
    if (os === 'windows') {
      const quote = '[char]34'
      const { exitCode } = await run(
        powershell(
          `Start-Process -FilePath ${ps(bin)} -ArgumentList (${quote} + ${ps(target)} + ${quote})`,
        ),
      )

      return exitCode === 0
    }
    const { exitCode } = await run([
      'sh',
      '-c',
      'case "$1" in *.app) open -a "$1" "$2" ;; *) nohup "$1" "$2" >/dev/null 2>&1 </dev/null & ;; esac',
      'sh',
      bin,
      target,
    ])

    return exitCode === 0
  } catch {
    return false
  }
}

const notFoundBrief = (target: string): string =>
  [
    `The person ran /pycharm to open ${target} in PyCharm, but no PyCharm launcher was found on PATH or in the usual install locations.`,
    'Find the PyCharm launcher on this machine yourself first:',
    '- Linux/macOS: search with find/mdfind/ls for `pycharm`, `pycharm.sh`, `charm`, or `PyCharm*.app` (JetBrains Toolbox, /opt, /snap/bin, /Applications, ~/Applications).',
    '- Windows: search with PowerShell Get-ChildItem for `pycharm64.exe` or `pycharm.cmd` (Program Files, %LOCALAPPDATA%\\Programs, JetBrains Toolbox).',
    `When you find it, call the ${TOOL} tool with { "path": "<launcher>", "target": "${target}" }; it opens the project and saves the path for next time.`,
    `If you cannot find it, ask the person in chat for the full path to PyCharm's launcher, then call ${TOOL} with the path they give.`,
    'Do not launch PyCharm any other way.',
  ].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pycharm',
      description: 'Open the project (or a given path) in PyCharm',
      argumentHint: '[path | --reset]',
    })
    await $.tool.register({
      name: 'pycharm_open',
      description:
        'Open a folder in PyCharm. Pass `path` (the PyCharm launcher found on this machine) to save it for later /pycharm runs.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Full path to the PyCharm launcher (pycharm, pycharm.sh, pycharm64.exe, pycharm.cmd or PyCharm.app).' },
          target: { type: 'string', description: 'Folder to open; default is the session directory.' },
        },
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('command.run', { command: 'pycharm' }, async ($, e) => {
    const run: Run = argv => $.process.run(argv)
    const arg = e.args.trim()

    if (arg === '--reset') {
      await $.store.delete(STORE_KEY)

      return { text: 'Saved PyCharm path cleared.' }
    }

    const target = arg || (await $.session.cwd())
    const os = await detectOs($)
    const saved = await $.store.get(STORE_KEY)
    let bin: string | undefined
    if (typeof saved === 'string' && (await exists(run, os, saved))) bin = saved
    bin ??= await findPyCharm(run, os)

    if (!bin) {
      void $.prompt.submit({ text: notFoundBrief(target) })

      return { text: 'PyCharm not found automatically. Claude will look for it.' }
    }

    return {
      text: (await launch(run, os, bin, target))
        ? `Opening ${target} in PyCharm (${bin}).`
        : `Could not start PyCharm at ${bin}. Run /pycharm --reset to forget a saved path.`,
    }
  })

  on('tool.call', async ($, e, next) => {
    // This plugin's own tool is not in the generated type tables, so read the input loosely.
    const input = e as unknown as { tool: string; path?: unknown; target?: unknown }
    if (input.tool !== TOOL) return next(e)
    const run: Run = argv => $.process.run(argv)
    const os = await detectOs($)
    const target = typeof input.target === 'string' && input.target ? input.target : await $.session.cwd()
    let bin: string | undefined

    if (typeof input.path === 'string' && input.path.trim()) {
      let given = input.path.trim()
      if (given.startsWith('~/')) given = `${(await $.env.get('HOME')) ?? ''}${given.slice(1)}`
      if (!(await exists(run, os, given))) return { deny: `No such file: ${given}` }
      await $.store.set(STORE_KEY, given)
      bin = given
    } else {
      const saved = await $.store.get(STORE_KEY)
      bin = typeof saved === 'string' ? saved : await findPyCharm(run, os)
    }
    if (!bin) return { deny: 'PyCharm launcher not found; pass its full path as `path`.' }

    return {
      result: (await launch(run, os, bin, target))
        ? `Opened ${target} in PyCharm (${bin}); path saved for next time.`
        : `Could not start PyCharm at ${bin}.`,
    }
  })
}
