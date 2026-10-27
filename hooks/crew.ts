import type { CrewBoardCompletion, CrewBoardEnvOwner, CrewBoardRun, CrewBoardState, CrewBoardWorker } from '../types'

export const emptyBoard = (now: number): CrewBoardState => ({ now, polledAt: now, workers: [], completions: [], pendingSteps: {} })

// Tokenize shell words without executing or expanding them.
const words = (command: string): { text: string; quoted: boolean }[] => {
  const result: { text: string; quoted: boolean }[] = []
  let text = '', quote = '', quoted = false, present = false
  const flush = () => {
    if (present) result.push({ text, quoted })
    text = ''; quoted = false; present = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\\' && quote !== "'") {
      text += command[++i] ?? ''; present = true
    } else if (quote) {
      if (c === quote) quote = ''
      else text += c
    } else if (c === '"' || c === "'") {
      quote = c; quoted = true; present = true
    } else if (c === '\n' || /[;|&<>]/.test(c)) {
      flush()
      let operator = c
      if (command[i + 1] === c) operator += command[++i]
      result.push({ text: operator, quoted: false })
    } else if (/\s/.test(c)) flush()
    else { text += c; present = true }
  }
  flush()
  return result
}

// ps etime is [[dd-]hh:]mm:ss; the board clock uses milliseconds.
export const parseEtime = (etime: string): number | undefined => {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (!match) return undefined
  const days = Number(match[1] ?? 0), hours = Number(match[2] ?? 0)
  const minutes = Number(match[3]), seconds = Number(match[4])
  if (minutes >= 60 || seconds >= 60 || (match[1] !== undefined && hours >= 24)) return undefined
  const elapsed = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
  return Number.isFinite(elapsed) ? elapsed : undefined
}

export type PsRow = { pid: number; ppid: number; elapsed: number; command: string }

export const parsePs = (output: string): PsRow[] => output.split('\n').flatMap(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
  if (!match) return []
  const pid = Number(match[1]), ppid = Number(match[2]), elapsed = parseEtime(match[3]!)
  return pid > 0 && Number.isSafeInteger(pid) && Number.isSafeInteger(ppid) && elapsed !== undefined
    ? [{ pid, ppid, elapsed, command: match[4]! }] : []
})

// ps eww appends the environment to argv. Remove the known argv before reading
// its one ownership token; prompt text and duplicate tokens cannot prove ownership.
export const parseEnvOwners = (output: string, rows: readonly PsRow[] = []): Map<number, CrewBoardEnvOwner> => {
  const commands = new Map(rows.map(row => [row.pid, row.command]))
  const owners = new Map<number, CrewBoardEnvOwner>()
  for (const line of output.split('\n')) {
    const row = /^\s*(\d+)\s+(.+)$/.exec(line)
    const pid = Number(row?.[1]), command = commands.get(pid)
    if (!row || !command || (row[2] !== command && !row[2]!.startsWith(command + ' '))) continue
    const environment = row[2]!.slice(command.length)
    const tokens = [...environment.matchAll(/(?:^|\s)CLAUDE_CODE_SESSION_ID=(\S*)(?=\s|$)/g)]
    const sessionId = tokens.length === 1 && /^[0-9a-f-]{36}$/i.test(tokens[0]![1]!) ? tokens[0]![1] : undefined
    owners.set(pid, sessionId ? { sessionId } : {})
  }
  return owners
}

const basename = (path: string): string => path.split('/').at(-1) ?? ''
const shells = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish'])

export const sessionRoot = (rows: readonly PsRow[], selfPid: number | undefined): number | undefined => {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const visited = new Set<number>()
  let pid = selfPid
  while (pid !== undefined && !visited.has(pid)) {
    visited.add(pid)
    const row = byPid.get(pid)
    if (!row) break
    if (['claude', 'claude.exe'].includes(basename(words(row.command)[0]?.text ?? ''))) return pid
    pid = row.ppid
  }
  return undefined
}

// Keep a detached chain together, but never merge jobs across init or a Claude session.
export const jobRoot = (rows: readonly PsRow[], pid: number): PsRow | undefined => {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const visited = new Set<number>()
  let row = byPid.get(pid)
  while (row && row.pid > 1 && !visited.has(row.pid)) {
    visited.add(row.pid)
    const parent = byPid.get(row.ppid)
    if (row.ppid <= 1 || !parent || ['claude', 'claude.exe'].includes(basename(words(parent.command)[0]?.text ?? ''))) return row
    row = parent
  }
  return undefined
}

