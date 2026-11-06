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

type Spot = { project: string; file?: string; line?: number; column?: number }

// `path`, `path:line` or `path:line:col`; a drive colon (C:\x.py:12) stays in the path.
function parseSpec(spec: string): { path: string; line?: number; column?: number } {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(spec) ?? []
  const [, path = spec, a, b] = m
  if (a !== undefined && b !== undefined) return { path, line: Number(a), column: Number(b) }

  return a !== undefined ? { path, line: Number(a) } : { path }
}

async function isFile(run: Run, os: Os, path: string): Promise<boolean> {
  try {
    const { exitCode } =
      os === 'windows'
        ? await run(powershell(`if (Test-Path -LiteralPath ${ps(path)} -PathType Leaf) { exit 0 } else { exit 1 }`))
        : await run(['test', '-f', path])

    return exitCode === 0
  } catch {
    return false
  }
}

const isAbsolute = (os: Os, path: string): boolean =>
  os === 'windows' ? /^([A-Za-z]:[\\/]|\\\\)/.test(path) : path.startsWith('/')

// Turns what the person typed into a project folder, plus a file and line when it names a file.
async function resolveSpot($: EngineInterface, run: Run, os: Os, spec: string): Promise<Spot> {
  const cwd = await $.session.cwd()
  if (!spec) return { project: cwd }
  const { path, line, column } = parseSpec(spec)
  let full = path
  if (full.startsWith('~/')) full = `${(await $.env.get('HOME')) ?? ''}${full.slice(1)}`
  if (!isAbsolute(os, full)) full = `${cwd}${os === 'windows' ? '\\' : '/'}${full}`
  if (await isFile(run, os, full)) return { project: cwd, file: full, line, column }

  return { project: full }
}

// Starts the IDE without waiting for it.
async function launch(run: Run, os: Os, bin: string, spot: Spot): Promise<boolean> {
  const where: string[] = []
  if (spot.file) {
    if (spot.line !== undefined) where.push('--line', String(spot.line))
    if (spot.line !== undefined && spot.column !== undefined) where.push('--column', String(spot.column))
    where.push(spot.file)
  }
  try {
    if (os === 'windows') {
      const q = '[char]34'
      const args = [spot.project, ...where].map(a => (/^(--|\d+$)/.test(a) && a !== spot.project ? ps(a) : `${q} + ${ps(a)} + ${q}`))
      const { exitCode } = await run(
        powershell(`Start-Process -FilePath ${ps(bin)} -ArgumentList ((${args.join(") + ' ' + (")}))`),
      )

      return exitCode === 0
    }
    const { exitCode } = await run([
      'sh',
      '-c',
      'bin="$1"; shift; case "$bin" in *.app) if [ "$#" -eq 1 ]; then open -a "$bin" "$1"; exit; fi; bin="$bin/Contents/MacOS/pycharm";; esac; nohup "$bin" "$@" >/dev/null 2>&1 </dev/null &',
      'sh',
      bin,
      spot.project,
      ...where,
    ])

    return exitCode === 0
  } catch {
    return false
  }
}

const describe = (spot: Spot): string =>
  spot.file ? `${spot.file}${spot.line !== undefined ? `:${spot.line}` : ''}` : spot.project

const notFoundBrief = (spot: Spot): string =>
  [
    `The person ran /pycharm to open ${describe(spot)} in PyCharm, but no PyCharm launcher was found on PATH or in the usual install locations.`,
    'Find the PyCharm launcher on this machine yourself first:',
    '- Linux/macOS: search with find/mdfind/ls for `pycharm`, `pycharm.sh`, `charm`, or `PyCharm*.app` (JetBrains Toolbox, /opt, /snap/bin, /Applications, ~/Applications).',
    '- Windows: search with PowerShell Get-ChildItem for `pycharm64.exe` or `pycharm.cmd` (Program Files, %LOCALAPPDATA%\\Programs, JetBrains Toolbox).',
    `When you find it, call the ${TOOL} tool with { "path": "<launcher>", "target": ${JSON.stringify(spot.project)}${spot.file ? `, "file": ${JSON.stringify(spot.file)}` : ''}${spot.line !== undefined ? `, "line": ${spot.line}` : ''} }; it opens the project and saves the path for next time.`,
    `If you cannot find it, ask the person in chat for the full path to PyCharm's launcher, then call ${TOOL} with the path they give.`,
    'Do not launch PyCharm any other way.',
  ].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pycharm',
      description: 'Open the project (or a given path) in PyCharm',
      argumentHint: '[path[:line[:col]] | --reset]',
    })
    await $.tool.register({
      name: 'pycharm_open',
      description:
        'Open a folder in PyCharm. Pass `path` (the PyCharm launcher found on this machine) to save it for later /pycharm runs.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Full path to the PyCharm launcher (pycharm, pycharm.sh, pycharm64.exe, pycharm.cmd or PyCharm.app).' },
          target: { type: 'string', description: 'Project folder to open; default is the session directory.' },
          file: { type: 'string', description: 'Absolute path of a file to open inside the project.' },
          line: { type: 'number', description: 'Line to jump to in `file`.' },
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

    const os = await detectOs($)
    const spot = await resolveSpot($, run, os, arg)
    const saved = await $.store.get(STORE_KEY)
    let bin: string | undefined
    if (typeof saved === 'string' && (await exists(run, os, saved))) bin = saved
    bin ??= await findPyCharm(run, os)

    if (!bin) {
      void $.prompt.submit({ text: notFoundBrief(spot) })

      return { text: 'PyCharm not found automatically. Claude will look for it.' }
    }

    return {
      text: (await launch(run, os, bin, spot))
        ? `Opening ${describe(spot)} in PyCharm (${bin}).`
        : `Could not start PyCharm at ${bin}. Run /pycharm --reset to forget a saved path.`,
    }
  })

  on('tool.call', async ($, e, next) => {
    // This plugin's own tool is not in the generated type tables, so read the input loosely.
    const input = e as unknown as { tool: string; path?: unknown; target?: unknown; file?: unknown; line?: unknown }
    if (input.tool !== TOOL) return next(e)
    const run: Run = argv => $.process.run(argv)
    const os = await detectOs($)
    const spot: Spot = {
      project: typeof input.target === 'string' && input.target ? input.target : await $.session.cwd(),
      file: typeof input.file === 'string' && input.file ? input.file : undefined,
      line: typeof input.line === 'number' ? input.line : undefined,
    }
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
      result: (await launch(run, os, bin, spot))
        ? `Opened ${describe(spot)} in PyCharm (${bin}); path saved for next time.`
        : `Could not start PyCharm at ${bin}.`,
    }
  })
}
