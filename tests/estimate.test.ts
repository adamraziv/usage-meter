import { test, expect } from 'claude-code/testing'

import { pace } from '../hooks/pace'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.parse('2026-10-14T12:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const W = 'w' // the window tag is not the estimate's business

test('cold start mid-window: the average since the nominal start, and nothing else', () => {
  // 44% with 2h43m to the reset: 2h17m in, 0.32%/min, 56% lasts 2h54m: after the reset.
  const p = pace([], 44, at(163 * MIN), 5 * HOUR, NOW)
  expect(p.tone).toBe('success')
  expect(Math.round((p.msToEmpty ?? 0) / MIN)).toBe(174)
})

test('two readings a minute apart cannot alone paint it red', () => {
  // 43 -> 44 in a minute is 1%/min on paper (rounding alone can do that):
  // a one-minute span weighs 1/11 against the window average.
  const p = pace([{ t: NOW - MIN, pct: 43, w: W }, { t: NOW, pct: 44, w: W }], 44, at(3 * HOUR), 5 * HOUR, NOW)
  expect(p.tone).not.toBe('error')
  expect((p.msToEmpty ?? 0) > 2 * HOUR).toBe(true)
})

test('early in a window, with little used, there is nothing to say yet', () => {
  const p = pace([{ t: NOW - MIN, pct: 2, w: W }, { t: NOW, pct: 3, w: W }], 3, at(290 * MIN), 5 * HOUR, NOW)
  expect(p.tone).toBe('success')
})

test('once watched for a while, the nominal window length hardly matters', () => {
  // Two hours of readings at 0.25%/min. Told the window is 5h or 3h, the
  // estimate comes out within a few percent either way.
  const s = [{ t: NOW - 120 * MIN, pct: 20, w: W }, { t: NOW - 60 * MIN, pct: 35, w: W }, { t: NOW, pct: 50, w: W }]
  const five = pace(s, 50, at(2 * HOUR), 5 * HOUR, NOW)
  const three = pace(s, 50, at(2 * HOUR), 3 * HOUR, NOW)
  expect(five.tone).toBe('success')
  expect(three.tone).toBe('success')
  const perMin = (p: { rate: number | null }) => (p.rate ?? 0) * MIN
  expect(Math.abs(perMin(five) - perMin(three)) / perMin(five)).toBeLessThan(0.15)
  expect(Math.abs(perMin(five) - 0.25)).toBeLessThan(0.02)
})

test('idling counts: an hour with no movement cools a hot burst', () => {
  const burst = [{ t: NOW - 90 * MIN, pct: 10, w: W }, { t: NOW - 60 * MIN, pct: 50, w: W }]
  // Seen right after the burst: 40% in 30m, 50% left lasts under an hour.
  expect(pace(burst, 50, at(90 * MIN), 5 * HOUR, NOW - 60 * MIN).tone).toBe('error')
  // Seen an hour later with the % unchanged: now at the same % is a reading too.
  expect(pace(burst, 50, at(30 * MIN), 5 * HOUR, NOW).tone).toBe('success')
})

test('the edges: reset passed, or already full', () => {
  expect(pace([], 70, at(-MIN), 5 * HOUR, NOW)).toEqual({ tone: 'success', msToEmpty: null, rate: null })
  expect(pace([], 100, at(HOUR), 5 * HOUR, NOW)).toEqual({ tone: 'error', msToEmpty: 0, rate: null })
})

// ---- the activity leg: % per dollar, times dollars per minute lately ----

import { activity } from '../hooks/pace'

const D = '2026-10-14'
const perMin = (usd: number) => usd / (15 * MIN) // $ per ms, spent evenly over the last 15 min

test('activity sums the last 15 minutes of replies, by family or all', () => {
  const recent: [number, number, string][] = [
    [NOW - 20 * MIN, 9, 'Opus'], // too old
    [NOW - 10 * MIN, 2, 'Opus'],
    [NOW - 5 * MIN, 1, 'Fable'],
    [NOW + MIN, 7, 'Fable'], // not yet (a clock ahead of ours)
  ]
  expect(Math.abs((activity({ recent }, null, NOW) ?? 0) * 15 * MIN - 3)).toBeLessThan(1e-9)
  expect(Math.abs((activity({ recent }, 'Fable', NOW) ?? 0) * 15 * MIN - 1)).toBeLessThan(1e-9)
  expect(activity(null, null, NOW)).toBeNull()
  expect(activity({}, null, NOW)).toBeNull()
})

test('calibrated by its own readings, a burst of spend turns it red at once', () => {
  // 20% for $10 in this window: 2% a dollar. Readings alone (20% in an hour)
  // say 2h36m to empty; $10 in the last 15 minutes says under an hour.
  const s = [{ t: NOW - HOUR, pct: 20, w: W, c: 0, d: D }, { t: NOW, pct: 40, w: W, c: 10, d: D }]
  expect(pace(s, 40, at(2 * HOUR), 5 * HOUR, NOW, null).tone).toBe('success')
  expect(pace(s, 40, at(2 * HOUR), 5 * HOUR, NOW, perMin(10)).tone).toBe('error')
})

test('idling is zero activity: a hot slope cools the moment the spending stops', () => {
  // 40% in 30 minutes, 47m to empty by the slope alone: red...
  const s = [{ t: NOW - 30 * MIN, pct: 10, w: W, c: 0, d: D }, { t: NOW, pct: 50, w: W, c: 20, d: D }]
  expect(pace(s, 50, at(HOUR), 5 * HOUR, NOW, null).tone).toBe('error')
  // ...but nothing was spent in the last 15 minutes, so nothing is running out.
  expect(pace(s, 50, at(HOUR), 5 * HOUR, NOW, 0).tone).toBe('success')
})

test('without spend on the readings there is no calibration, and activity is ignored', () => {
  const s = [{ t: NOW - 30 * MIN, pct: 10, w: W }, { t: NOW, pct: 50, w: W }]
  expect(pace(s, 50, at(HOUR), 5 * HOUR, NOW, perMin(100))).toEqual(pace(s, 50, at(HOUR), 5 * HOUR, NOW, null))
})

test('spend is only compared within a day: past midnight the calibration starts over', () => {
  const yesterday = { t: NOW - 3 * HOUR, pct: 10, w: W, c: 80, d: '2026-10-13' } // today's counter restarted since
  const today = [{ t: NOW - HOUR, pct: 30, w: W, c: 1, d: D }, { t: NOW, pct: 40, w: W, c: 6, d: D }]
  const mixed = pace([yesterday, ...today], 40, at(2 * HOUR), 5 * HOUR, NOW, perMin(5))
  const clean = pace([{ ...yesterday, c: null, d: null }, ...today], 40, at(2 * HOUR), 5 * HOUR, NOW, perMin(5))
  expect(Math.abs((mixed.rate ?? 0) - (clean.rate ?? -1))).toBeLessThan(1e-12)
})