// Probe readable descendants even when they are not workers (for example a Python helper).
export const envProbePids = (rows: readonly PsRow[], rootPid: number, queried: ReadonlySet<number>): number[] => {
  const children = new Map<number, PsRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? []
    siblings.push(row)
    children.set(row.ppid, siblings)
  }
  const queue = [...(children.get(rootPid) ?? [])], visited = new Set([rootPid]), pids: number[] = []
  for (let i = 0; i < queue.length && pids.length < 5; i++) {
    const row = queue[i]!
    if (visited.has(row.pid)) continue
    visited.add(row.pid)
    queue.push(...(children.get(row.pid) ?? []))
    const executable = words(row.command)[0]?.text
    if (!queried.has(row.pid) && executable && !/^\/(?:bin|usr\/bin|sbin|usr\/sbin|System)\//.test(executable)) pids.push(row.pid)
  }
  return pids
}

const candidateLabel = (row: PsRow): CrewBoardRun['label'] | undefined => {
  if (/\/Applications\/ChatGPT\.app\/|app-server|codex-code-mode-host/.test(row.command)) return undefined
  const argv = words(row.command).map(token => token.text)
  const executable = basename(argv[0] ?? '')
  if (shells.has(executable)) return undefined
  if ((executable === 'codex' || (executable === 'node' && basename(argv[1] ?? '') === 'codex')) && argv.includes('exec')) return 'codex'
  if (executable === 'agy' && (argv.includes('-p') || argv.includes('--print'))) return 'gemini'
  if (executable === 'claude' && (argv.includes('-p') || argv.includes('--print'))) return 'claude-cli'
  return undefined
}

// String input remains useful for callers with a standalone snapshot; polling passes parsed rows.
export const pickProcess = (ps: string | readonly PsRow[], worker: CrewBoardWorker, now: number, takenPids: ReadonlySet<number>, ownedPids: ReadonlySet<number> = new Set()): number | undefined => {
  const candidates = (typeof ps === 'string' ? parsePs(ps) : ps).filter(row => candidateLabel(row) === worker.label)
  const candidatePids = new Set(candidates.map(candidate => candidate.pid))
  let picked: number | undefined, closest = Infinity
  for (const { pid, ppid, elapsed, command } of candidates) {
    if (!ownedPids.has(pid) || takenPids.has(pid) || takenPids.has(ppid) || candidatePids.has(ppid)) continue
    if (worker.model && !command.includes(worker.model)) continue
    const distance = Math.abs(now - elapsed - worker.startedAt)
    if (distance <= 15_000 && distance < closest) { picked = pid; closest = distance }
  }
  return picked
}

export const bindProcesses = (rows: readonly PsRow[], workers: readonly CrewBoardWorker[], now: number, ownedPids: ReadonlySet<number> = new Set()): CrewBoardWorker[] => {
  const taken = new Set(workers.flatMap(worker => worker.pid === undefined ? [] : [worker.pid]))
  return workers.map(worker => {
    if (worker.status !== 'running' || worker.label === 'claude') return worker
    const row = rows.find(row => row.pid === worker.pid)
    const reused = row && Math.abs(now - row.elapsed - (worker.processStartedAt ?? worker.startedAt)) >= 1000
    if (worker.scope === 'elsewhere') {
      if (!row || !candidateLabel(row)) return { ...worker, pid: undefined, status: 'completed', finishedAt: now, progress: 'process ended' }
      if (!reused) return worker
      const run = parseCommand(row.command)
      return { ...worker, ...run, startedAt: now - row.elapsed, processStartedAt: now - row.elapsed,
        livePaths: undefined, outputCache: undefined, folder: run?.folder, folderChecked: false,
        lastGrowthAt: now, count: 0, action: '', progress: '', stallNotified: false, stallReported: false }
    }
    // Persist revocation, and never reuse a previous process incarnation's paths.
    if (row && (!ownedPids.has(row.pid) || reused)) {
      worker = { ...worker, pid: undefined, processStartedAt: undefined, livePaths: undefined,
        outputCache: undefined, folder: undefined, folderChecked: false }
    }
    const pid = worker.pid ?? pickProcess(rows, worker, now, taken, ownedPids)
    if (pid === undefined) return worker
    taken.add(pid)
    const matched = rows.find(one => one.pid === pid)
    // A tool launch can precede the process; notifications share its ps birth with other windows.
    const processStartedAt = worker.processStartedAt ?? (worker.toolUseId && matched ? now - matched.elapsed : worker.startedAt)
    return { ...worker, pid, processStartedAt }
  })
}

