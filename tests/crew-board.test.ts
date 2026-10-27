import type { RenderElement, ToolCallResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { CrewBoardWorker } from '../types'
import { ageWorkers, bindProcesses, stallNote, completeDiscovered, discoverElsewhere, discoverRuns, envProbePids, jobRoot, observeOutput, parseEnvOwners, parsePs, sessionRoot, stalledFor, bindTask, completeWorkers, crewLines, emptyBoard, lastLine, parseActionOutput, parseCommand, parseEtime, parseLsofPaths, pickProcess, recordAgentStep, stepLabel, stripAnsi } from '../hooks/crew'

test('codex output and quoted reasoning effort are parsed', () => {
  expect(parseCommand('codex exec -m gpt-6 -c model_reasoning_effort="high" -o "out file.md" "Review this"')).toEqual({
    label: 'codex', model: 'gpt-6', effort: 'high', outputPaths: ['out file.md'],
  })
})

test('agy model and shell redirects are parsed', () => {
  expect(parseCommand('agy --model gemini-pro hello >out.log 2> "err file.log"')).toEqual({
    label: 'gemini', model: 'gemini-pro', outputPaths: ['out.log', 'err file.log'],
  })
})

test('claude print mode and equals flags are parsed; plain Bash is ignored', () => {
  expect(parseCommand('claude -p "hello" --model=opus --effort=max > /tmp/progress')).toEqual({
    label: 'claude-cli', model: 'opus', effort: 'max', outputPaths: ['/tmp/progress'],
  })
  expect(parseCommand('ls -la')).toBe(null)
  expect(parseCommand('echo "codex exec -m fake"')).toBe(null)
})

const worker = (extra: Partial<CrewBoardWorker> = {}): CrewBoardWorker => ({
  id: 'one', label: 'codex', model: 'gpt-6', effort: 'high', outputPaths: [],
  startedAt: 0, status: 'running', progress: '', count: 2, action: 'exec: build', ...extra,
})

test('command paths expand literal assignments and follow earlier absolute cd segments', () => {
  expect(parseCommand('OUT=/x/y; codex exec hi 2> "$OUT/codex.err"')?.outputPaths).toEqual(['/x/y/codex.err'])
  expect(parseCommand('OUT="/x y"; agy hi > "${OUT}/gemini.log"')?.outputPaths).toEqual(['/x y/gemini.log'])
  expect(parseCommand("OUT='/x/y' codex exec hi -o ${OUT}/out.md 2>/dev/null")?.outputPaths).toEqual(['/x/y/out.md'])
  expect(parseCommand('cd /a/b && codex exec hi 2>err.log')?.outputPaths).toEqual(['/a/b/err.log'])
  expect(parseCommand('cd /a && cd /b/c && agy hi >../out.log')?.outputPaths).toEqual(['/b/out.log'])
  expect(parseCommand('OUT="$(pwd)"; codex exec hi 2> "$OUT/err" > "$MISSING/out"')?.outputPaths).toEqual([])
  expect(parseCommand('OUT="`pwd`"; codex exec hi > "$OUT/err"')?.outputPaths).toEqual([])
})

test('etime parses minutes, hours and days without accepting malformed elapsed times', () => {
  expect(parseEtime('03:04')).toBe(184_000)
  expect(parseEtime('02:03:04')).toBe(7_384_000)
  expect(parseEtime('1-02:03:04')).toBe(93_784_000)
  expect(parseEtime('00:00')).toBe(0)
  expect(parseEtime('bad')).toBeUndefined()
  expect(parseEtime('02:99')).toBeUndefined()
})

test('process matching filters models, reserved pids, wrappers and non-worker commands', () => {
  const owned = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
  const ps = [
    '10 1 00:05 /bin/zsh -c codex exec -m gpt-6 hi',
    '11 1 00:05 /opt/bin/codex app-server exec -m gpt-6',
    '12 1 00:05 /opt/bin/codex-code-mode-host exec -m gpt-6',
    '13 1 00:05 /opt/bin/codex exec -m other hi',
    '14 1 00:30 codex exec -m gpt-6 hi',
    '15 1 00:08 /opt/bin/codex exec -m gpt-6 hi',
    '16 1 00:05 /opt/bin/node /opt/bin/codex exec -m gpt-6 hi',
    '17 1 00:05 codex -m gpt-6 hi',
    '18 1 malformed codex exec -m gpt-6 hi',
    '19 1 00:05 echo codex exec -m gpt-6 hi',
  ].join('\n')
  expect(pickProcess(ps, worker(), 5000, new Set(), owned)).toBe(16)
  expect(pickProcess(ps, worker(), 5000, new Set([16]), owned)).toBe(15)
  expect(pickProcess(ps, worker(), 5000, new Set([15, 16]), owned)).toBeUndefined()
  expect(pickProcess('20 1 00:05 agy --model gemini-pro -p hi', worker({ label: 'gemini', model: 'gemini-pro' }), 5000, new Set(), owned)).toBe(20)
  expect(pickProcess('21 1 00:05 claude --model opus\n22 1 00:05 /bin/claude --print --model opus hi', worker({ label: 'claude-cli', model: 'opus' }), 5000, new Set(), owned)).toBe(22)
  expect(pickProcess('23 1 00:05 codex exec hi', worker({ model: undefined }), 5000, new Set(), owned)).toBe(23)
  expect(pickProcess('24 1 00:05 codex exec -m gpt-6', worker({ label: 'claude' }), 5000, new Set(), owned)).toBeUndefined()
})

test('nearby same-model runs reserve wrappers instead of another run\'s child', () => {
  // Each process starts three seconds after its worker row; the runs are three seconds apart.
  const ps = [
    '101 100 00:10 /opt/homebrew/vendor/bin/codex exec -m gpt-6 hi',
    '100 1 00:10 node /opt/homebrew/bin/codex exec -m gpt-6 hi',
    '201 200 00:07 /opt/homebrew/vendor/bin/codex exec -m gpt-6 hi',
    '200 1 00:07 node /opt/homebrew/bin/codex exec -m gpt-6 hi',
  ].join('\n')
  const first = pickProcess(ps, worker(), 13_000, new Set(), new Set([100, 101, 200, 201]))
  expect(first).toBe(100)
  expect(pickProcess(ps, worker({ startedAt: 3000 }), 13_000, new Set(first === undefined ? [] : [first]), new Set([100, 101, 200, 201]))).toBe(200)
})

test('children of reserved pids stay excluded when the parent is absent from ps', () => {
  const ps = '101 100 00:05 /opt/homebrew/vendor/bin/codex exec -m gpt-6 hi'
  expect(pickProcess(ps, worker(), 5000, new Set([100]), new Set([101]))).toBeUndefined()
})

test('lsof paths retain only unique absolute files outside devices', () => {
  expect(parseLsofPaths('p123\nf1\nn/dev/ttys001\nf2\nn/Users/me/.gemini/antigravity-cli/log/cli-1.log\nnpipe\nn->0xabc\nn/tmp/out.log\nn/tmp/out.log\nnsocket\nnTCP localhost:123\n')).toEqual([
    '/Users/me/.gemini/antigravity-cli/log/cli-1.log', '/tmp/out.log',
  ])
})

test('Gemini logs count only streaming model turns and show a readable action', () => {
  const noise = '[INFO] POST https://example.test/v1internal:loadCodeAssist\n[DEBUG] https://example.test/v1internal:fetchAvailableModels\n[INFO] https://example.test/v1internal:generateContent\n[ERROR] Request failed\n[2026-10-17] Error: request failed\n'
  expect(parseActionOutput(noise)).toEqual({ count: 0, action: '' })
  expect(parseActionOutput(noise + '[INFO] URL: https://example.test/v1internal:streamGenerateContent\n' + noise + 'URL: https://example.test/v1internal:streamGenerateContent\n')).toEqual({ count: 2, action: 'Gemini turn' })
  expect(parseActionOutput('web search: https://example.test/docs\nexec: curl https://example.test\n')).toEqual({ count: 2, action: 'exec: curl https://example.test' })
})

test('Codex source echoes mentioning the Gemini endpoint follow normal action rules', () => {
  const code = "      if (line.includes('v1internal:streamGenerateContent')) return ['Gemini turn']"
  expect(parseActionOutput('exec\n/bin/zsh -lc "sed -n \'125,140p\' hooks/crew.ts" succeeded in 42ms:\n' + code + '\n')).toEqual({ count: 1, action: 'exec' })
  expect(parseActionOutput(code + '\n')).toEqual({ count: 0, action: '' })
  for (const prefix of ['exec', 'thinking', 'tool', 'codex', 'web search:', '[12:30] Read']) {
    const action = `${prefix} v1internal:streamGenerateContent`
    expect(parseActionOutput(action + '\n')).toEqual({ count: 1, action })
  }
  expect(parseActionOutput('POST https://example.test/v1internal:streamGenerateContent\n')).toEqual({ count: 0, action: '' })
})

test('lines include worker metadata, elapsed time and progress within the width', () => {
  expect(crewLines([worker()], 65_000, 80)[0]?.text).toBe('● codex gpt-6/high 1:05 · 2 actions · exec: build')
  const lines = crewLines([worker({ name: 'Scout', label: 'claude', subagentType: 'Explore', description: 'Find the bug' })], 65_000, 24)
  expect((lines[0]?.text.length ?? 0) <= 24).toBe(true)
  expect(crewLines(Array.from({ length: 8 }, (_, n) => worker({ id: String(n) })), 0, 80).at(-1)?.text).toBe('+2 more')
  expect(lastLine('\n first\n\u001b[32m Last update\u001b[0m\n \n')).toBe('Last update')
})

test('long descriptions leave room for model, effort, elapsed time and progress', () => {
  const text = crewLines([worker({ label: 'claude', description: 'Investigate '.repeat(20), subagentType: 'Explore' })], 65_000, 60)[0]?.text ?? ''
  expect(text.length <= 60).toBe(true)
  expect(text.includes('gpt-6/high 1:05 · step 2 · exec: build')).toBe(true)
})

test('finished workers dim for twenty seconds then vanish; stale workers expire', () => {
  const done = worker({ status: 'completed', finishedAt: 1000 })
  expect(ageWorkers([done], 20_999, 10_000).length).toBe(1)
  expect(ageWorkers([done], 21_000, 10_000)).toEqual([])
  expect(crewLines([done], 10_000, 80)[0]).toEqual({ key: 'one', text: '✓ codex gpt-6/high 0:01 · 2 actions · exec: build', dim: true })
  expect(crewLines([worker({ status: 'failed', finishedAt: 1000 })], 1000, 80)[0]?.text.startsWith('✗')).toBe(true)
  expect(ageWorkers([worker()], 10_000, 10_000)[0]?.progress).toBe('Maximum age reached; completion not observed')
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('idle rendering adds nothing on terminal and desktop', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'crew-board', surface, ...BAND })
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await ui.unmount()
  }
})

