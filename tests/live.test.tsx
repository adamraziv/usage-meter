import { test, expect, mock } from 'claude-code/testing'

import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-14T12:00:00Z')

function base(on: On, now: number) {
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: '/Users/me/code/voltron' }))
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>{''}</Text>
  })
}

test('the wait loop brings changes in and nothing is polled while it runs', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const runs: string[][] = []
  const answers = [
    '{"today":{"usd":1.5,"cacheHit":90.2},"place":{"folder":"voltron","branch":"main"}}',
    '{"place":{"folder":"voltron","branch":"feat/live"}}',
    '{"today":{"usd":2.25,"cacheHit":91}}',
  ]
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const out = e.argv[1] === '--wait' ? (answers.shift() ?? '{}') : '{}'
    return { value: { exitCode: 0, stdout: out, stderr: '' } } as never
  })
  base(on, NOW)

  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(1_000)

  const waits = runs.filter(r => r[1] === '--wait')
  expect(waits[0]?.slice(1)).toEqual(['--wait', '/tmp/usage-meter-S1.json', '/Users/me/code/voltron', '20'])
  expect(waits.length).toBeGreaterThanOrEqual(3)
  expect(runs.filter(r => r.includes('--today'))).toEqual([])

  const band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await band.find({ type: 'Text', text: /^\$2\.25$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^91%$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^feat\/live$/ })).toBeDefined()
  await band.unmount()
})

test('inside its own background `claude -p` refresh the mod does nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '{}', stderr: '' } } as never
  })
  on('env.get', (_$, e) => ({ value: e.name === 'USAGE_METER_CHILD' ? '1' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: '/tmp' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  await $.session.start({ source: 'startup', cwd: '/tmp', surface: null, isInteractive: false } as never)
  await clock.advance(10_000)
  expect(runs).toEqual([])
})

test('under ten minutes the countdown runs by the second', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{}', stderr: '' } }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/tmp/x' }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-14T12:09:00Z' }],
      cost: { usd: 0.5 },
    },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>{''}</Text>
  })

  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  let band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await band.find({ type: 'Text', text: /^9m00s$/ })).toBeDefined()
  await band.unmount()
  await clock.advance(1_000)
  band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await band.find({ type: 'Text', text: /^8m59s$/ })).toBeDefined()
  await band.unmount()
})

test('the session cost is read every five seconds, mid-turn too', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  let cost = 0.5
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{}', stderr: '' } }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/tmp/x' }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [], cost: { usd: cost } } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>{''}</Text>
  })

  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  cost = 3.75 // spent during a long turn: no session.measure arrives
  await clock.advance(5_000)
  const band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await band.find({ type: 'Text', text: /^\$3\.75$/ })).toBeDefined()
  await band.unmount()
})

test('a session that starts headless and draws later starts on its first ask to draw', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: e.argv[1] === '--wait' ? 1 : 0, stdout: '{}', stderr: '' } } as never
  })
  base(on, NOW)

  // Started with no surface yet: nothing runs.
  await $.session.start({ source: 'startup', cwd: '/tmp', surface: null, isInteractive: false } as never)
  await clock.advance(10_000)
  expect(runs).toEqual([])

  // A screen asks to draw: the mod starts, and draws on the next ask.
  let band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  await band.unmount()
  await clock.advance(1_000)
  expect(runs.some(r => r[1] === '--wait')).toBe(true)
  band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await band.find({ type: 'Text', text: /^\$0\.50$/ })).toBeDefined()
  await band.unmount()
})