export const discoverRuns = (rows: readonly PsRow[], rootPid: number | undefined, workers: readonly CrewBoardWorker[], now: number): CrewBoardWorker[] => {
  if (rootPid === undefined) return []
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const labels = new Map(rows.map(row => [row.pid, candidateLabel(row)]))
  const taken = new Set(workers.flatMap(worker => worker.pid === undefined ? [] : [worker.pid]))
  return rows.flatMap(row => {
    const label = labels.get(row.pid)
    if (!label || row.pid === rootPid || taken.has(row.pid) || taken.has(row.ppid) || labels.get(row.ppid)) return []
    const startedAt = now - row.elapsed
    if (workers.some(worker => worker.status === 'running' && worker.pid === undefined && worker.label === label && Math.abs(worker.startedAt - startedAt) <= 15_000)) return []
    const visited = new Set([row.pid])
    let pid = row.ppid, description: string | undefined
    while (pid !== rootPid) {
      if (visited.has(pid)) return []
      visited.add(pid)
      const parent = byPid.get(pid)
      if (!parent) return []
      const argv = words(parent.command).map(token => token.text)
      if (!description && shells.has(basename(argv[0] ?? '')) && argv[1] && !argv[1].startsWith('-')) description = basename(argv[1])
      pid = parent.ppid
    }
    const run = parseCommand(row.command)
    if (!run) return []
    return [{ ...run, id: `proc-${row.pid}`, pid: row.pid, description, startedAt, lastGrowthAt: startedAt,
      status: 'running' as const, progress: '', count: 0, action: '' }]
  })
}

// Walk ancestors even when no session root is available (detached helpers are valid).
export const discoverElsewhere = (rows: readonly PsRow[], rootPid: number | undefined, workers: readonly CrewBoardWorker[], now: number): CrewBoardWorker[] => {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const labels = new Map(rows.map(row => [row.pid, candidateLabel(row)]))
  const taken = new Set(workers.flatMap(worker => worker.pid === undefined ? [] : [worker.pid]))
  return rows.flatMap(row => {
    const label = labels.get(row.pid)
    if (!label || taken.has(row.pid) || taken.has(row.ppid) || labels.get(row.ppid)) return []
    const visited = new Set<number>()
    let pid = row.pid, description: string | undefined
    while (!visited.has(pid)) {
      if (pid === rootPid) return []
      visited.add(pid)
      const parent = byPid.get(pid)
      if (!parent) break
      if (pid !== row.pid && !description) {
        const argv = words(parent.command).map(token => token.text)
        if (shells.has(basename(argv[0] ?? '')) && argv[1] && !argv[1].startsWith('-')) description = basename(argv[1])
      }
      pid = parent.ppid
    }
    const run = parseCommand(row.command)
    if (!run) return []
    const startedAt = now - row.elapsed
    return [{ ...run, id: `else-${row.pid}`, scope: 'elsewhere' as const, pid: row.pid,
      ...(description ? { description } : {}), startedAt, lastGrowthAt: startedAt,
      status: 'running' as const, progress: '', count: 0, action: '' }]
  })
}

export const completeDiscovered = (workers: CrewBoardWorker[], rows: readonly PsRow[], now: number): CrewBoardWorker[] => {
  const alive = new Set(rows.map(row => row.pid))
  return workers.map(worker => worker.status === 'running' && worker.pid !== undefined &&
    (worker.id === `proc-${worker.pid}` || worker.id === `else-${worker.pid}`) && !worker.toolUseId && !alive.has(worker.pid)
    ? { ...worker, status: 'completed' as const, finishedAt: now, progress: 'process ended' } : worker)
}