test('foreground workers render while awaiting Bash, then disappear after twenty seconds', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => processResult())
  on('tool.call', { tool: 'Bash' }, async (): Promise<ToolCallResult<'Bash'>> => {
    await clock.sleep(6000)
    return { result: { stdout: 'Finished', stderr: '', interrupted: false } }
  })
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  const call = $.tool.call({ tool: 'Bash', tool_use_id: 'fg', command: 'codex exec -m gpt-6 hi' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^● codex gpt-6 0:00/ })).toBeDefined()
  await clock.advance(6000)
  await call
  expect(await ui.find({ type: 'Text', text: /^✓ codex gpt-6 0:06 · 0 actions · Finished/ })).toBeDefined()
  await clock.advance(20_000)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

test('background workers poll output every five seconds and finish from typed notifications', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-task' } }))
  on('process.run', (_, e) => processResult(e.argv[0] === '/bin/sh' ? '999\n' : e.argv[0] === 'ps' ? `999 1 10:00 claude\n45 999 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} agy --model gemini-pro -p hi` : ''))
  let output = '\u001b[32mexec: compile\u001b[0m\nplain output\n'
  on('fs.read', (_, e) => ({ value: e.path === 'out.log' ? 'Plain summary\n' : output }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'bg', command: 'agy --model gemini-pro -p hi > out.log 2>err.log', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^● gemini gemini-pro 0:00 · 0 actions$/ })).toBeDefined()
  await clock.advance(4999)
  expect(await ui.find({ type: 'Text', text: /exec: compile/ })).toBeUndefined()
  await clock.advance(1)
  expect(await ui.find({ type: 'Text', text: /0:05 · 1 actions · exec: compile/ })).toBeDefined()
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /1 actions · exec: compile/ })).toBeDefined()
  output += 'tool: Read src/main.ts\n'
  const notice = await $.ui.mount({ plugin: 'crew-board', surface: 'desktop', component: 'UserMessage', props: {
    text: 'Task completed', isExpanded: false, origin: { kind: 'task-notification' }, task: { id: 'bg-task', status: 'completed', toolUseId: 'bg' },
  } })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^✓ gemini gemini-pro 0:10 · 2 actions · tool: Read src\/main.ts$/ })).toBeDefined()
  await clock.advance(20_000)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await notice.unmount()
  await ui.unmount()
})

test('live logs use one process snapshot, reserve pids and persist discovery through empty polls', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Bash' }, (_, e) => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: e.tool_use_id } }))
  let psCalls = 0, lsofCalls = 0, reads = 0
  on('process.run', (_, e) => {
    expect(e.init?.timeoutMs).toBe(5000)
    let stdout = ''
    if (e.argv[0] === '/bin/sh') {
      expect(e.argv).toEqual(['/bin/sh', '-c', 'echo $PPID'])
      stdout = '6747\n'
    } else if (e.argv[0] === 'ps') {
      if (e.argv[1] === 'eww') {
        expect(e.argv[5]).toBe('41,42')
        return processResult('41 agy --model gemini-pro -p hi\n42 agy --model gemini-pro -p hi')
      }
      psCalls++
      expect(e.argv).toEqual(['ps', '-Ao', 'pid=,ppid=,etime=,command='])
      stdout = `6747 1 10:00 claude\n41 6747 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} agy --model gemini-pro -p hi\n42 6747 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} agy --model gemini-pro -p hi`
    } else {
      lsofCalls++
      expect(e.argv).toEqual(['lsof', '-p', e.argv[2], '-a', '-d', '1,2', '-Fn'])
      if (lsofCalls > 2) stdout = `p${e.argv[2]}\nf2\nn/logs/${e.argv[2]}.log\n`
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => {
    reads++
    // The first discovered log read is empty; the path must still be saved.
    return { value: reads === 1 ? 'Starting up\n' : e.path === '/logs/41.log' ? 'URL: https://example.test/v1internal:streamGenerateContent\n' : 'URL: https://example.test/v1internal:streamGenerateContent\n'.repeat(2) }
  })
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  for (const id of ['live-one', 'live-two']) await $.tool.call({ tool: 'Bash', tool_use_id: id, command: 'agy --model gemini-pro -p hi', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(5000)
  expect(psCalls).toBe(1)
  expect(lsofCalls).toBe(2)
  await clock.advance(5000)
  expect(psCalls).toBe(2)
  expect(lsofCalls).toBe(4)
  expect(await ui.find({ type: 'Text', text: /2 actions · Gemini turn/ })).toBeDefined()
  await clock.advance(5000)
  expect(psCalls).toBe(3)
  expect(lsofCalls).toBe(4)
  expect(await ui.find({ type: 'Text', text: /1 actions · Gemini turn/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 actions · Gemini turn/ })).toBeDefined()
  await ui.unmount()
})

test('failed process discovery skips all log reads and retries on later polls', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'fallback' } }))
  let calls = 0, reads = 0
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/sh') {
      expect(e.argv).toEqual(['/bin/sh', '-c', 'echo $PPID'])
      return { value: { exitCode: 0, stdout: '6747\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    calls++
    throw new Error('Process unavailable')
  })
  on('fs.read', () => { reads++; return { value: 'exec: build\n' } })
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'fallback-call', command: 'codex exec hi 2>err.log', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /0 actions/  })).toBeDefined()
  await clock.advance(5000)
  expect(calls).toBe(2)
  expect(reads).toBe(0)
  expect((await ui.find({ type: 'Text', text: /ps unavailable/ }))?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /0 actions/  })).toBeDefined()
  await ui.unmount()
})

test('live files take priority and discoveries persist even when their action count is lower', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'priority' } }))
  let psCalls = 0, lsofCalls = 0, phase = 0
  on('process.run', (_, e) => {
    if (e.argv[0] === 'ps' && e.argv[1] === 'eww') return processResult('55 codex exec hi')
    let stdout = '', exitCode = 0
    if (e.argv[0] === '/bin/sh') {
      expect(e.argv).toEqual(['/bin/sh', '-c', 'echo $PPID'])
      stdout = '6747\n'
    } else if (e.argv[0] === 'ps') { psCalls++; stdout = '6747 1 10:00 claude\n55 6747 00:05 codex exec hi' }
    else {
      lsofCalls++
      if (lsofCalls === 1) exitCode = 1
      else stdout = 'p55\nf2\nn/logs/live.log\n'
    }
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => {
    if (phase === 3) throw new Error('File gone')
    return { value: e.path === '/logs/live.log' ? 'tool: Read live\n'.repeat(phase === 1 ? 1 : 4) : 'exec: fallback\n'.repeat(phase === 2 ? 10 : 3) }
  })
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'priority-call', command: 'codex exec hi 2>fallback.log', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /3 actions · exec: fallback/ })).toBeDefined()
  phase = 1
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /3 actions · exec: fallback/ })).toBeDefined()
  phase = 2
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /4 actions · tool: Read live/ })).toBeDefined()
  phase = 3
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /4 actions · tool: Read live/ })).toBeDefined()
  expect(psCalls).toBe(4)
  expect(lsofCalls).toBe(2)
  await ui.unmount()
})

test('subagent completion before the launch result is preserved by task ID', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', { tool: 'Agent' }, async () => {
    await clock.sleep(1000)
    return { result: { status: 'async_launched', agentId: 'agent-one', description: 'Find bug', prompt: 'Inspect', outputFile: 'agent.log' } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  const call = $.tool.call({ tool: 'Agent', tool_use_id: 'agent-call', description: 'Find bug', name: 'Scout', prompt: 'Inspect', subagent_type: 'Explore', model: 'haiku' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /● claude Scout \[Explore\] haiku/ })).toBeDefined()
  await $.turn.complete({ agentId: 'agent-one', turnId: 'child-turn', answer: 'Found bug', reason: 'answer', durationMs: 500, isAborted: false })
  await clock.advance(1000)
  await call
  expect(await ui.find({ type: 'Text', text: /✓ claude Scout \[Explore\] haiku 0:00 · step 0 · Found bug/ })).toBeDefined()
  await ui.unmount()
})

test('a denied external run finishes with a failure mark', async ($, on) => {
  mock.clock(on)
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'Not allowed' }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'denied', command: 'claude -p hi' })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^✗ claude-cli 0:00 · 0 actions · Not allowed$/ })).toBeDefined()
  await ui.unmount()
})

test('unobserved background completion expires at the configured maximum age', { options: { maxAgeSeconds: 2 } }, async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => processResult())
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'lost' } }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'lost-call', command: 'codex exec hi' })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /^✗ codex 0:02 · 0 actions · Maximum age reached/ })).toBeDefined()
  await clock.advance(20_000)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})


test('ANSI colors, OSC links and control codes are stripped before matching and display', () => {
  expect(stripAnsi('\u001b[32mexec: build\u001b[0m')).toBe('exec: build')
  expect(stripAnsi('\u001b]8;;https://example.com\u0007Read\u001b]8;;\u001b\\')).toBe('Read')
  expect(lastLine('noise\n\u001b[31mtool: Read file.ts\u001b[0m\n')).toBe('tool: Read file.ts')
})

