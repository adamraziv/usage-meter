import { test, expect, mock } from 'claude-code/testing'

import { dropEndedWindows, mergeSamples } from '../hooks/history'
import type { On } from 'claude-code'

const H = 3600_000
const MIN = 60_000

test('readings from several places merge in time order, duplicates once', () => {
  const a = [{ t: 1 * MIN, pct: 10 }, { t: 3 * MIN, pct: 12 }]
  const b = [{ t: 2 * MIN, pct: 11 }, { t: 3 * MIN, pct: 12 }]
  expect(mergeSamples([a, b, undefined], H, 24)).toEqual([
    { t: 1 * MIN, pct: 10 },
    { t: 2 * MIN, pct: 11 },
    { t: 3 * MIN, pct: 12 },
  ])
})

test('a big drop is a reset; a small one is a stale reading and is skipped', () => {
  expect(mergeSamples([[{ t: 1, pct: 80 }, { t: 2, pct: 78 }, { t: 3, pct: 81 }]], H, 24)).toEqual([
    { t: 1, pct: 80 },
    { t: 3, pct: 81 },
  ])
  expect(mergeSamples([[{ t: 1, pct: 80 }, { t: 2, pct: 3 }, { t: 3, pct: 4 }]], H, 24)).toEqual([
    { t: 2, pct: 3 },
    { t: 3, pct: 4 },
  ])
})

test('only what is within keepMs of the newest, at most the cap, is kept; the ends always', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ t: i * 5 * MIN, pct: i }))
  const kept = mergeSamples([many], H, 24)
  expect(kept[0]?.t).toBe(39 * 5 * MIN - 60 * MIN)
  expect(kept.length).toBe(13)
  const thinned = mergeSamples([many], 10 * H, 24)
  expect(thinned.length).toBe(24)
  expect(thinned[0]).toEqual(many[0])
  expect(thinned[23]).toEqual(many[39])
})

const NOW = Date.parse('2026-10-14T09:40:00Z')

test('after a restart the stored readings keep the recent pace (the screenshot case)', { timeoutMs: 30_000 }, async ($, on) => {
  // 41% used, reset in 3h10m. The average since the window opened (1h50m ago)
  // would say ~0.37%/min, so empty in ~2h38m: yellow. The last hour's readings
  // say ~0.19%/min, so ~5h: green. A restart must not lose them.
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    history: {
      five_hour: [
        { t: NOW - 50 * MIN, pct: 32, w: '2026-10-14T12:50:00Z' },
        { t: NOW - 25 * MIN, pct: 37, w: '2026-10-14T12:49:59.926Z' },
        { t: NOW - 5 * MIN, pct: 41, w: '2026-10-14T12:50:00Z' },
      ],
    },
  })
  on('process.run', (_$, e) => ({ value: { exitCode: e.argv[1] === '--wait' ? 1 : 0, stdout: '{}', stderr: '' } }) as never)
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'S2' }))
  on('session.cwd', () => ({ value: '/tmp/x' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-14T12:50:00Z' }],
      cost: { usd: 0 },
    },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>{''}</Text>
  })

  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(0)
  const band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect((await band.find({ type: 'Text', text: /^ 41%$/ }))?.props.color).toBe('success')
  expect(await band.find({ type: 'Text', text: /^\/$/ })).toBeUndefined()
  await band.unmount()
})

test('a window is known by its reset time: ended, replaced, or the same despite jitter', () => {
  const R = '2026-10-14T12:50:00Z'
  const s = [
    { t: 1, pct: 10, w: R },
    { t: 2, pct: 12, w: '2026-10-14T12:49:59.926Z' },
  ]
  const before = Date.parse(R) - MIN
  expect(dropEndedWindows(s, R, before)).toEqual(s) // same window, two sources
  expect(dropEndedWindows(s, R, Date.parse(R) + 1)).toEqual([]) // it reset
  expect(dropEndedWindows(s, '2026-10-14T17:50:00Z', before)).toEqual([]) // a new window began
  expect(dropEndedWindows(s, '2026-10-14T13:00:00Z', before)).toEqual(s) // moved 10m: same window
  expect(dropEndedWindows([{ t: 1, pct: 5 }], R, before)).toEqual([]) // untagged: from before tagging
})