export const stalledFor = (worker: CrewBoardWorker, now: number, stallMs: number): number => {
  if (worker.status !== 'running' || worker.label === 'claude') return 0
  const stalled = now - (worker.lastGrowthAt ?? worker.startedAt)
  return stalled >= stallMs ? stalled : 0
}

export const stallNote = (worker: CrewBoardWorker, stalled: number): string => {
  const description = worker.description ? ` (${worker.description})` : ''
  const pid = worker.pid === undefined ? '' : `; pid ${worker.pid}`
  const log = [...(worker.livePaths ?? []), ...worker.outputPaths][0]
  return `crew-board: ${worker.label}${worker.model ? ` ${worker.model}` : ''}${description} has written no new output for ${Math.floor(stalled / 60_000)} min${pid}${log ? `; log ${log}` : ''}. Check it; do not kill by name.`
}

export const observeOutput = (worker: CrewBoardWorker, observedBytes: number, now: number, actions?: { count: number; action: string }): CrewBoardWorker => {
  const grew = worker.observedBytes === undefined || observedBytes > worker.observedBytes || (actions?.count ?? 0) > worker.count
  return { ...worker, observedBytes, lastGrowthAt: worker.lastGrowthAt ?? worker.startedAt,
    ...(actions && actions.count >= worker.count ? actions : {}),
    ...(grew ? { lastGrowthAt: now, stallNotified: false, stallReported: false } : {}) }
}

export const parseLsofPaths = (out: string): string[] => [...new Set(out.split('\n')
  .filter(line => line.startsWith('n/') && !line.startsWith('n/dev/'))
  .map(line => line.slice(1)))]

export const parseCommand = (command: string): CrewBoardRun | null => {
  const tokens = words(command)
  const variables = new Map<string, string>()
  const expand = (path: string) => path.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (original, braced, plain) => variables.get(braced ?? plain) ?? original)
  let directory: string | undefined
  let executable = true
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token.quoted && /^(;|&&|\|\||\||&|\n)$/.test(token.text)) { executable = true; continue }
    if (!executable) continue
    const name = token.text.split('/').at(-1)
    const assignment = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(token.text)
    if (assignment) {
      if (!/\$\(|`/.test(assignment[2]!)) variables.set(assignment[1]!, assignment[2]!)
      else variables.delete(assignment[1]!)
      continue
    }
    if (['env', 'export', 'nohup', 'time', 'command', 'exec', 'node'].includes(name ?? '')) continue
    executable = false
    const end = tokens.findIndex((t, at) => at > i && !t.quoted && /^(;|&&|\|\||\||&|\n)$/.test(t.text))
    const args = tokens.slice(i + 1, end < 0 ? undefined : end)
    if (name === 'cd' && args[0]?.text.startsWith('/')) { directory = args[0].text; continue }
    if (name !== 'codex' && name !== 'agy' && !(name === 'claude' && args.some(t => t.text === '-p' || t.text === '--print'))) continue
    const run: CrewBoardRun = { label: name === 'agy' ? 'gemini' : name === 'claude' ? 'claude-cli' : 'codex', outputPaths: [] }
    for (let n = 0; n < args.length; n++) {
      const arg = args[n]!.text
      const value = args[n + 1]?.text
      if ((arg === '-C' || arg === '--cd') && value) { run.folder = value; n++ }
      else if (arg.startsWith('--cd=')) run.folder = arg.slice(5)
      else if ((arg === '-m' || arg === '--model') && value) { run.model = value; n++ }
      else if (arg.startsWith('--model=')) run.model = arg.slice(8)
      else if (arg === '--effort' && value) { run.effort = value; n++ }
      else if (arg.startsWith('--effort=')) run.effort = arg.slice(9)
      else if (/^model_reasoning_effort\s*=/.test(arg)) run.effort = arg.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
      else if (arg === '-o' && value) { run.outputPaths.push(value); n++ }
      else if (!args[n]!.quoted && (arg === '>' || arg === '>>') && value && !['&', '>'].includes(value)) { run.outputPaths.push(value); n++ }
    }
    run.outputPaths = [...new Set(run.outputPaths.map(expand)
      .filter(path => path && !path.includes('$') && !path.includes('`') && !path.startsWith('&'))
      .map(path => {
        if (!directory || path.startsWith('/')) return path
        const parts: string[] = []
        for (const part of `${directory}/${path}`.split('/')) {
          if (part === '..') parts.pop()
          else if (part && part !== '.') parts.push(part)
        }
        return '/' + parts.join('/')
      }).filter(path => path !== '/dev/null'))]
    return run
  }
  return null
}