test('only action prefixes count, including repeated actions on separate lines', () => {
  const output = 'header\nweb search: docs\nexec: bash test.sh\ntool Read\nthinking\ncodex\n[12:30] Read README\nexec: bash test.sh\nsucceeded\nexecution time\ntoolbox\n[]\n'
  expect(parseActionOutput(output)).toEqual({ count: 7, action: 'exec: bash test.sh' })
  expect(parseActionOutput(output)).toEqual({ count: 7, action: 'exec: bash test.sh' })
  expect(parseActionOutput('\u001b[32mtool: Read main.ts\u001b[0m\nignored')).toEqual({ count: 1, action: 'tool: Read main.ts' })
  expect(parseActionOutput('ordinary output\n')).toEqual({ count: 0, action: '' })
  expect(parseActionOutput('[ waiting for tool]\n')).toEqual({ count: 1, action: '[ waiting for tool]' })
})

test('step labels shorten Bash commands, file paths and Agent descriptions', () => {
  expect(stepLabel(3, { tool: 'Bash', command: 'echo ' + 'x'.repeat(50) })).toBe('step 3 · Bash: echo ' + 'x'.repeat(35))
  for (const tool of ['Read', 'Edit', 'Write']) {
    expect(stepLabel(4, { tool, file_path: '/project/src/main.ts' })).toBe('step 4 · ' + tool + ': main.ts')
  }
  expect(stepLabel(5, { tool: 'Agent', description: 'Find the bug' })).toBe('step 5 · Agent: Find the bug')
  expect(stepLabel(6, { tool: 'Grep' })).toBe('step 6 · Grep')
})

test('subagent steps bind even before the Agent launch returns and stay isolated', () => {
  let state = { ...emptyBoard(0), workers: [worker({ id: 'child', label: 'claude', count: 0, action: '', toolUseId: 'launch' }), worker({ id: 'other', label: 'claude', taskId: 'other-agent', count: 0, action: '' })] }
  state = recordAgentStep(state, 'child-agent', { tool: 'Read', file_path: '/src/main.ts' })
  state = bindTask(state, 'child', 'child-agent')
  state = recordAgentStep(state, 'child-agent', { tool: 'Bash', command: 'npm test' })
  expect(crewLines(state.workers, 3000, 100)[0]?.text).toBe('● claude gpt-6/high 0:03 · step 2 · Bash: npm test')
  expect(state.workers[1]?.count).toBe(0)
  state = completeWorkers(state, { taskId: 'child-agent', at: 4000, status: 'completed', progress: 'Done' })
  state = recordAgentStep(state, 'child-agent', { tool: 'Write', file_path: '/late.ts' })
  expect(crewLines(state.workers, 5000, 100).find(line => line.key === 'child')?.text).toBe('✓ claude gpt-6/high 0:04 · step 2 · Bash: npm test')
})

test('a finished external row keeps its final action count and latest action', () => {
  const finished = completeWorkers({ ...emptyBoard(0), workers: [worker({ toolUseId: 'run', count: 9, action: 'exec: bash tests/agents-check.test.sh' })] }, { toolUseId: 'run', at: 192000, status: 'completed', progress: 'Finished' })
  expect(crewLines(finished.workers, 200000, 100)[0]).toEqual({ key: 'one', text: '✓ codex gpt-6/high 3:12 · 9 actions · exec: bash tests/agents-check.test.sh', dim: true })
})


test('spawn binds child tool calls before the Agent result returns', async ($, on) => {
  const clock = mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'live-child', model: 'haiku' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Agent' }, async () => {
    await clock.sleep(6000)
    return { result: { status: 'async_launched', agentId: 'live-child', description: 'Inspect', prompt: 'Inspect', outputFile: 'child.log' } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  const launch = $.tool.call({ tool: 'Agent', tool_use_id: 'live-launch', description: 'Inspect', prompt: 'Inspect', subagent_type: 'Explore', model: 'haiku' })
  await clock.settle()
  await $.agent.spawn({ tool_use_id: 'live-launch', description: 'Inspect', prompt: 'Inspect', subagentType: 'Explore', parentModel: 'opus', provider: { plugin: 'engine', tier: 'core' }, background: true, fork: false })
  const childCall = { tool: 'Bash' as const, tool_use_id: 'child-bash', agentId: 'live-child', command: 'npm test' }
  await $.tool.call(childCall)
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /step 1 · Bash: npm test/ })).toBeDefined()
  await $.turn.complete({ agentId: 'live-child', turnId: 'live-turn', answer: 'Done', reason: 'answer', durationMs: 1000, isAborted: false })
  expect(await ui.find({ type: 'Text', text: /^✓ claude.*step 1 · Bash: npm test/ })).toBeDefined()
  await clock.advance(6000)
  await launch
  await ui.unmount()
})


const chain = (elapsed = '00:05') => [
  '6747 1 01:00 claude bg-spare session',
  '8000 6747 00:50 /bin/zsh -c source /tmp/shell-snapshots/snapshot.sh',
  '8100 8000 00:40 /bin/zsh run-example.sh',
  '8200 8100 00:30 /bin/zsh chain-b.sh',
  `9376 9375 ${elapsed} /opt/homebrew/vendor/bin/codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" -o out.md hello`,
  `9375 8200 ${elapsed} node /opt/homebrew/bin/codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" -o out.md hello`,
  `9900 1 ${elapsed} codex exec -m outside hello`,
].join('\n')

test('parsePs parses elapsed time once and ignores malformed rows', () => {
  expect(parsePs('  12  1  1-02:03:04 /bin/zsh "a b.sh"\n0 1 00:01 bad\n13 1 02:99 bad\nheader\n')).toEqual([
    { pid: 12, ppid: 1, elapsed: 93_784_000, command: '/bin/zsh "a b.sh"' },
  ])
})

test('sessionRoot accepts Claude directly or walks to the nearest Claude ancestor', () => {
  const rows = parsePs(chain() + '\n7000 6747 00:30 /bin/claude.exe -p nested\n7001 7000 00:20 node mod.js')
  expect(sessionRoot(rows, 6747)).toBe(6747)
  expect(sessionRoot(rows, 8200)).toBe(6747)
  expect(sessionRoot(rows, 7001)).toBe(7000)
  expect(sessionRoot(rows, undefined)).toBeUndefined()
  expect(sessionRoot(rows, 9900)).toBeUndefined()
  expect(sessionRoot(parsePs('1 2 00:01 node a\n2 1 00:01 node b'), 1)).toBeUndefined()
})

test('discoverRuns finds the session wrapper and nearest script, with command metadata', () => {
  const found = discoverRuns(parsePs(chain()), 6747, [], 10_000)
  expect(found).toEqual([{
    id: 'proc-9375', pid: 9375, label: 'codex', model: 'gpt-6.1-sol', effort: 'high',
    outputPaths: ['out.md'], description: 'chain-b.sh', startedAt: 5000, lastGrowthAt: 5000,
    status: 'running', progress: '', count: 0, action: '',
  }])
  expect(discoverRuns(parsePs(chain()), undefined, [], 10_000)).toEqual([])
})

test('discoverRuns skips bound pids and nearby unbound rows of the same label', () => {
  const rows = parsePs(chain())
  expect(discoverRuns(rows, 6747, [worker({ pid: 9375 })], 10_000)).toEqual([])
  expect(discoverRuns(rows, 6747, [worker({ startedAt: 20_000 })], 10_000)).toEqual([])
  expect(discoverRuns(rows, 6747, [worker({ startedAt: 20_001 })], 10_000).length).toBe(1)
  expect(discoverRuns(rows, 6747, [worker({ status: 'completed' })], 10_000).length).toBe(1)
  expect(discoverRuns(rows, 6747, [worker({ label: 'gemini' })], 10_000).length).toBe(1)
})

test('discovery shares candidate rules and excludes shells, app-server and code-mode hosts', () => {
  const rows = parsePs([
    '1 0 10:00 /bin/claude',
    '2 1 00:01 /bin/zsh -c codex exec hi',
    '3 1 00:01 codex app-server exec',
    '4 1 00:01 codex-code-mode-host exec',
    '5 1 00:01 echo codex exec',
    '6 1 00:01 agy --model gemini-pro -p hi',
    '7 1 00:01 /bin/claude --print --model opus hi',
    '8 1 00:01 codex hi',
  ].join('\n'))
  const found = discoverRuns(rows, 1, [], 5000)
  expect(found.map(one => [one.pid, one.label, one.model, one.description])).toEqual([
    [6, 'gemini', 'gemini-pro', undefined], [7, 'claude-cli', 'opus', undefined],
  ])
})

test('only discovered workers complete when their pid disappears, then age out normally', () => {
  const discovered = discoverRuns(parsePs(chain()), 6747, [], 10_000)[0]!
  const bash = worker({ id: 'bash', toolUseId: 'bash', pid: 88 })
  expect(completeDiscovered([discovered], parsePs(chain()), 11_000)[0]?.status).toBe('running')
  const ended = completeDiscovered([discovered, bash], [], 12_000)
  expect(ended[0]?.status).toBe('completed')
  expect(ended[0]?.finishedAt).toBe(12_000)
  expect(ended[0]?.progress).toBe('process ended')
  expect(ended[1]).toEqual(bash)
  expect(crewLines([ended[0]!], 13_000, 100)[0]?.dim).toBe(true)
  expect(ageWorkers([ended[0]!], 32_000, 7_200_000)).toEqual([])
})

test('stalledFor uses growth or start time and only running external workers', () => {
  expect(stalledFor(worker(), 9 * 60_000, 8 * 60_000)).toBe(9 * 60_000)
  expect(stalledFor(worker(), 7 * 60_000, 8 * 60_000)).toBe(0)
  expect(stalledFor(worker(), 8 * 60_000, 8 * 60_000)).toBe(8 * 60_000)
  expect(stalledFor(worker({ lastGrowthAt: 60_000 }), 9 * 60_000, 8 * 60_000)).toBe(8 * 60_000)
  expect(stalledFor(worker({ label: 'claude' }), 9 * 60_000, 8 * 60_000)).toBe(0)
  expect(stalledFor(worker({ status: 'completed' }), 9 * 60_000, 8 * 60_000)).toBe(0)
  expect(stalledFor(worker({ label: 'claude-cli' }), 9 * 60_000, 8 * 60_000)).toBe(9 * 60_000)
})

