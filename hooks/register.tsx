import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallResult } from 'claude-code'
import type { CrewBoardCompletion, CrewBoardEnvOwner, CrewBoardState, CrewBoardWorker } from '../types'
import { ageWorkers, bindProcesses, stallNote, completeDiscovered, discoverElsewhere, discoverRuns, observeOutput, parseEnvOwners, parsePs, sessionRoot, stalledFor, bindTask, completeWorkers, crewLines, emptyBoard, lastLine, parseActionOutput, parseCommand, parseLsofPaths, recordAgentStep } from './crew'
import type { PsRow } from './crew'

const board = atom({ plugin: 'crew-board', key: 'board' } as const, emptyBoard(0))

let timer: Timer | undefined
let ticking = false
let sequence = 0
let maxAge = 7_200_000
let stallMs = 8 * 60_000
let showElsewhere = false

const ownerCache = new Map<number, CrewBoardEnvOwner & { startedAt: number }>()
const unavailableTools = new Set<string>()
let sessionOwnedPids: ReadonlySet<number> = new Set()
let ownershipSessionId: string | undefined
let systemName: string | undefined
const cachedEnv = (pid: number, startedAt: number) => {
  const cached = ownerCache.get(pid)
  // ps etime has whole-second precision; polling can shift the inferred birth by <1s.
  return cached && Math.abs(cached.startedAt - startedAt) < 1000 ? cached : undefined
}
const promoteWorker = (worker: CrewBoardWorker, ownedPids: ReadonlySet<number>): CrewBoardWorker =>
  worker.scope === 'elsewhere' && worker.status === 'running' && worker.pid !== undefined && ownedPids.has(worker.pid)
    ? { ...worker, id: `proc-${worker.pid}`, scope: 'own' } : worker

const discoverWorkers = (rows: readonly PsRow[], rootPid: number | undefined, workers: readonly CrewBoardWorker[], now: number, ownedPids: ReadonlySet<number>): CrewBoardWorker[] => [
  ...discoverRuns(rows, rootPid, workers, now).filter(worker => ownedPids.has(worker.pid!)),
  ...discoverElsewhere(rows, rootPid, workers, now).flatMap(worker =>
    ownedPids.has(worker.pid!)
      ? [{ ...worker, id: `proc-${worker.pid}`, scope: 'own' as const }]
      : showElsewhere ? [worker] : []),
]

type WorkerPoll = Pick<CrewBoardWorker, 'pid' | 'processStartedAt' | 'livePaths' | 'folder' | 'folderChecked' | 'outputCache'> & { observedBytes: number; actions?: { count: number; action: string } }

// Missing executables, timeouts and exited workers must never interrupt the board.
const processOutput = async ($: EngineInterface, argv: string[]): Promise<string | undefined> => {
  try {
    const result = await $.process.run(argv, { timeoutMs: 5000 })
    if (argv[0] === 'ps' || argv[0] === 'lsof') {
      if (result.exitCode === 126 || result.exitCode === 127) unavailableTools.add(argv[0])
      else unavailableTools.delete(argv[0])
    }
    return result.exitCode === 0 && !result.isStdoutTruncated ? result.stdout : undefined
  } catch {
    if (argv[0] === 'ps' || argv[0] === 'lsof') unavailableTools.add(argv[0])
    return undefined
  }
}

// The host may hide `process`; a child it spawns still names the host as its parent.
let cachedHostPid: number | undefined
const hostPid = async ($: EngineInterface): Promise<number | undefined> => {
  const own = (globalThis as { process?: { pid?: number } }).process?.pid
  if (own) return own
  if (cachedHostPid === undefined) {
    const parent = Number((await processOutput($, ['/bin/sh', '-c', 'echo $PPID']))?.trim())
    if (Number.isInteger(parent) && parent > 1) cachedHostPid = parent
  }
  return cachedHostPid
}

const readProcesses = async ($: EngineInterface): Promise<PsRow[] | undefined> => {
  const output = await processOutput($, ['ps', '-Ao', 'pid=,ppid=,etime=,command='])
  return output === undefined ? undefined : parsePs(output)
}