export const stripAnsi = (text: string): string => text
  .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, '')
  .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\u001b[ -/]*[@-Z\\-_]/g, '')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
export const lastLine = (text: string): string => stripAnsi(text).split(/[\r\n]/).map(line => line.trim()).filter(Boolean).at(-1) ?? ''

// A snapshot count makes rereading the same file idempotent; repeated lines still count.
export const parseActionOutput = (text: string): { count: number; action: string } => {
  const actions = stripAnsi(text).split(/\r\n|[\r\n]/)
    .flatMap(line => {
      if (/URL: https:\/\/\S*v1internal:streamGenerateContent/.test(line)) return ['Gemini turn']
      if (/^(?:web search:|(?:exec|tool|thinking|codex)\b)/.test(line)) return [line]
      if (/https?:\/\/|\b(?:loadCodeAssist|fetchAvailableModels|generateContent|errors?)\b/i.test(line)) return []
      return /^\[[^\]\r\n]*[^\s\]\r\n]/.test(line) ? [line] : []
    })
  return { count: actions.length, action: actions.at(-1)?.trim() ?? '' }
}

type StepTool = { tool: string; command?: unknown; file_path?: unknown; description?: unknown }
const toolAction = (call: StepTool): string => {
  let arg = ''
  if (call.tool === 'Bash' && typeof call.command === 'string') arg = stripAnsi(call.command).slice(0, 40).replace(/\s+/g, ' ').trim()
  else if (['Read', 'Edit', 'Write'].includes(call.tool) && typeof call.file_path === 'string') arg = stripAnsi(call.file_path).split('/').at(-1) ?? ''
  else if (call.tool === 'Agent' && typeof call.description === 'string') arg = stripAnsi(call.description).replace(/\s+/g, ' ').trim()
  return arg ? `${call.tool}: ${arg}` : call.tool
}
export const stepLabel = (count: number, call: StepTool | string): string => {
  const action = typeof call === 'string' ? call : toolAction(call)
  return [`step ${count}`, action].filter(Boolean).join(' · ')
}

export const recordAgentStep = (state: CrewBoardState, agentId: string, call: StepTool): CrewBoardState => {
  const found = state.workers.find(worker => worker.label === 'claude' && worker.taskId === agentId)
  if (found) return found.status !== 'running' ? state : {
    ...state, workers: state.workers.map(worker => worker === found
      ? { ...worker, count: (worker.count ?? 0) + 1, action: toolAction(call) } : worker),
  }
  // A child can call a tool before agent.spawn's result binds its launch row.
  if (!state.workers.some(worker => worker.label === 'claude' && !worker.taskId && worker.status === 'running')) return state
  const pending = state.pendingSteps?.[agentId]
  return { ...state, pendingSteps: { ...state.pendingSteps, [agentId]: { count: (pending?.count ?? 0) + 1, action: toolAction(call) } } }
}

export const ageWorkers = (workers: CrewBoardWorker[], now: number, maxAge: number): CrewBoardWorker[] => workers.flatMap(worker => {
  if (worker.finishedAt !== undefined) return now - worker.finishedAt < 20_000 ? [worker] : []
  if (now - worker.startedAt >= maxAge) return [{ ...worker, status: 'failed' as const, finishedAt: now, progress: 'Maximum age reached; completion not observed' }]
  return [worker]
})

export const completeWorkers = (state: CrewBoardState, completion: CrewBoardCompletion): CrewBoardState => ({
  ...state, now: completion.at,
  completions: [...state.completions.filter(one => completion.at - one.at < 20_000), completion],
  workers: state.workers.map(worker => matches(worker, completion) && worker.status === 'running'
    ? { ...worker, status: completion.status, finishedAt: completion.at, progress: completion.progress || worker.progress }
    : worker),
})

const matches = (worker: CrewBoardWorker, completion: CrewBoardCompletion): boolean =>
  (completion.taskId !== undefined && worker.taskId === completion.taskId) ||
  (completion.toolUseId !== undefined && worker.toolUseId === completion.toolUseId)