test('observing growth in bytes or actions resets both stall flags, unchanged output does not', () => {
  const first = observeOutput(worker(), 0, 5000)
  expect(first.lastGrowthAt).toBe(5000)
  const stalled = { ...first, stallNotified: true, stallReported: true }
  expect(observeOutput(stalled, 0, 10_000)).toEqual(stalled)
  const grew = observeOutput(stalled, 20, 15_000)
  expect(grew.lastGrowthAt).toBe(15_000)
  expect(grew.observedBytes).toBe(20)
  expect(grew.stallNotified).toBe(false)
  expect(grew.stallReported).toBe(false)
  const action = observeOutput({ ...grew, stallNotified: true, stallReported: true }, 10, 20_000, { count: 3, action: 'exec: test' })
  expect(action.lastGrowthAt).toBe(20_000)
  expect(action.count).toBe(3)
  expect(action.stallNotified).toBe(false)
  expect(action.stallReported).toBe(false)
  const shrank = observeOutput(action, 5, 25_000, { count: 1, action: 'exec: old' })
  expect(shrank.count).toBe(3)
  expect(shrank.lastGrowthAt).toBe(20_000)
})

test('stalled rows show the warning after elapsed time without dimming or exceeding width', () => {
  const lines = crewLines([worker()], 9 * 60_000, 100)
  expect(lines[0]?.text).toBe('● codex gpt-6/high 9:00 ⚠ stalled 9m · 2 actions · exec: build')
  expect(lines[0]?.dim).toBe(false)
  expect((crewLines([worker({ description: 'long '.repeat(50) })], 9 * 60_000, 60)[0]?.text.length ?? 0) <= 60).toBe(true)
  expect(crewLines([worker()], 9 * 60_000, 100, 10 * 60_000)[0]?.text.includes('stalled')).toBe(false)
})


