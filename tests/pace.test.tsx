import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-14T12:00:00Z')
const RESET = '2026-10-14T14:00:00Z' // two hours out
const MIN = 60_000

// What the engine would report now: the last reading measured.
let current: { kind: string; percentUsed: number; resetsAt: string }[] = []

function stubs(on: On) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  current = []
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: current, cost: { usd: 0 } } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.cwd', () => ({ value: '/tmp/x' }))
  on('session.id', () => ({ value: 'S1' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  // No wait loop here (it backs off): these tests are about the pace alone.
  on('process.run', (_$, e) => ({ value: { exitCode: e.argv[1] === '--wait' ? 1 : 0, stdout: '{}', stderr: '' } }) as never)
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>{''}</Text>
  })
  return clock
}

const fiveHour = (pct: number) => {
  current = [{ kind: 'five_hour', percentUsed: pct, resetsAt: RESET }]
  return { context: { window: 200000 }, rateLimits: current, changed: ['rateLimits'] as 'rateLimits'[] }
}

test('burning fast turns the bar, % and countdown red with a run-out estimate', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = stubs(on)
  await $.session.start({ source: 'startup', cwd: '/tmp/x', surface: 'desktop', isInteractive: true } as never)
  await $.session.measure(fiveHour(10))
  await clock.advance(15 * MIN)
  await $.session.measure(fiveHour(40)) // 2%/min over 15m, tempered by the window average: 60% left lasts 47m, reset is 1h45m away

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'AbovePrompt', props: { hasSurvey: false } as never })
    expect((await band.find({ type: 'Text', text: /^ 40%$/ }))?.props.color).toBe('error')
    expect((await band.find({ type: 'Text', text: /^1h45m$/ }))?.props.color).toBe('error')
    expect((await band.find({ type: 'Text', text: /^━━$/ }))?.props.color).toBe('error')
    expect((await band.find({ type: 'Text', text: /^47m$/ }))?.props.color).toBe('error')
    expect(await band.find({ type: 'Text', text: /empty/ })).toBeUndefined()
    await band.unmount()
  }
})

test('the color follows the last hour of readings as the pace changes', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = stubs(on)
  await $.session.start({ source: 'startup', cwd: '/tmp/x', surface: 'desktop', isInteractive: true } as never)
  await $.session.measure(fiveHour(50))
  await clock.advance(20 * MIN)
  await $.session.measure(fiveHour(58)) // 0.4%/min: 42% lasts 1h45m, reset 1h40m away -> green
  let band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect((await band.find({ type: 'Text', text: /^ 58%$/ }))?.props.color).toBe('success')
  expect(await band.find({ type: 'Text', text: /empty/ })).toBeUndefined()
  await band.unmount()

  await clock.advance(10 * MIN)
  await $.session.measure(fiveHour(70)) // 50 -> 70 over 30m: 30% left lasts 45m, reset 1h30m away -> red
  // A changed value flashes in the accent color, holds bold, then settles.
  band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect((await band.find({ type: 'Text', text: /^ 70%$/ }))?.props).toMatchObject({ color: 'claude', bold: true })
  await band.unmount()
  await clock.advance(500)
  band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect((await band.find({ type: 'Text', text: /^ 70%$/ }))?.props).toMatchObject({ color: 'error', bold: true })
  await band.unmount()
  await clock.advance(1_000)
  band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect((await band.find({ type: 'Text', text: /^ 70%$/ }))?.props.color).toBe('error')
  expect((await band.find({ type: 'Text', text: /^ 70%$/ }))?.props.bold).toBeFalsy()
  await band.unmount()

  await clock.advance(10 * MIN)
  await $.session.measure(fiveHour(71))
  await clock.advance(30 * MIN)
  await $.session.measure(fiveHour(73)) // last hour: 58 -> 73 over 50m: 27% lasts 1h30m, reset 50m away -> green
  band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  await band.unmount() // the draw that notices the change and starts its glow
  await clock.advance(2_000) // past the glow
  band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect((await band.find({ type: 'Text', text: /^ 73%$/ }))?.props.color).toBe('success')
  await band.unmount()
})

test('running out before the reset but more than an hour away is yellow', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = stubs(on)
  await $.session.start({ source: 'startup', cwd: '/tmp/x', surface: 'desktop', isInteractive: true } as never)
  await $.session.measure(fiveHour(20))
  await clock.advance(15 * MIN)
  await $.session.measure(fiveHour(36)) // 16% in 15m: 64% left lasts ~1h30m, reset 1h45m away
  const band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect((await band.find({ type: 'Text', text: /^ 36%$/ }))?.props.color).toBe('warning')
  expect((await band.find({ type: 'Text', text: /^1h45m$/ }))?.props.color).toBe('warning')
  expect((await band.find({ type: 'Text', text: /^1h30m$/ }))?.props.color).toBe('warning')
  await band.unmount()
})

test('too little data early in a window stays green', { timeoutMs: 30_000 }, async ($, on) => {
  stubs(on)
  await $.session.start({ source: 'startup', cwd: '/tmp/x', surface: 'desktop', isInteractive: true } as never)
  await $.session.measure(fiveHour(3))
  const band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect((await band.find({ type: 'Text', text: /^ 3%$/ }))?.props.color).toBe('success')
  await band.unmount()
})