const currentSessionId = async ($: EngineInterface) =>
  await $.session.id().catch(() => undefined) || await $.env.get('CLAUDE_CODE_SESSION_ID').catch(() => undefined)

// Resolve ownership before any binding, cwd lookup or log-file read, including finish().
const ownership = async ($: EngineInterface, rows: readonly PsRow[], now: number) => {
  const rootPid = sessionRoot(rows, await hostPid($))
  const sessionId = await currentSessionId($)
  ownershipSessionId = sessionId
  const candidates = discoverElsewhere(rows, undefined, [], now)
  const pids = candidates.filter(worker => !cachedEnv(worker.pid!, worker.startedAt)).map(worker => worker.pid!)
  if (pids.length) {
    // ps supplies environments only for candidate helpers. Keep just the session token.
    const owners = parseEnvOwners(await processOutput($, ['ps', 'eww', '-o', 'pid=,command=', '-p', pids.join(',')]) ?? '', rows)
    for (const worker of candidates) {
      if (pids.includes(worker.pid!)) ownerCache.set(worker.pid!, { startedAt: worker.startedAt, ...owners.get(worker.pid!) })
    }
  }
  const attached = new Set(discoverRuns(rows, rootPid, [], now).map(worker => worker.pid!))
  sessionOwnedPids = new Set(candidates.filter(worker => {
    const token = cachedEnv(worker.pid!, worker.startedAt)?.sessionId
    return token && sessionId ? token === sessionId : attached.has(worker.pid!)
  }).map(worker => worker.pid!))
  return { rootPid, ownedPids: sessionOwnedPids }
}

const canPoll = (worker: CrewBoardWorker, ownedPids: ReadonlySet<number>) =>
  worker.pid !== undefined && (ownedPids.has(worker.pid) || (showElsewhere && worker.scope === 'elsewhere'))

const pruneMarkers = async ($: EngineInterface, now: number) => {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (!home) return
  const directory = `${home}/.claude/crew-board/stall-markers`
  const entries = await $.fs.list(directory).catch(() => [])
  for (const entry of entries) {
    if (entry.kind === 'file' && !entry.isLink && /^\d+-\d+$/.test(entry.name) && Number.isFinite(entry.mtimeMs) && now - entry.mtimeMs > maxAge) {
      await processOutput($, ['/bin/rm', '-f', '--', `${directory}/${entry.name}`])
    }
  }
}