test('script discovery uses the shell parent pid without process.pid and caches it per session', { options: { showElsewhere: false } }, async ($, on) => {
  const clock = mock.clock(on)
  expect((globalThis as { process?: { pid?: number } }).process?.pid).toBeUndefined()
  let hostPidCalls = 0
  on('process.run', (_, e) => {
    expect(e.init?.timeoutMs).toBe(5000)
    let stdout = ''
    if (e.argv[0] === '/bin/sh') {
      expect(e.argv).toEqual(['/bin/sh', '-c', 'echo $PPID'])
      hostPidCalls++
      stdout = '6747\n'
    } else if (e.argv[0] === 'ps') {
      if (e.argv[1] === 'eww') {
        expect(e.argv).toEqual(['ps', 'eww', '-o', 'pid=,command=', '-p', '9375,9900'])
        return processResult('9900 codex exec -m outside hello')
      }
      expect(e.argv).toEqual(['ps', '-Ao', 'pid=,ppid=,etime=,command='])
      stdout = chain()
    } else {
      expect(e.argv).toEqual(['lsof', '-p', '9375', '-a', '-d', '1,2', '-Fn'])
      stdout = 'p9375\nf2\nn/logs/script.log\n'
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => ({ value: e.path === '/logs/script.log' ? 'exec: from script\n' : '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /^● codex chain-b\.sh gpt-6\.1-sol\/high.*1 actions · exec: from script$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /outside/ })).toBeUndefined()
  expect(hostPidCalls).toBe(1)
  await clock.advance(5000)
  expect(hostPidCalls).toBe(1)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  expect(hostPidCalls).toBe(2)
  expect(await ui.find({ type: 'Text', text: /^● codex/ })).toBeDefined()
  await ui.unmount()
})

test('idle polls tolerate no process global; discovered rows survive ps failures and complete on exit', { options: { showElsewhere: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const selfPid = 6747
  let alive = true, failedPs = false, psCalls = 0
  on('process.run', (_, e) => {
    if (e.argv[0] === 'ps' && e.argv[1] === 'eww') return processResult('9375 node /opt/homebrew/bin/codex exec -m gpt-6.1-sol hi')
    let stdout = ''
    if (e.argv[0] === '/bin/sh') return processResult('6747\n')
    if (e.argv[0] === 'ps') {
      psCalls++
      if (failedPs) throw new Error('ps unavailable')
      stdout = `${selfPid} 1 10:00 /bin/claude bg-spare session\n` + (alive ? [
        `8200 ${selfPid} 00:30 /bin/zsh chain-b.sh`,
        `9375 8200 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} node /opt/homebrew/bin/codex exec -m gpt-6.1-sol hi`,
        `9376 9375 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} /vendor/bin/codex exec -m gpt-6.1-sol hi`,
      ].join('\n') : '')
    } else if (e.argv[0] === 'lsof') stdout = 'p9375\nf2\nn/logs/script.log\n'
    else throw new Error('Unexpected process command')
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', () => ({ value: 'exec: from script\n' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(5000)
  expect(psCalls).toBe(1)
  expect(await ui.find({ type: 'Text', text: /^● codex/ })).toBeDefined()
  await clock.advance(5000)
  failedPs = true
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /^● codex/ })).toBeDefined()
  failedPs = false; alive = false
  await clock.advance(5000)
  expect(psCalls).toBe(4)
  expect(await ui.find({ type: 'Text', text: /^✓ codex/ })).toBeDefined()
  await clock.advance(20_000)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

test('watchdog notifies once, adds user-message context once per stall without changing the system prompt, and resets on any file growth', { options: { stallMinutes: 0.1 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/test home' })
  let extra = '', notifications = 0
  let existingContext: string[] | undefined = ['Existing context']
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'watchdog' } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'uname') return processResult('Darwin\n')
    if (e.argv[0] === '/bin/sh' && e.argv[2] !== 'echo $PPID') {
      expect(e.argv).toEqual(['/bin/sh', '-c', 'mkdir -p "$1" && set -C && : > "$1/$2"', 'sh', '/Users/test home/.claude/crew-board/stall-markers', '75-0'])
      return processResult()
    }
    if (e.argv[0] === '/bin/sh') {
      expect(e.argv).toEqual(['/bin/sh', '-c', 'echo $PPID'])
      return { value: { exitCode: 0, stdout: '6747\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'osascript') {
      notifications++
      expect(e.init?.timeoutMs).toBe(5000)
      expect(e.argv[7]).toBe('codex gpt-6 - no new output for 0 min')
      throw new Error('Notifications unavailable')
    }
    if (e.argv[0] === 'lsof') return processResult()
    expect(e.argv[0]).toBe('ps')
    return { value: { exitCode: 0, stdout: `6747 1 10:00 claude\n75 6747 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} codex exec -m gpt-6 hi`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/err.log') ? 'exec: build\n' : extra }))
  on('prompt.compose', () => ({ sections: [{ id: 'system', text: 'Original', scope: 'shared' }] }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: existingContext, sessionTitle: 'Original title' }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'watchdog-call', command: 'codex exec -m gpt-6 hi 2>err.log >out.log', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(11_000)
  expect(notifications).toBe(1)
  expect(await ui.find({ type: 'Text', text: /0:11 ⚠ stalled 0m · 1 actions/ })).toBeDefined()
  const compose = (surfaces: ('terminal' | 'desktop')[], traits: ('print' | 'analysis')[] = []) => $.prompt.compose({
    model: 'opus', promptModel: 'opus', surfaces, traits, tools: [], outputStyle: null,
  })
  const unchangedPrompt = { sections: [{ id: 'system', text: 'Original', scope: 'shared' }] }
  expect(await compose([])).toEqual(unchangedPrompt)
  expect(await compose(['terminal'], ['print'])).toEqual(unchangedPrompt)
  expect(await compose(['terminal'], ['analysis'])).toEqual(unchangedPrompt)
  expect(await compose(['terminal'])).toEqual(unchangedPrompt)
  for (const source of ['sdk', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event'] as const) {
    expect(await $.classic.UserPromptSubmit({ prompt: 'Continue', source })).toEqual({
      additionalContext: ['Existing context'], sessionTitle: 'Original title',
    })
  }
  const stallContext = 'crew-board: codex gpt-6 has written no new output for 0 min; pid 75; log err.log. Check it; do not kill by name.'
  expect(await $.classic.UserPromptSubmit({ prompt: 'Continue', source: 'user' })).toEqual({
    additionalContext: ['Existing context', stallContext], sessionTitle: 'Original title',
  })
  expect(await $.classic.UserPromptSubmit({ prompt: 'Continue', source: 'user' })).toEqual({
    additionalContext: ['Existing context'], sessionTitle: 'Original title',
  })
  expect(await compose(['terminal'])).toEqual(unchangedPrompt)
  await clock.advance(3000)
  expect(notifications).toBe(1)
  extra = 'ordinary output with no new action\n'
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /stalled/ })).toBeUndefined()
  expect((await $.classic.UserPromptSubmit({ prompt: 'Continue', source: 'user' })).additionalContext).toEqual(['Existing context'])
  await clock.advance(6000)
  expect(notifications).toBe(2)
  expect(await compose(['desktop'])).toEqual(unchangedPrompt)
  existingContext = undefined
  expect(await $.classic.UserPromptSubmit({ prompt: 'Continue' })).toEqual({
    additionalContext: [stallContext], sessionTitle: 'Original title',
  })
  expect((await $.classic.UserPromptSubmit({ prompt: 'Continue' })).additionalContext).toBeUndefined()
  await ui.unmount()
})


test('binding reserves top-most pids before discovery and leaves notification-based workers running', () => {
  const rows = parsePs(chain())
  const pending = worker({ startedAt: 5000, model: 'gpt-6.1-sol', toolUseId: 'launch' })
  const bound = bindProcesses(rows, [pending, worker({ id: 'other', startedAt: 5000, model: 'gpt-6.1-sol' })], 10_000, new Set([9375, 9376]))
  expect(bound[0]?.pid).toBe(9375)
  expect(bound[1]?.pid).toBeUndefined()
  expect(discoverRuns(rows, 6747, bound, 10_000)).toEqual([])
  expect(completeDiscovered(bound, [], 20_000)[0]?.status).toBe('running')
  expect(pending.pid).toBeUndefined()
})

test('stall notes include script, pid and the preferred live log', () => {
  expect(stallNote(worker({ pid: 9375, description: 'chain-b.sh', livePaths: ['/path/err.log'], outputPaths: ['fallback.log'] }), 9 * 60_000))
    .toBe('crew-board: codex gpt-6 (chain-b.sh) has written no new output for 9 min; pid 9375; log /path/err.log. Check it; do not kill by name.')
})


const elsewhereFixture = [
  '50640 1 01:10:48 /bin/zsh /home/example/Projects/example-project/jobs/chain.sh',
  '93414 50640 03:54 node /opt/homebrew/bin/codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /home/example/Projects/example-project/worktree --add-dir /home/example/Projects/example-project/jobs -m gpt-6.1-sol -c model_reasoning_effort=high "prompt"',
  '93415 93414 03:54 /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex exec -C /home/example/Projects/example-project/worktree -m gpt-6.1-sol',
  '94204 93415 03:43 /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host',
  '2203 749 02:36:33 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c forced_login_method="chatgpt" exec-server --remote https://x',
  '26479 1 2-01:39:34 agy',
  '69339 69320 07:17 agy --model gemini-4-argon-high --effort high --sandbox --print-timeout 30m -p Read context.md in this folder and answer it fully.',
].join('\n')

test('elsewhere discovers exactly the detached wrapper and print Gemini from the Mac fixture', () => {
  const now = 1_000_000
  const found = discoverElsewhere(parsePs(elsewhereFixture), 7000, [], now)
  expect(found).toEqual([
    worker({ id: 'else-93414', pid: 93414, scope: 'elsewhere', model: 'gpt-6.1-sol', effort: 'high',
      folder: '/home/example/Projects/example-project/worktree', description: 'chain.sh',
      startedAt: now - 234_000, lastGrowthAt: now - 234_000, count: 0, action: '' }),
    worker({ id: 'else-69339', pid: 69339, scope: 'elsewhere', label: 'gemini', model: 'gemini-4-argon-high', effort: 'high',
      startedAt: now - 437_000, lastGrowthAt: now - 437_000, count: 0, action: '' }),
  ])
  expect(discoverElsewhere(parsePs(elsewhereFixture), undefined, [], now)).toEqual(found)
})

test('elsewhere excludes own trees and bound pids and accepts only noninteractive helper argv', () => {
  const rows = parsePs(elsewhereFixture + '\n' + [
    '7 1 10:00 claude', '8 7 01:00 /bin/zsh own.sh', '9 8 00:30 codex exec own',
    '10 1 00:30 codex exec resume abc --cd "/a/two words"',
    '11 1 00:30 codex exec-server', '12 1 00:30 agy --print hi',
    '13 1 00:30 /Applications/ChatGPT.app/Contents/bin/codex exec hi',
    '14 1 00:30 codex app-server exec', '15 1 00:30 /bin/sh -c "codex exec hi"',
    '16 1 00:30 claude hi', '17 1 00:30 claude -p hi', '18 1 00:30 agy hi',
  ].join('\n'))
  const found = discoverElsewhere(rows, 7, [worker({ pid: 93414 })], 1_000_000)
  expect(found.map(one => [one.pid, one.label, one.folder])).toEqual([
    [69339, 'gemini', undefined], [10, 'codex', '/a/two words'], [12, 'gemini', undefined], [17, 'claude-cli', undefined],
  ])
})

test('elsewhere rows follow own rows, sort by folder, shorten paths and have a separate four-row cap', () => {
  const own = Array.from({ length: 7 }, (_, n) => worker({ id: 'own-' + n }))
  const other = ['z', 'b', 'a', 'd', 'c'].map((folder, n) => worker({ id: 'else-' + n, scope: 'elsewhere', folder: '/home/example/project/' + folder, description: 'chain.sh' }))
  const lines = crewLines([...other, ...own], 234_000, 160)
  expect(lines.map(line => line.key)).toEqual(['own-0', 'own-1', 'own-2', 'own-3', 'own-4', 'own-5', 'more', 'else-2', 'else-1', 'else-4', 'else-3', 'more-elsewhere'])
  expect(lines[7]?.text).toBe('◦ codex project/a · chain.sh gpt-6/high 3:54 · 2 actions · exec: build')
  expect(lines.at(-1)).toEqual({ key: 'more-elsewhere', text: '+1 more elsewhere', dim: true })
  expect(crewLines(other, 9 * 60_000, 160)[0]?.text.includes('⚠ stalled 9m')).toBe(true)
  expect(crewLines(other, 9 * 60_000, 50).every(line => line.text.length <= 50)).toBe(true)
})

test('elsewhere completion dims for twenty seconds and keeps the final action', () => {
  const found = discoverElsewhere(parsePs(elsewhereFixture), undefined, [], 1_000_000)
  const ended = completeDiscovered(found, [], 1_001_000)
  expect(ended.map(one => [one.status, one.progress])).toEqual([['completed', 'process ended'], ['completed', 'process ended']])
  expect(crewLines(ended, 1_002_000, 160).every(line => line.dim)).toBe(true)
  expect(ageWorkers(ended, 1_021_000, 7_200_000)).toEqual([])
})


const processResult = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('elsewhere polling caches cwd and unchanged file sizes, tolerates ps failure, then completes', { options: { showElsewhere: true } }, async ($, on) => {
  const clock = mock.clock(on)
  let alive = true, failPs = false, cwdCalls = 0, logCalls = 0, reads = 0, content = 'exec: first\n'
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/sh') return processResult('999\n')
    if (e.argv[0] === 'ps') {
      if (failPs) throw new Error('ps unavailable')
      return processResult(alive ? `45 1 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} codex exec -m gpt-6 hi` : '')
    }
    if (e.argv.includes('cwd')) {
      expect(e.argv).toEqual(['lsof', '-a', '-p', '45', '-d', 'cwd', '-Fn'])
      cwdCalls++
      return processResult('p45\nn/home/example/project/worktree\n')
    }
    expect(e.argv).toEqual(['lsof', '-p', '45', '-a', '-d', '1,2', '-Fn'])
    logCalls++
    return processResult('n/logs/45.log\n')
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: content.length, mtimeMs: 1000, isLink: false } }))
  on('fs.read', () => { reads++; return { value: content } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text', text: /^◦ codex project\/worktree gpt-6.*1 actions · exec: first$/ })).toBeDefined()
  expect(cwdCalls).toBe(1)
  expect(logCalls).toBe(1)
  expect(reads).toBe(1)
  content += 'tool: second\n'
  await clock.advance(5000)
  expect(reads).toBe(2)
  expect(await ui.find({ type: 'Text', text: /2 actions · tool: second$/ })).toBeDefined()
  failPs = true
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /tool: second$/ })).toBeDefined()
  failPs = false; alive = false
  await clock.advance(5000)
  expect((await ui.find({ type: 'Text', text: /tool: second$/ }))?.props.dimColor).toBe(true)
  await clock.advance(20_000)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

test('showElsewhere false skips machine helpers and their lsof calls entirely', { options: { showElsewhere: false } }, async ($, on) => {
  const clock = mock.clock(on)
  let lsofCalls = 0
  on('process.run', (_, e) => {
    if (e.argv[0] === 'lsof') lsofCalls++
    return processResult(e.argv[0] === 'ps' ? elsewhereFixture : '999\n')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(10_000)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  expect(lsofCalls).toBe(0)
  await ui.unmount()
})

test('two windows claim the same process marker once and elsewhere stalls never enter Claude context', { options: { stallMinutes: 0.1, showElsewhere: true } }, async ($, on) => {
  const clock = mock.clock(on)
  const markers = new Set<string>()
  let notifications = 0, claims = 0
  on('process.run', async ($, e) => {
    if (e.argv[0] === 'uname') return processResult('Darwin\n')
    if (e.argv[0] === 'ps') {
      const elapsed = Math.floor(clock.now() / 1000)
      return processResult(`45 1 00:${String(elapsed).padStart(2, '0')} codex exec -C /project/worktree hi`)
    }
    if (e.argv[0] === 'lsof') return processResult('n/logs/45.log\n')
    if (e.argv[0] === 'osascript') { notifications++; return processResult() }
    if (e.argv[2] === 'echo $PPID') return processResult('999\n')
    expect(e.argv[0]).toBe('/bin/sh')
    expect(e.argv[2]).toBe('mkdir -p "$1" && set -C && : > "$1/$2"')
    expect(e.argv[4]?.endsWith('/.claude/crew-board/stall-markers')).toBe(true)
    expect(e.argv[5]).toBe('45-0')
    claims++
    const name = e.argv[5]!
    const existed = markers.has(name)
    markers.add(name)
    return processResult('', existed ? 1 : 0)
  })
  mock.env(on, { HOME: '/Users/test home' })
  on('fs.read', () => ({ value: 'exec: unchanged\n' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'window-one' }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['Existing context'] }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(11_000)
  expect(notifications).toBe(1)
  expect(await ui.find({ type: 'Text', text: /^◦.*⚠ stalled/ })).toBeDefined()
  expect((await $.classic.UserPromptSubmit({ prompt: 'Continue', source: 'user' })).additionalContext).toEqual(['Existing context'])
  // A fresh session has independent board flags, like another window, but shares the marker directory.
  await $.session.end({ reason: 'other', sessionId: 'window-one', resume: { id: 'window-one' } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(11_000)
  expect(claims).toBe(2)
  expect(notifications).toBe(1)
  expect((await $.classic.UserPromptSubmit({ prompt: 'Continue', source: 'user' })).additionalContext).toEqual(['Existing context'])
  await ui.unmount()
})


test('an existing marker also suppresses own helper notifications while preserving its Claude note', { options: { stallMinutes: 0.1, showElsewhere: false } }, async ($, on) => {
  const clock = mock.clock(on)
  let claims = 0, notifications = 0
  mock.env(on, { HOME: '/Users/test home' })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'own-marked' } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'uname') return processResult('Darwin\n')
    if (e.argv[0] === 'ps') return processResult(`999 1 10:00 claude\n75 999 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} codex exec hi`)
    if (e.argv[0] === 'lsof') return processResult()
    if (e.argv[0] === 'osascript') { notifications++; return processResult() }
    if (e.argv[2] === 'echo $PPID') return processResult('999\n')
    expect(e.argv).toEqual(['/bin/sh', '-c', 'mkdir -p "$1" && set -C && : > "$1/$2"', 'sh', '/Users/test home/.claude/crew-board/stall-markers', '75-0'])
    claims++
    return processResult('', 1)
  })
  on('fs.read', () => ({ value: 'exec: unchanged\n' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'own-marked-call', command: 'codex exec hi >out.log', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(15_000)
  expect(claims).toBe(1)
  expect(notifications).toBe(0)
  expect((await $.classic.UserPromptSubmit({ prompt: 'Continue' })).additionalContext?.[0]?.includes('pid 75')).toBe(true)
  await ui.unmount()
})


test('own marker uses process birth shared with elsewhere rather than the earlier tool launch', { options: { stallMinutes: 0.1 } }, async ($, on) => {
  const clock = mock.clock(on)
  let claims = 0, notifications = 0
  mock.env(on, { HOME: '/Users/test' })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'delayed-process' } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'uname') return processResult('Darwin\n')
    if (e.argv[0] === 'ps') return processResult(`999 1 10:00 claude\n75 999 00:${String(Math.floor(clock.now() / 1000) - 3).padStart(2, '0')} codex exec hi`)
    if (e.argv[0] === 'lsof') return processResult()
    if (e.argv[0] === 'osascript') { notifications++; return processResult() }
    if (e.argv[2] === 'echo $PPID') return processResult('999\n')
    // The other window's elsewhere row already claimed pid 75, born three seconds after the tool launch.
    expect(e.argv[5]).toBe('75-3')
    claims++
    return processResult('', 1)
  })
  on('fs.read', () => ({ value: 'exec: unchanged\n' }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'delayed-call', command: 'codex exec hi >out.log', run_in_background: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(11_000)
  expect(claims).toBe(1)
  expect(notifications).toBe(0)
  expect(await ui.find({ type: 'Text', text: /^● codex 0:11 ⚠ stalled/ })).toBeDefined()
  await ui.unmount()
})


const detachedChain = (elapsed: number) => [
  '97851 1 10:00 claude example session',
  `38998 1 01:${String(elapsed).padStart(2, '0')} /bin/zsh /home/example/jobs/chain-c.sh`,
  `39072 38998 00:${String(elapsed).padStart(2, '0')} node /opt/homebrew/bin/codex exec -m gpt-6.1-sol hi`,
  `39073 39072 00:${String(elapsed).padStart(2, '0')} /vendor/bin/codex exec -m gpt-6.1-sol hi`,
].join('\n')

test('parseEnvOwners retains only complete candidate session tokens, ignoring other variables', () => {
  const rows = parsePs('39072 1 00:05 codex exec -c model_reasoning_effort=high hi\n39073 1 00:05 agy -p hi\n39074 1 00:05 claude -p hi')
  const output = [
    '39072 codex exec -c model_reasoning_effort=high hi TOKEN=abc=def== CLAUDE_PID=97851 CLAUDE_CODE_SESSION_ID=12345678-1234-1234-1234-123456789abc',
    '39073 agy -p hi TOKEN=CLAUDE_CODE_SESSION_ID=12345678-1234-1234-1234-123456789abc',
    '39074 claude -p hi CLAUDE_CODE_SESSION_ID=12345678-1234-1234-1234-123456789abcZ',
    '99 unrelated CLAUDE_CODE_SESSION_ID=12345678-1234-1234-1234-123456789abc',
  ].join('\n')
  expect([...parseEnvOwners(output, rows)]).toEqual([
    [39072, { sessionId: '12345678-1234-1234-1234-123456789abc' }], [39073, {}], [39074, {}],
  ])
})

test('jobRoot keeps detached siblings together and stops below Claude or init', () => {
  const rows = parsePs([
    '1 0 10:00 /sbin/launchd',
    '10 1 01:00 /bin/zsh detached.sh', '11 10 00:10 node codex exec hi', '12 11 00:10 /vendor/codex exec hi', '13 10 00:05 agy -p hi',
    '20 1 10:00 /opt/bin/claude', '21 20 01:00 /bin/zsh attached.sh', '22 21 00:10 agy -p hi',
    '30 99 00:05 agy -p missing-parent', '40 41 00:05 node cycle', '41 40 00:05 /bin/sh cycle',
  ].join('\n'))
  expect(jobRoot(rows, 11)?.pid).toBe(10)
  expect(jobRoot(rows, 12)?.pid).toBe(10)
  expect(jobRoot(rows, 13)?.pid).toBe(10)
  expect(jobRoot(rows, 22)?.pid).toBe(21)
  expect(jobRoot(rows, 30)?.pid).toBe(30)
  expect(jobRoot(rows, 40)).toBeUndefined()
  expect(jobRoot(rows, 1)).toBeUndefined()
  expect(jobRoot(rows, 404)).toBeUndefined()
})

test('environment probes traverse Apple ancestors but query only unread non-Apple descendants', () => {
  const rows = parsePs([
    '10 1 01:00 /bin/zsh chain.sh',
    '11 10 00:10 /bin/sh helper.sh', '12 10 00:10 /usr/bin/python helper.py',
    '13 10 00:10 /sbin/helper', '14 10 00:10 /usr/sbin/helper', '15 10 00:10 /System/Library/helper',
    '21 11 00:05 node helper.js', '22 12 00:05 /opt/bin/python helper.py', '23 15 00:05 /vendor/bin/codex exec hi',
    '24 10 00:05 "/usr/binning/my tool" hi', '99 1 00:05 node unrelated.js',
  ].join('\n'))
  expect(envProbePids(rows, 10, new Set([21]))).toEqual([24, 22, 23])
})

test('environment probes limit each root to five previously unqueried descendants per poll', () => {
  const rows = parsePs(['10 1 01:00 /bin/zsh chain.sh',
    ...Array.from({ length: 8 }, (_, i) => `${20 + i} 10 00:05 /opt/bin/python helper.py`),
  ].join('\n'))
  expect(envProbePids(rows, 10, new Set())).toEqual([20, 21, 22, 23, 24])
  expect(envProbePids(rows, 10, new Set([20, 21, 22, 23, 24]))).toEqual([25, 26, 27])
})

const hiddenEnvScenarios = [
  { name: 'tagged sibling', owner: 97851, taggedPoll: 1, agyPoll: 1, visiblePoll: 1 },
  { name: 'sequential tagged sibling exits', owner: 97851, taggedPoll: 1, agyPoll: 2, visiblePoll: 2 },
  { name: 'another window owns the root', owner: 55555, taggedPoll: 1, agyPoll: 1, visiblePoll: 0 },
  { name: 'no learnable owner', owner: undefined, taggedPoll: 0, agyPoll: 1, visiblePoll: 0 },
  { name: 'late noncandidate descendant resolves unknown', owner: 97851, taggedPoll: 2, agyPoll: 1, visiblePoll: 2 },
  { name: 'late noncandidate promotes an elsewhere row', owner: 97851, taggedPoll: 2, agyPoll: 1, visiblePoll: 2, showElsewhere: true },
]

for (const scenario of hiddenEnvScenarios) {
  test(`hidden detached Gemini stays unproven: ${scenario.name}`, { options: { showElsewhere: scenario.showElsewhere === true } }, async ($, on) => {
    const clock = mock.clock(on)
    let poll = 0
    const queried = new Set<string>()
    const envPolls = new Set<number>()
    on('process.run', (_, e) => {
      if (e.argv[2] === 'echo $PPID') return processResult('97851\n')
      if (e.argv[0] === 'ps' && e.argv[1] === 'eww') {
        expect(envPolls.has(poll)).toBe(false)
        envPolls.add(poll)
        const pids = e.argv[5]!.split(',')
        for (const pid of pids) {
          expect(queried.has(pid)).toBe(false)
          queried.add(pid)
        }
        return processResult(pids.map(pid => `${pid} hidden${pid === '39072' ? ` CLAUDE_PID=${scenario.owner}` : ''}`).join('\n'))
      }
      if (e.argv[0] === 'ps') {
        poll++
        const seconds = String(Math.floor(clock.now() / 1000)).padStart(2, '0')
        return processResult([
          '97851 1 10:00 claude example session',
          `38998 1 01:${seconds} /bin/zsh /home/example/jobs/chain-c.sh`,
          ...(poll === scenario.taggedPoll ? [`39072 38998 00:${seconds} ${scenario.taggedPoll === 2 ? '/opt/homebrew/bin/python maintain.py' : 'node /opt/homebrew/bin/codex exec hi'}`] : []),
          ...(poll >= scenario.agyPoll ? [`39080 38998 00:${seconds} agy --model gemini-4-argon-high -p review`] : []),
        ].join('\n'))
      }
      return processResult(e.argv[0] === 'lsof' ? 'n/logs/chain.log\n' : '')
    })
    on('fs.read', () => ({ value: `exec: phase ${poll}\n` }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
    for (let expectedPoll = 1; expectedPoll <= 3; expectedPoll++) {
      await clock.advance(5000)
      const gemini = await ui.find({ type: 'Text', text: new RegExp(`^● gemini chain-c\\.sh gemini-4-argon-high.*exec: phase ${expectedPoll}$`) })
      expect(gemini).toBeUndefined()
      if (scenario.showElsewhere) {
        const elsewhere = await ui.find({ type: 'Text', text: /^◦ gemini/ })
        expect(elsewhere).toBeDefined()
      }
    }
    expect(queried.has('39080')).toBe(true)
    expect(queried.has('39072')).toBe(scenario.taggedPoll === 1)
    expect(queried.has('38998')).toBe(false)
    await ui.unmount()
  })
}

for (const reset of ['root PID reused', 'session restarted'] as const) {
  test(`detached sibling ownership is never inferred when ${reset}`, async ($, on) => {
    const clock = mock.clock(on)
    let phase = 1
    on('process.run', (_, e) => {
      if (e.argv[2] === 'echo $PPID') return processResult('97851\n')
      if (e.argv[0] === 'ps' && e.argv[1] === 'eww') return processResult(e.argv[5]!.split(',').map(pid =>
        `${pid} hidden${pid === '39072' ? ' CLAUDE_PID=97851' : ''}`).join('\n'))
      if (e.argv[0] === 'ps') {
        const seconds = String(Math.floor(clock.now() / 1000)).padStart(2, '0')
        return processResult([
          '97851 1 10:00 claude example session',
          `38998 1 ${phase === 3 && reset === 'root PID reused' ? '00' : '01'}:${seconds} /bin/zsh chain-c.sh`,
          ...(phase === 1 ? [`39072 38998 00:${seconds} node codex exec hi`] : []),
          ...(phase >= 2 ? [`${phase === 2 ? 39080 : 39081} 38998 00:${seconds} agy --model gemini-pro -p hi`] : []),
        ].join('\n'))
      }
      return processResult()
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.end', () => ({ sessionId: 'reset-owner' }))
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
    await clock.advance(5000)
    phase = 2
    await clock.advance(5000)
    expect(await ui.find({ type: 'Text', text: /^● gemini chain-c\.sh gemini-pro/ })).toBeUndefined()
    phase = 3
    if (reset === 'session restarted') {
      await $.session.end({ reason: 'other', sessionId: 'reset-owner', resume: { id: 'reset-owner' } })
      await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    }
    await clock.advance(5000)
    expect(await ui.find({ type: 'Text', text: /^● gemini/ })).toBeUndefined()
    await ui.unmount()
  })
}

const ownershipScenarios: { name: string; owner: string; options: Record<string, boolean>; visible: boolean; own: boolean }[] = [
  { name: 'exact session token', owner: '97851', options: {}, visible: true, own: true },
  { name: 'exact session token with machine view', owner: '97851', options: { showElsewhere: true }, visible: true, own: true },
  { name: 'another window', owner: '55555', options: {}, visible: false, own: false },
  { name: 'another window with machine view', owner: '55555', options: { showElsewhere: true }, visible: true, own: false },
  { name: 'untagged helper', owner: '', options: {}, visible: false, own: false },
]

for (const scenario of ownershipScenarios) {
  test(`detached chain: ${scenario.name}`, { options: { stallMinutes: 0.1, ...scenario.options } }, async ($, on) => {
    const clock = mock.clock(on)
    let alive = true, envCalls = 0, cwdCalls = 0, notifications = 0
    mock.env(on, { HOME: '/Users/test', CLAUDE_CODE_SESSION_ID: ownSession })
    on('process.run', (_, e) => {
      if (e.argv[0] === 'uname') return processResult('Darwin\n')
      if (e.argv[2] === 'echo $PPID') return processResult('97851\n')
      if (e.argv[0] === '/bin/sh') {
        expect(e.argv[5]).toBe('39072-0')
        return processResult()
      }
      if (e.argv[0] === 'osascript') { notifications++; return processResult() }
      if (e.argv[0] === 'ps' && e.argv[1] === 'eww') {
        envCalls++
        expect(e.argv).toEqual(['ps', 'eww', '-o', 'pid=,command=', '-p', '39072'])
        return processResult(`39072 node /opt/homebrew/bin/codex exec -m gpt-6.1-sol hi TOKEN=a=b ${scenario.owner ? `CLAUDE_CODE_SESSION_ID=${scenario.own ? ownSession : otherSession}` : ''}`)
      }
      if (e.argv[0] === 'ps') return processResult(alive ? detachedChain(Math.floor(clock.now() / 1000)) : '97851 1 10:00 claude example session')
      if (e.argv.includes('cwd')) { cwdCalls++; return processResult('p39072\nn/home/example/project/worktree\n') }
      expect(e.argv).toEqual(['lsof', '-p', '39072', '-a', '-d', '1,2', '-Fn'])
      return processResult('n/logs/detached.log\n')
    })
    on('fs.read', () => ({ value: 'exec: detached work\n' }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('classic.UserPromptSubmit', () => ({}))
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
    await clock.advance(5000)
    if (scenario.visible) {
      expect(await ui.find({ type: 'Text', text: scenario.own
        ? /^● codex chain-c\.sh gpt-6\.1-sol.*1 actions · exec: detached work$/
        : /^◦ codex project\/worktree · chain-c\.sh gpt-6\.1-sol.*1 actions · exec: detached work$/ })).toBeDefined()
    } else expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await clock.advance(6000)
    expect(envCalls).toBe(1)
    expect(cwdCalls).toBe(scenario.visible ? 1 : 0)
    expect(notifications).toBe(scenario.visible ? 1 : 0)
    const notes = (await $.classic.UserPromptSubmit({ prompt: 'Continue', source: 'user' })).additionalContext
    if (scenario.own) expect(notes?.[0]?.includes('codex gpt-6.1-sol (chain-c.sh)')).toBe(true)
    else expect(notes).toBeUndefined()
    expect((await $.classic.UserPromptSubmit({ prompt: 'Continue', source: 'user' })).additionalContext).toBeUndefined()
    alive = false
    await clock.advance(5000)
    if (scenario.visible) expect((await ui.find({ type: 'Text' }))?.props.dimColor).toBe(true)
    await clock.advance(20_000)
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await ui.unmount()
  })
}


test('ownership batches unknown candidates, caches failed reads, and resets for new births and sessions', async ($, on) => {
  const clock = mock.clock(on)
  let envCalls = 0, reused = false
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/sh') return processResult('97851\n')
    if (e.argv[0] === 'ps' && e.argv[1] === 'eww') {
      envCalls++
      expect(e.argv).toEqual(['ps', 'eww', '-o', 'pid=,command=', '-p', envCalls === 2 ? '39072' : '39072,88'])
      return envCalls === 1 ? processResult('', 1) : processResult('39072 node codex exec hi CLAUDE_PID=55555\n88 agy --print hi CLAUDE_PID=55555')
    }
    expect(e.argv).toEqual(['ps', '-Ao', 'pid=,ppid=,etime=,command='])
    const elapsed = Math.floor(clock.now() / 1000)
    return processResult(detachedChain(reused ? elapsed - 10 : elapsed) + `\n88 1 00:${String(elapsed).padStart(2, '0')} agy --print hi`)
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
  await clock.advance(10_000)
  expect(envCalls).toBe(1)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  reused = true
  await clock.advance(5000)
  expect(envCalls).toBe(2)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  expect(envCalls).toBe(3)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

// A matching label/model/start time is not evidence that a process belongs here.
test('process matching fails closed without session ownership evidence', () => {
  expect(pickProcess('45 1 00:05 codex exec -m gpt-6 hi', worker(), 5000, new Set())).toBeUndefined()
})

const ownSession = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const otherSession = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
for (const command of ['codex exec -m gpt-6 hi', 'agy --model gemini-pro -p hi', 'claude --model opus -p hi']) {
  for (const ownership of ['own session', 'other session', 'parent chain', 'pid hint only', 'unknown'] as const) {
    for (const showElsewhere of [false, true]) {
      test(`same-time ${command.split(' ')[0]}: ${ownership}, elsewhere=${showElsewhere}`, { options: { showElsewhere } }, async ($, on) => {
        const clock = mock.clock(on)
        mock.env(on, { CLAUDE_CODE_SESSION_ID: ownSession })
        const accessed: string[] = []
        on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'ownership-run' } }))
        on('process.run', (_, e) => {
          if (e.argv[0] === '/bin/sh') return processResult('999\n')
          if (e.argv[0] === 'ps' && e.argv[1] === 'eww') return processResult(`45 ${command}${ownership === 'pid hint only' ? ' CLAUDE_PID=999' : (ownership === 'unknown' || ownership === 'parent chain') ? '' : ` CLAUDE_CODE_SESSION_ID=${ownership === 'other session' ? otherSession : ownSession} CLAUDE_PID=999`}`)
          if (e.argv[0] === 'ps') return processResult(`999 1 10:00 claude\n777 999 00:30 /bin/sh helper.sh\n45 ${ownership === 'parent chain' ? 777 : 1} 00:05 ${command}`)
          accessed.push(e.argv.includes('cwd') ? 'cwd' : 'log paths')
          return processResult(e.argv.includes('cwd') ? 'n/example/worktree\n' : 'n/logs/candidate.log\n')
        })
        on('fs.stat', (_, e) => { accessed.push(`stat ${e.path}`); return { value: { kind: 'file', size: 14, mtimeMs: 0, isLink: false } } })
        on('fs.read', (_, e) => { accessed.push(`read ${e.path}`); return { value: 'exec: observed\n' } })
        on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
        await $.tool.call({ tool: 'Bash', tool_use_id: 'ownership-launch', command, run_in_background: true })
        const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
        await clock.advance(5000)
        const mine = ownership === 'own session' || ownership === 'parent chain'
        const ownRow = await ui.find({ type: 'Text', text: /^●.*1 actions · exec: observed$/ })
        if (mine) expect(ownRow).toBeDefined()
        else expect(ownRow).toBeUndefined()
        const elsewhereRow = await ui.find({ type: 'Text', text: /^◦.*1 actions · exec: observed$/ })
        if (!mine && showElsewhere) expect(elsewhereRow).toBeDefined()
        else expect(elsewhereRow).toBeUndefined()
        if (!mine && !showElsewhere) expect(accessed).toEqual([])
        else expect(accessed.includes('read /logs/candidate.log')).toBe(true)
        await ui.unmount()
      })
    }
  }
}

for (const mine of [false, true]) {
  test(`completion-time binding checks ownership: mine=${mine}`, async ($, on) => {
    mock.clock(on)
    mock.env(on, { CLAUDE_CODE_SESSION_ID: ownSession })
    let reads = 0, lsof = 0
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'Finished', stderr: '', interrupted: false } }))
    on('process.run', (_, e) => {
      if (e.argv[0] === '/bin/sh') return processResult('999\n')
      if (e.argv[0] === 'ps' && e.argv[1] === 'eww') return processResult(`45 codex exec hi CLAUDE_CODE_SESSION_ID=${mine ? ownSession : otherSession}`)
      if (e.argv[0] === 'ps') return processResult('999 1 10:00 claude\n45 1 00:00 codex exec hi')
      lsof++
      return processResult('n/logs/final.log\n')
    })
    on('fs.read', () => { reads++; return { value: 'exec: final\n' } })
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'final-ownership', command: 'codex exec hi' })
    expect(reads).toBe(mine ? 1 : 0)
    expect(lsof).toBe(mine ? 1 : 0)
    const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: mine ? /1 actions · exec: final$/ : /0 actions · Finished$/ })).toBeDefined()
    await ui.unmount()
  })
}

for (const missing of ['ps', 'lsof']) {
  test(`missing ${missing} renders a dim diagnostic without interrupting the pane`, async ($, on) => {
    const clock = mock.clock(on)
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('process.run', (_, e) => {
      if (e.argv[0] === missing) throw new Error(`Executable not found: ${missing}`)
      if (e.argv[0] === '/bin/sh') return processResult('999\n')
      return processResult('999 1 10:00 claude\n45 999 00:05 codex exec hi')
    })
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
    await clock.advance(5000)
    expect((await ui.find({ type: 'Text', text: new RegExp(`crew-board:.*${missing}.*unavailable`) }))?.props.dimColor).toBe(true)
    await ui.unmount()
  })
}


test('environment ownership ignores session tokens in argv and stores no other environment fields', () => {
  const command = `codex exec inspect CLAUDE_CODE_SESSION_ID=${ownSession} now`
  const rows = parsePs(`45 1 00:05 ${command}`)
  const owners = parseEnvOwners(`45 ${command} TOKEN=secret CLAUDE_PID=999 CLAUDE_CODE_SESSION_ID=${otherSession}`, rows)
  expect([...owners]).toEqual([[45, { sessionId: otherSession }]])
  expect([...parseEnvOwners(`45 ${command} CLAUDE_CODE_SESSION_ID=${ownSession} CLAUDE_CODE_SESSION_ID=${otherSession}`, rows)]).toEqual([[45, {}]])
  expect([...parseEnvOwners(`46 unknown CLAUDE_CODE_SESSION_ID=${ownSession}`, rows)]).toEqual([])
})

for (const system of ['Darwin', 'Linux']) {
  test(`stall notifications use argument data on ${system}`, { options: { stallMinutes: 0.01 } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/home/example' })
    let calls = 0
    const model = 'model" & do shell script "unsafe\\value'
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'notify' } }))
    on('process.run', (_, e) => {
      if (e.argv[0] === 'uname') return processResult(system + '\n')
      if (e.argv[0] === 'ps') return processResult(`999 1 10:00 claude\n45 999 00:05 codex exec -m '${model}' hi`)
      if (e.argv[0] === 'lsof') return processResult()
      if (e.argv[0] === 'osascript') {
        calls++
        expect(e.argv.slice(0, 7)).toEqual(['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Crew board: helper stalled"', '-e', 'end run'])
        expect(e.argv[7]).toBe(`codex ${model} - no new output for 0 min`)
        return processResult()
      }
      return processResult(e.argv[2] === 'echo $PPID' ? '999\n' : '')
    })
    await $.tool.call({ tool: 'Bash', tool_use_id: 'notify-launch', command: `codex exec -m '${model}' hi` })
    await clock.advance(6000)
    expect(calls).toBe(system === 'Darwin' ? 1 : 0)
  })
}