// A store the test can read back: what the mod saved, after each step.
function store(on: On, initial: Record<string, unknown>) {
  const data = new Map(Object.entries(initial))
  on('store.get', (_$, e) => ({ value: data.get(e.key) }) as never)
  on('store.set', (_$, e) => {
    data.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => {
    data.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...data.keys()] }) as never)
  return data
}

type Hist = Record<string, { t: number; pct: number; w?: string }[]>

function boot(on: On, limits: () => { kind: string; percentUsed: number; resetsAt: string }[], fableReset: () => string) {
  on('process.run', (_$, e) => {
    if (e.argv[1] !== '--wait') return { value: { exitCode: 0, stdout: '{}', stderr: '' } } as never
    // The account part, as the helper reads it: Fable's weekly window.
    const account = { fetchedAt: 0, session: null, models: [{ name: 'Fable', percent: 13, resetsAt: fableReset() }] }
    return { value: { exitCode: 0, stdout: JSON.stringify({ account }), stderr: '' } } as never
  })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'S3' }))
  on('session.cwd', () => ({ value: '/tmp/x' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: limits(), cost: { usd: 0 } } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
}

const R5 = '2026-10-14T09:50:00Z' // the 5h window resets ten minutes after NOW
const RF = '2026-10-17T19:00:00Z' // Fable's weekly window
const R7 = '2026-10-20T12:00:00Z' // the plain 7d window: never cleaned

test('when the 5h window resets, its stored readings go; Fable and 7d stay', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const data = store(on, {
    history: {
      five_hour: [{ t: NOW - 20 * MIN, pct: 80, w: R5 }, { t: NOW - 2 * MIN, pct: 90, w: R5 }],
      'model-Fable': [{ t: NOW - 5 * MIN, pct: 13, w: RF }],
      seven_day: [{ t: NOW - 5 * MIN, pct: 50, w: R7 }],
    },
  })
  boot(on, () => [{ kind: 'five_hour', percentUsed: 90, resetsAt: R5 }, { kind: 'seven_day', percentUsed: 50, resetsAt: R7 }], () => RF)
  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(1_000)
  expect(Object.keys(data.get('history') as Hist).sort()).toEqual(['five_hour', 'model-Fable', 'seven_day'])

  await clock.advance(11 * MIN) // past R5: the window reset, no new reading yet
  const h = data.get('history') as Hist
  expect(h.five_hour).toBeUndefined()
  expect(h['model-Fable']?.length).toBeGreaterThan(0)
  expect(h.seven_day?.length).toBeGreaterThan(0)
})

test('a new 5h window that begins before the old reset time clears the old readings too', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const data = store(on, { history: { five_hour: [{ t: NOW - 5 * MIN, pct: 60, w: R5 }] } })
  let reset = R5
  boot(on, () => [{ kind: 'five_hour', percentUsed: 2, resetsAt: reset }], () => RF)
  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(1_000)
  expect((data.get('history') as Hist).five_hour?.some(x => x.w === R5)).toBe(true)

  reset = '2026-10-14T14:41:00Z' // the reset moved by hours: a different window
  await clock.advance(31_000)
  const five = (data.get('history') as Hist).five_hour ?? []
  expect(five.some(x => x.w === R5)).toBe(false)
  expect(five.every(x => x.w === reset)).toBe(true)
})

test('when Fable resets, its readings go', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const soon = '2026-10-14T09:45:00Z'
  const data = store(on, { history: { 'model-Fable': [{ t: NOW - 5 * MIN, pct: 99, w: soon }] } })
  boot(on, () => [], () => soon)
  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(1_000)
  expect((data.get('history') as Hist)['model-Fable']?.length).toBeGreaterThan(0)
  await clock.advance(6 * MIN)
  expect((data.get('history') as Hist)['model-Fable']).toBeUndefined()
})