const pollWorker = async ($: EngineInterface, worker: CrewBoardWorker): Promise<WorkerPoll | undefined> => {
  if (worker.label === 'claude') return undefined
  const { pid } = worker
  let { livePaths, folder, folderChecked } = worker
  if (worker.scope && !folder && !folderChecked && pid !== undefined) {
    const cwd = await processOutput($, ['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    folder = cwd?.split('\n').find(line => line.startsWith('n/'))?.slice(1)
    folderChecked = true
  }
  if (pid !== undefined && !livePaths?.length) {
    livePaths = parseLsofPaths(await processOutput($, ['lsof', '-p', String(pid), '-a', '-d', '1,2', '-Fn']) ?? '')
  }
  const outputCache: NonNullable<CrewBoardWorker['outputCache']> = {}
  let observed: { count: number; action: string } | undefined, observedBytes = 0
  for (const path of new Set([...(livePaths ?? []), ...worker.outputPaths])) {
    const stat = await $.fs.stat(path).catch(() => undefined)
    const size = stat?.kind === 'file' && Number.isFinite(stat.size) ? stat.size : undefined
    const cached = worker.outputCache?.[path]
    let parsed: { count: number; action: string } | undefined
    if (size !== undefined && cached?.size === size) {
      outputCache[path] = cached
      observedBytes += cached.bytes
      parsed = cached
    } else {
      const text = await $.fs.read(path).catch(() => undefined)
      if (text !== undefined) {
        parsed = parseActionOutput(text)
        observedBytes += text.length
        if (size !== undefined) outputCache[path] = { size, bytes: text.length, ...parsed }
      }
    }
    // Preserve the first action-bearing file's priority; inspect every file for growth.
    if (parsed && !observed?.count) observed = parsed
  }
  return { pid, processStartedAt: worker.processStartedAt, livePaths, folder, folderChecked, outputCache, actions: observed, observedBytes }
}

const applyPoll = (worker: CrewBoardWorker, result: WorkerPoll | undefined, now: number): CrewBoardWorker => {
  if (worker.status !== 'running' || !result) return worker
  return observeOutput({ ...worker, pid: result.pid, processStartedAt: result.processStartedAt, livePaths: result.livePaths, folder: result.folder, folderChecked: result.folderChecked, outputCache: result.outputCache }, result.observedBytes, now, result.actions)
}

const finish = async ($: EngineInterface, completion: CrewBoardCompletion) => {
  const snapshot = await read($, board)
  const final = new Map<string, WorkerPoll>()
  const rows = await readProcesses($)
  const { ownedPids } = await ownership($, rows ?? [], completion.at)
  const bound = rows === undefined ? snapshot.workers : bindProcesses(rows, snapshot.workers, completion.at, ownedPids)
  for (const worker of bound.filter(one => canPoll(one, ownedPids) && one.status === 'running' &&
    ((completion.taskId !== undefined && one.taskId === completion.taskId) ||
      (completion.toolUseId !== undefined && one.toolUseId === completion.toolUseId)))) {
    const result = await pollWorker($, worker)
    if (result) final.set(worker.id, result)
  }
  await update($, board, state => {
    const already = state.completions.some(one =>
      (completion.taskId !== undefined && one.taskId === completion.taskId) ||
      (completion.toolUseId !== undefined && one.toolUseId === completion.toolUseId))
    const workers = rows === undefined ? state.workers : bindProcesses(rows, state.workers, completion.at, ownedPids)
    return already ? state : completeWorkers({ ...state, workers: workers.map(worker => {
      const result = final.get(worker.id)
      return applyPoll(worker, result, completion.at)
    }) }, completion)
  })
}

const tick = async ($: EngineInterface) => {
  if (ticking) return
  ticking = true
  try {
    const now = await $.clock.now()
    await pruneMarkers($, now)
    const state = await read($, board)
    const progress = new Map<string, WorkerPoll>()
    const poll = now - state.polledAt >= 5000
    let rows: PsRow[] | undefined, rootPid: number | undefined
    let ownedPids: ReadonlySet<number> = new Set()
    if (poll) {
      rows = await readProcesses($)
      ;({ rootPid, ownedPids } = await ownership($, rows ?? [], now))
      const bound = rows === undefined ? state.workers : bindProcesses(rows, state.workers, now, ownedPids)
      const discovered = discoverWorkers(rows ?? [], rootPid, bound, now, ownedPids)
      for (const worker of [...bound.map(worker => promoteWorker(worker, ownedPids)), ...discovered].filter(one => rows !== undefined && one.status === 'running' && canPoll(one, ownedPids))) {
        const result = await pollWorker($, worker)
        if (result) progress.set(worker.id, result)
      }
    }
    const notify: (CrewBoardWorker & { minutes: number })[] = []
    if (state.workers.length || state.completions.length || poll) {
      await update($, board, current => {
        notify.length = 0
        let workers = rows !== undefined ? bindProcesses(rows, current.workers, now, ownedPids) : current.workers
        workers = workers.map(worker => promoteWorker(worker, ownedPids))
        // Recheck against current state: a Bash launch can arrive while files are being read.
        workers.push(...discoverWorkers(rows ?? [], rootPid, workers, now, ownedPids))
        workers = workers.map(worker => applyPoll(worker, progress.get(worker.id), now))
        if (rows !== undefined) workers = completeDiscovered(workers, rows, now)
        workers = ageWorkers(workers, now, maxAge).map(worker => {
          const stalled = stalledFor(worker, now, stallMs)
          if (!stalled || worker.stallNotified || !canPoll(worker, sessionOwnedPids)) return worker
          notify.push({ ...worker, minutes: Math.floor(stalled / 60_000) })
          return { ...worker, stallNotified: true }
        })
        return {
          ...current, now, polledAt: poll ? now : current.polledAt,
          completions: current.completions.filter(one => now - one.at < 20_000),
          pendingSteps: workers.some(one => one.label === 'claude' && !one.taskId && one.status === 'running') ? current.pendingSteps ?? {} : {},
          workers,
        }
      })
    }
    for (const worker of notify) {
      systemName ??= (await processOutput($, ['uname', '-s']))?.trim()
      if (systemName !== 'Darwin') continue
      const name = `${worker.pid}-${Math.floor((worker.processStartedAt ?? worker.startedAt) / 1000)}`
      const home = await $.env.get('HOME').catch(() => undefined)
      const claim = home
        ? ['/bin/sh', '-c', 'mkdir -p "$1" && set -C && : > "$1/$2"', 'sh', `${home}/.claude/crew-board/stall-markers`, name]
        : ['/bin/sh', '-c', 'test -n "$HOME" && set -- "$HOME/.claude/crew-board/stall-markers" "$1" && mkdir -p "$1" && set -C && : > "$1/$2"', 'sh', name]
      if (await processOutput($, claim) === undefined) continue
      const message = `${worker.label}${worker.model ? ` ${worker.model}` : ''} - no new output for ${worker.minutes} min`
      await processOutput($, ['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Crew board: helper stalled"', '-e', 'end run', message.replace(/[\r\n]/g, ' ')])
    }
  } finally { ticking = false }
}

const startTimer = ($: EngineInterface) => {
  timer ??= $.clock.every(1000, () => { void tick($).catch(() => undefined) })
}

const startWorker = async ($: EngineInterface, worker: CrewBoardWorker) => {
  startTimer($)
  await update($, board, state => ({
    ...state, now: worker.startedAt,
    polledAt: state.workers.some(one => one.status === 'running') ? state.polledAt : worker.startedAt,
    workers: [...ageWorkers(state.workers, worker.startedAt, maxAge), { ...worker, lastGrowthAt: worker.startedAt }],
  }))
}

export const register: Register = (on, options) => {
  showElsewhere = options.showElsewhere === true
  const configuredAge = Number(options.maxAgeSeconds ?? 7200)
  maxAge = (Number.isFinite(configuredAge) && configuredAge > 0 ? configuredAge : 7200) * 1000
  const configuredStall = Number(options.stallMinutes ?? 8)
  stallMs = (Number.isFinite(configuredStall) && configuredStall > 0 ? configuredStall : 8) * 60_000
  on('session.start', ($, e, next) => { cachedHostPid = undefined; ownerCache.clear(); sessionOwnedPids = new Set(); ownershipSessionId = undefined; systemName = undefined; unavailableTools.clear(); startTimer($); return next(e) })
  on('session.end', async ($, e, next) => {
    timer?.cancel(); timer = undefined
    await update($, board, () => emptyBoard(0))
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    if (e.source && e.source !== 'user') return r
    // /clear changes identity without session.start; old proof cannot enter the new context.
    if (await currentSessionId($) !== ownershipSessionId) sessionOwnedPids = new Set()
    const now = await $.clock.now()
    const notes: string[] = []
    await update($, board, state => {
      notes.length = 0
      return { ...state, workers: state.workers.map(worker => {
        const stalled = stalledFor(worker, now, stallMs)
        if (worker.scope === 'elsewhere' || worker.pid === undefined || !sessionOwnedPids.has(worker.pid) || !stalled || worker.stallReported) return worker
        notes.push(stallNote(worker, stalled))
        return { ...worker, stallReported: true }
      }) }
    })
    return notes.length ? { ...r, additionalContext: [...(r.additionalContext ?? []), notes.join('\n')] } : r
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) await update($, board, state => recordAgentStep(state, e.agentId!, e))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) await update($, board, state => {
      const worker = state.workers.find(one => one.label === 'claude' && one.toolUseId === e.tool_use_id)
      return worker ? bindTask(state, worker.id, spawned.agentId!, spawned.model) : state
    })
    return spawned
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next): Promise<ToolCallResult<'Bash'>> => {
    const run = parseCommand(e.command)
    if (!run) return next(e)
    const id = e.tool_use_id ?? `bash-${++sequence}`
    await startWorker($, { ...run, id, toolUseId: e.tool_use_id ?? id, startedAt: await $.clock.now(), status: 'running', progress: '', count: 0, action: '' })
    const ran = await next(e)
    const at = await $.clock.now()
    if (ran.deny === undefined && !ran.isError && ran.result.backgroundTaskId) {
      await update($, board, state => bindTask(state, id, ran.result.backgroundTaskId!))
    } else {
      const failed = ran.deny !== undefined || ran.isError === true
      const result = ran.deny === undefined && !ran.isError ? ran.result : undefined
      await finish($, { toolUseId: e.tool_use_id ?? id, at, status: failed || result?.interrupted ? 'failed' : 'completed', progress: lastLine(ran.deny ?? ran.text ?? result?.stdout ?? result?.stderr ?? '') })
    }
    return ran
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const id = e.tool_use_id ?? `agent-${++sequence}`
    await startWorker($, {
      id, toolUseId: e.tool_use_id ?? id, label: 'claude', name: e.name, description: e.description,
      subagentType: e.subagent_type, model: e.model, effort: e.effort, outputPaths: [],
      startedAt: await $.clock.now(), status: 'running', progress: '', count: 0, action: '',
    })
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) {
      await finish($, { toolUseId: e.tool_use_id ?? id, at: await $.clock.now(), status: 'failed', progress: lastLine(ran.deny ?? ran.text ?? '') })
    } else {
      const result = ran.result
      const taskId = 'agentId' in result ? result.agentId : 'agent_id' in result ? result.agent_id : result.taskId
      const model = 'resolvedModel' in result ? result.resolvedModel : 'model' in result ? result.model : undefined
      if (taskId) await update($, board, state => bindTask(state, id, taskId, model))
      if ('status' in result && result.status === 'completed') {
        await finish($, { taskId, toolUseId: e.tool_use_id ?? id, at: await $.clock.now(), status: 'completed', progress: lastLine(ran.text ?? result.content.map(one => one.text).join('\n')) })
      }
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      await finish($, { taskId: e.agentId, at: await $.clock.now(), status: e.reason === 'answer' ? 'completed' : 'failed', progress: lastLine(e.answer) })
    }
    return next(e)
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, ($, e, next) => {
    const task = e.props.task
    if (task && (task.id || task.toolUseId) && ['completed', 'failed', 'killed'].includes(task.status ?? '')) {
      // Render cannot write state; the timer has its own dispatch.
      $.clock.after(0, () => { void $.clock.now().then(at => finish($, { taskId: task.id, toolUseId: task.toolUseId, at, status: task.status === 'completed' ? 'completed' : 'failed', progress: lastLine(e.props.text) })).catch(() => undefined) })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, board)
    if (e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    const lines = crewLines(ageWorkers(state.workers, now, maxAge), now, e.props.bodyColumns, stallMs)
    if (unavailableTools.size) lines.push({ key: 'tools-unavailable', text: `crew-board: ${[...unavailableTools].sort().join(', ')} unavailable; discovery limited`.slice(0, Math.max(0, e.props.bodyColumns)), dim: true })
    if (!lines.length) return next(e)
    // A hot reload drops timers, while the host keeps the board.
    if (!timer) $.clock.after(0, () => startTimer($))
    const { Box, Text } = $.ui.resolve(e)
    // Keep what the plugins beneath draw (e.g. next-buttons) under the board instead of hiding it.
    const below = await next(e)
    return <Box flexDirection="column">
      {lines.map(line => <Text key={line.key} dimColor={line.dim} wrap="truncate-end">{line.text}</Text>)}
      {below}
    </Box>
  })
}