test('each tick removes only expired regular stall marker files', { options: { maxAgeSeconds: 2 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/example' })
  const deleted: string[] = []
  const listed: string[] = []
  on('fs.list', (_, e) => {
    listed.push(e.path ?? '')
    return { value: [
      { name: '45-0', kind: 'file', size: 0, mtimeMs: -2000, isLink: false },
      { name: '46-0', kind: 'file', size: 0, mtimeMs: 0, isLink: false },
      { name: '47-0', kind: 'file', size: 0, mtimeMs: -1000, isLink: false },
      { name: 'notes.log', kind: 'file', size: 0, mtimeMs: -2000, isLink: false },
      { name: '48-0', kind: 'file', size: 0, mtimeMs: -2000, isLink: true },
      { name: '49-0', kind: 'dir', size: 0, mtimeMs: -2000, isLink: false },
    ] }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/rm') { deleted.push(e.argv[3]!); return processResult() }
    return processResult('')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  expect(listed).toEqual(['/home/example/.claude/crew-board/stall-markers'])
  expect(deleted).toEqual(['/home/example/.claude/crew-board/stall-markers/45-0'])
})

for (const replacement of ['absent', 'non-helper']) {
  test(`elsewhere process ${replacement} is never polled after exit or PID reuse`, { options: { showElsewhere: true } }, async ($, on) => {
    const clock = mock.clock(on)
    let phase = 1, reads = 0, lsof = 0
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('process.run', (_, e) => {
      if (e.argv[0] === '/bin/sh') return processResult('999\n')
      if (e.argv[0] === 'ps' && e.argv[1] === 'eww') return processResult()
      if (e.argv[0] === 'ps') return processResult(phase === 1 ? '45 1 00:05 codex exec hi -o /logs/final.log' : replacement === 'absent' ? '' : '45 1 00:00 sleep 60')
      if (e.argv[0] === 'lsof') { lsof++; return processResult(e.argv.includes('cwd') ? 'n/example\n' : 'n/logs/live.log\n') }
      return processResult()
    })
    on('fs.read', () => { reads++; return { value: 'exec: own helper\n' } })
    on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return h(Box, {}) as RenderElement })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'crew-board', surface: 'terminal', ...BAND })
    await clock.advance(5000)
    expect(reads).toBe(2)
    expect(lsof).toBe(2)
    phase = 2
    await clock.advance(5000)
    expect(reads).toBe(2)
    expect(lsof).toBe(2)
    expect((await ui.find({ type: 'Text', text: /^◦ codex/ }))?.props.dimColor).toBe(true)
    await ui.unmount()
  })
}