export const bindTask = (state: CrewBoardState, id: string, taskId: string, model?: string): CrewBoardState => ({
  ...state,
  pendingSteps: Object.fromEntries(Object.entries(state.pendingSteps ?? {}).filter(([key]) => key !== taskId)),
  workers: state.workers.map(worker => {
    if (worker.id !== id) return worker
    const bound = { ...worker, ...state.pendingSteps?.[taskId], taskId, model: model ?? worker.model }
    const completion = state.completions.find(one => matches(bound, one))
    return completion && bound.status === 'running'
      ? { ...bound, status: completion.status, finishedAt: completion.at, progress: completion.progress || bound.progress }
      : bound
  }),
})

const cellWidth = (glyph: string): number => {
  if (/\p{Mark}|\p{Cf}/u.test(glyph)) return 0
  const cp = glyph.codePointAt(0)!
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff) || cp >= 0x20000) ? 2 : 1
}

export const fit = (text: string, columns: number): string => {
  const width = Math.max(0, Math.floor(columns))
  const glyphs = [...stripAnsi(text).replace(/\s+/g, ' ').trim()]
  if (glyphs.reduce((sum, glyph) => sum + cellWidth(glyph), 0) <= width) return glyphs.join('')
  if (width === 0) return ''
  let result = '', used = 0
  for (const glyph of glyphs) {
    const cells = cellWidth(glyph)
    if (used + cells > width - 1) break
    result += glyph; used += cells
  }
  return result.trimEnd() + '…'
}

export const crewLines = (workers: CrewBoardWorker[], now: number, columns: number, stallMs = 8 * 60_000): { key: string; text: string; dim: boolean }[] => {
  const own = workers.filter(worker => worker.scope !== 'elsewhere')
  const elsewhere = workers.filter(worker => worker.scope === 'elsewhere')
    .sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.startedAt - b.startedAt)
  const ordered = [...own].sort((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running') || a.startedAt - b.startedAt)
  const render = (worker: CrewBoardWorker) => {
    const seconds = Math.max(0, Math.floor(((worker.finishedAt ?? now) - worker.startedAt) / 1000))
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    const mark = worker.scope === 'elsewhere' ? '◦' : worker.status === 'running' ? '●' : worker.status === 'completed' ? '✓' : '✗'
    const type = worker.subagentType ? `[${worker.subagentType}]` : ''
    const metadata = [worker.model, worker.effort].filter(Boolean).join('/')
    const action = lastLine(worker.action || worker.progress)
    const progress = worker.label === 'claude' ? stepLabel(worker.count ?? 0, action)
      : [`${worker.count ?? 0} actions`, action].filter(Boolean).join(' · ')
    const stalled = stalledFor(worker, now, stallMs)
    const timing = elapsed + (stalled ? ` ⚠ stalled ${Math.floor(stalled / 60_000)}m` : '')
    const folder = worker.scope === 'elsewhere' ? (worker.folder ?? '').split('/').filter(Boolean).slice(-2).join('/') : ''
    const fixed = [mark, worker.label, type, metadata, timing].filter(Boolean).join(' ')
    const fixedWidth = [...fixed].reduce((sum, glyph) => sum + cellWidth(glyph), 0)
    const labelRoom = Math.max(0, columns - fixedWidth - Math.min(40, progress.length + 3) - 1)
    const identity = [folder, worker.name ?? worker.description ?? ''].filter(Boolean).join(' · ')
    const description = fit(identity, labelRoom)
    const prefix = [mark, worker.label, description, type, metadata, timing].filter(Boolean).join(' ')
    return { key: worker.id, text: fit(`${prefix} · ${progress}`, columns), dim: worker.status !== 'running' }
  }
  const lines = ordered.slice(0, 6).map(render)
  if (own.length > 6) lines.push({ key: 'more', text: fit(`+${own.length - 6} more`, columns), dim: true })
  lines.push(...elsewhere.slice(0, 4).map(render))
  if (elsewhere.length > 4) lines.push({ key: 'more-elsewhere', text: fit(`+${elsewhere.length - 4} more elsewhere`, columns), dim: true })
  return lines
}