test('PID reuse invalidates cached live paths and birth metadata for an owned helper', () => {
  const original = worker({ pid: 45, toolUseId: 'launch', processStartedAt: 0, livePaths: ['/logs/old.log'], folder: '/old', folderChecked: true, outputCache: { '/logs/old.log': { size: 5, bytes: 5, count: 1, action: 'exec' } } })
  const bound = bindProcesses(parsePs('45 999 00:00 codex exec -m gpt-6 hi'), [original], 10_000, new Set([45]))[0]!
  expect(bound.pid).toBeUndefined()
  expect(bound.processStartedAt).toBeUndefined()
  expect(bound.livePaths).toBeUndefined()
  expect(bound.outputCache).toBeUndefined()
  expect(bound.folder).toBeUndefined()
  expect(original.livePaths).toEqual(['/logs/old.log'])
})

test('foreign ownership revocation persists and never injects a stale own-context note', { options: { stallMinutes: 0.01 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CODE_SESSION_ID: ownSession })
  let phase = 1, reads = 0
  let persisted: CrewBoardWorker | undefined
  on('state.set', { plugin: 'crew-board', key: 'board' }, (_, e, next) => {
    persisted = e.value.workers.find(worker => worker.id === 'revoked')
    return next(e)
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'revoked-task' } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/sh') return processResult('999\n')
    if (e.argv[0] === 'ps' && e.argv[1] === 'eww') return processResult(`45 codex exec hi CLAUDE_CODE_SESSION_ID=${phase === 1 ? ownSession : otherSession}`)
    if (e.argv[0] === 'ps') return processResult(`999 1 10:00 claude\n45 1 ${phase === 1 ? '00:05' : '00:00'} codex exec hi`)
    if (e.argv[0] === 'lsof') return processResult('n/logs/old-own.log\n')
    return processResult('Linux\n')
  })
  on('fs.read', () => { reads++; return { value: 'exec: old own work\n' } })
  on('classic.UserPromptSubmit', () => ({}))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'revoked', command: 'codex exec hi', run_in_background: true })
  await clock.advance(5000)
  expect(persisted?.pid).toBe(45)
  expect(reads).toBe(1)
  phase = 2
  await clock.advance(5000)
  expect(persisted?.pid).toBeUndefined()
  expect(persisted?.livePaths).toBeUndefined()
  expect(reads).toBe(1)
  expect((await $.classic.UserPromptSubmit({ prompt: 'Continue' })).additionalContext).toBeUndefined()
})

for (const attached of [false, true]) {
test(`current engine ID overrides inherited environment after clear, attached=${attached}`, { options: { stallMinutes: 0.01 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CODE_SESSION_ID: otherSession })
  let currentId = otherSession, reads = 0
  on('session.id', () => ({ value: currentId }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'pre-clear-task' } }))
  on('process.run', (_, e) => {
    if (e.argv[0] === '/bin/sh') return processResult('999\n')
    if (e.argv[0] === 'ps' && e.argv[1] === 'eww') return processResult(`45 codex exec hi CLAUDE_CODE_SESSION_ID=${otherSession}`)
    if (e.argv[0] === 'ps') return processResult(`999 1 10:00 claude\n45 ${attached ? 999 : 1} 00:${String(Math.floor(clock.now() / 1000)).padStart(2, '0')} codex exec hi`)
    if (e.argv[0] === 'lsof') return processResult('n/logs/pre-clear.log\n')
    return processResult('Linux\n')
  })
  on('fs.read', () => { reads++; return { value: 'exec: pre-clear\n' } })
  on('classic.UserPromptSubmit', () => ({}))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'pre-clear', command: 'codex exec hi' })
  await clock.advance(5000)
  expect(reads).toBe(1)
  currentId = ownSession
  expect((await $.classic.UserPromptSubmit({ prompt: 'Continue immediately after clear' })).additionalContext).toBeUndefined()
  await clock.advance(5000)
  expect(reads).toBe(1)
  expect((await $.classic.UserPromptSubmit({ prompt: 'Continue' })).additionalContext).toBeUndefined()
})
}
