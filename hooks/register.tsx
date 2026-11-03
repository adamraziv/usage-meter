import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Limit, ModelLimit, Place, Reply, Sample, Snapshot, Today } from '../types'
import { dropEndedWindows, mergeSamples } from './history'
import { activity, pace } from './pace'

const snapshot = atom({ plugin: 'usage-meter', key: 'snapshot' } as const, null)
const today = atom({ plugin: 'usage-meter', key: 'today' } as const, null)
const place = atom({ plugin: 'usage-meter', key: 'place' } as const, null)
const modelLimits = atom({ plugin: 'usage-meter', key: 'modelLimits' } as const, [])
const accountSession = atom({ plugin: 'usage-meter', key: 'accountSession' } as const, null)
const refreshing = atom({ plugin: 'usage-meter', key: 'isRefreshing' } as const, false)
const history = atom({ plugin: 'usage-meter', key: 'history' } as const, {})
const nowAtom = atom({ plugin: 'usage-meter', key: 'now' } as const, 0)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000, weekly: 7 * 86400_000 }
type Tone = 'success' | 'warning' | 'error'

const VERSION = '0.10.0' // keep with .claude-plugin/plugin.json
const BAR_CELLS = 5
const TICK_MS = 1_000 // the tick; it redraws only when what is shown would change
const REDRAW_MS = 5_000
const USAGE_EVERY_MS = 5_000

// Background work ends with the module (a reload, the session's end) and
// rejects then; nothing is waiting on it, so that is not an error.
function quietly(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

// ---- the Rust helper: today's spend, folder and branch, cached account limits ----

// One run answers any of the three; see helper/src/main.rs. Built into bin/.
let helper = ''
const SCAN_EVERY_MS = 30_000
const POLL_EVERY_MS = 5_000 // the fallback's pace when the wait loop is down
let lastScan = 0

type HelperOut = {
  today?: { usd: number; cacheHit: number | null; byModel?: Record<string, number>; recent?: Reply[]; date?: string } | null
  place?: { folder: string; branch: string | null } | null
  account?: {
    fetchedAt: number
    session: { percent: number; resetsAt: string | null } | null
    models: { name: string; percent: number; resetsAt: string | null }[]
  } | null
}

async function poll($: EngineInterface, want: { today?: boolean; place?: boolean; account?: boolean }): Promise<void> {
  const argv = [helper]
  const t = await $.clock.now()
  const wantsToday = want.today === true && t - lastScan >= SCAN_EVERY_MS
  if (wantsToday) {
    argv.push('--today')
    lastScan = t
  }
  if (want.place) argv.push('--place', await $.session.cwd())
  if (want.account) argv.push('--account')
  if (argv.length === 1) return

  try {
    const run = await $.process.run(argv, { timeoutMs: 60_000 })
    if (run.exitCode !== 0) return
    await apply($, JSON.parse(run.stdout) as HelperOut)
  } catch {
    // Keep the last figures; the next tick tries again.
  }
}

async function apply($: EngineInterface, out: HelperOut): Promise<void> {
  if (out.today) {
    const r = out.today
    await update($, today, () => ({
      usd: r.usd,
      cacheHit: r.cacheHit ?? null,
      byModel: r.byModel ?? {},
      recent: r.recent ?? [],
      date: r.date ?? null,
    }) satisfies Today)
  }
  if (out.place) {
    const { folder, branch } = out.place
    const prev = await read($, place)
    if (prev?.folder !== folder || prev?.branch !== branch) {
      await update($, place, () => ({ folder, branch }) satisfies Place)
    }
  }
  if (out.account) await applyAccount($, out.account)
}

// The live path: the helper is run in a loop with `--wait`. Each run blocks
// until a transcript, ~/.claude.json or .git/HEAD changes (or WAIT_S pass),
// prints what changed and exits; a state file carries its read positions and
// totals to the next run, so nothing is read twice. While the loop is
// healthy, nothing is polled; if it fails, the tick polls and the loop backs off.
const WAIT_S = 20
let watching = false
let watchGen = 0

async function watchLoop($: EngineInterface, gen: number): Promise<void> {
  const stateFile = `/tmp/usage-meter-${await $.session.id()}.json`
  let failures = 0
  while (gen === watchGen) {
    let ok = false
    try {
      const cwd = await $.session.cwd()
      const run = await $.process.run([helper, '--wait', stateFile, cwd, String(WAIT_S)], {
        timeoutMs: (WAIT_S + 40) * 1000,
      })
      if (run.exitCode === 0) {
        ok = true
        if (gen === watchGen) await apply($, JSON.parse(run.stdout) as HelperOut)
      }
    } catch {
      ok = false
    }
    if (gen !== watchGen) return
    watching = ok
    failures = ok ? 0 : failures + 1
    // A breath between rounds; failing outright, longer each time (5s ... a minute).
    await $.clock.sleep(ok ? 250 : Math.min(60_000, 5_000 * 2 ** (failures - 1)))
  }
}

async function measure($: EngineInterface, u: Pick<SessionUsage, 'rateLimits' | 'cost'>) {
  const limits: Limit[] = u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  const costUsd = u.cost?.usd ?? null
  const t = await $.clock.now()
  const prev = await read($, snapshot)
  const isNewReading = !prev || JSON.stringify(prev.limits) !== JSON.stringify(limits)
  const measuredAt = isNewReading ? t : prev.measuredAt
  await update($, snapshot, () => ({ limits, costUsd, measuredAt }) satisfies Snapshot)
  await update($, nowAtom, () => t)
  // An unchanged reading is the last reply's, not news: only new ones count.
  if (isNewReading) for (const l of limits) await record($, l.kind, t, l.percentUsed, l.resetsAt)
}

// ---- pace: will this limit run out before it resets? ----

const HOUR = 3600_000
// A whole window's readings are kept (the pace is drawn from all of them),
// with room past the nominal length for windows that run longer.
const KEEP_MS: Record<string, number> = { five_hour: 6 * HOUR, seven_day: 8 * 24 * HOUR }
const KEEP_DEFAULT_MS = 8 * 24 * HOUR // the per-model weekly windows
const MAX_SAMPLES = 48

// The readings live in the mod's store too, shared by every session: the
// limits are the account's, so every session adds to one history and a
// restart keeps it. The atom is this session's copy, which the band reads.
const STORE_KEY = 'history'

type History = Record<string, Sample[]>

async function storedHistory($: EngineInterface): Promise<History> {
  const v = await $.store.get(STORE_KEY)
  return v && typeof v === 'object' ? (v as History) : {}
}

// The limits whose stored readings are cleared when their window resets.
const CLEAN_AT_RESET = ['five_hour', 'seven_day', 'model-Fable'] as const

// The reset time each cleaned limit reports now, from the freshest source.
async function currentResets($: EngineInterface): Promise<Record<string, string | null>> {
  const s = await read($, snapshot)
  const acct = await read($, accountSession)
  const raw = s?.limits.find(l => l.kind === 'five_hour')
  const five = raw && s ? fiveHour(raw, s, acct) : null
  const fable = (await read($, modelLimits)).find(m => m.name === 'Fable')
  const seven = s?.limits.find(l => l.kind === 'seven_day')
  return {
    five_hour: five?.resetsAt ?? acct?.resetsAt ?? null,
    seven_day: seven?.resetsAt ?? null,
    'model-Fable': fable?.resetsAt ?? null,
  }
}

// Drops the 5h and Fable readings of windows that have reset; the rest as is.
function clean(h: History, resets: Record<string, string | null>, now: number): History {
  const out: History = { ...h }
  for (const key of CLEAN_AT_RESET) {
    const kept = dropEndedWindows(out[key] ?? [], resets[key], now)
    if (kept.length > 0) out[key] = kept
    else delete out[key]
  }
  return out
}

// The model family a limit's key is about: the per-model limits only.
function familyOf(key: string): string | null {
  return key.startsWith('model-') ? key.slice('model-'.length) : null
}

// Remembers a reading of a limit, here and in the shared store, with what
// had been spent on this limit's models by then.
async function record(
  $: EngineInterface,
  key: string,
  t: number,
  pct: number,
  w: string | null | undefined,
): Promise<void> {
  const stored = await storedHistory($)
  const mine = await read($, history)
  const spend = await read($, today)
  const fam = familyOf(key)
  const c = !spend ? null : fam ? (spend.byModel?.[fam] ?? 0) : spend.usd
  const sample: Sample = { t, pct, w: w ?? null, c, d: spend?.date ?? null }
  const merged = {
    ...stored,
    [key]: mergeSamples([stored[key], mine[key], [sample]], KEEP_MS[key] ?? KEEP_DEFAULT_MS, MAX_SAMPLES),
  }
  const next = clean(merged, await currentResets($), await $.clock.now())
  // A reading already known (the account's, polled again) changes nothing.
  if (JSON.stringify(next) !== JSON.stringify(stored)) await $.store.set(STORE_KEY, next)
  if (JSON.stringify(next) !== JSON.stringify(mine)) await update($, history, () => next)
}

// Takes in what other sessions recorded (and, after a restart, what came
// before), and clears readings of windows that have since reset.
async function syncHistory($: EngineInterface): Promise<void> {
  const stored = await storedHistory($)
  const mine = await read($, history)
  const merged: History = {}
  for (const key of new Set([...Object.keys(stored), ...Object.keys(mine)])) {
    merged[key] = mergeSamples([stored[key], mine[key]], KEEP_MS[key] ?? KEEP_DEFAULT_MS, MAX_SAMPLES)
  }
  const next = clean(merged, await currentResets($), await $.clock.now())
  if (JSON.stringify(next) !== JSON.stringify(stored)) await $.store.set(STORE_KEY, next)
  if (JSON.stringify(next) !== JSON.stringify(mine)) await update($, history, () => next)
}

// The estimate itself is pace.ts.

// ---- per-model weekly limits (Fable), from the app's cached account usage ----

// The engine hands mods the 5h and 7d windows only. The per-model weekly
// windows live in the account usage the app last fetched (what /usage shows),
// cached in ~/.claude.json; the helper reads that copy.
async function applyAccount($: EngineInterface, a: NonNullable<HelperOut['account']>): Promise<void> {
  const fetchedAt = a.fetchedAt
  const found: ModelLimit[] = a.models.map(m => ({ name: m.name, percent: m.percent, resetsAt: m.resetsAt, fetchedAt }))
  const prev = await read($, modelLimits)
  if (JSON.stringify(prev) !== JSON.stringify(found)) await update($, modelLimits, () => found)
  const next: ModelLimit | null = a.session
    ? { name: 'session', percent: a.session.percent, resetsAt: a.session.resetsAt, fetchedAt }
    : null
  const prevSess = await read($, accountSession)
  if (JSON.stringify(prevSess) !== JSON.stringify(next)) await update($, accountSession, () => next)
  for (const m of found) await record($, `model-${m.name}`, fetchedAt, m.percent, m.resetsAt)
  if (next) await record($, 'five_hour', fetchedAt, next.percent, next.resetsAt)
}

// The cached copy only moves when something fetches account usage. `/usage`
// in a headless run does that for free (no model call, nothing saved), so
// refresh it now and then; it takes several seconds, so never two at once.
const REFRESH_EVERY_MS = 5 * 60_000
let lastRefresh = 0
let isRefreshing = false

async function refreshAccountUsage($: EngineInterface, force: boolean): Promise<void> {
  const t = await $.clock.now()
  if (isRefreshing || (!force && t - lastRefresh < REFRESH_EVERY_MS)) return
  isRefreshing = true
  lastRefresh = t
  try {
    const home = await $.env.get('HOME')
    const local = home ? `${home}/.local/bin/claude` : ''
    const bin = local && (await $.fs.exists(local)) ? local : 'claude'
    await $.process.run([bin, '-p', '/usage', '--no-session-persistence', '--output-format', 'json'], {
      cwd: '/tmp',
      env: { USAGE_METER_CHILD: '1' },
      timeoutMs: 90_000,
    })
    await poll($, { account: true })
  } catch {
    // Not signed in, offline, or no CLI: keep the last copy.
  } finally {
    isRefreshing = false
  }
}

// The 5h window from whichever reading is newer: the last reply's or the account's.
function fiveHour(l: Limit, s: Snapshot, acct: ModelLimit | null): Limit {
  if (l.kind !== 'five_hour' || !acct || acct.fetchedAt <= s.measuredAt) return l
  return { kind: l.kind, percentUsed: acct.percent, resetsAt: acct.resetsAt ?? l.resetsAt }
}

// The band's refresh button: every figure at once, fetched fresh.
async function refreshAll($: EngineInterface): Promise<void> {
  if (await read($, refreshing)) return
  await update($, refreshing, () => true)
  try {
    await Promise.all([
      (async () => measure($, await $.session.usage()))(),
      refreshAccountUsage($, true),
      (async () => {
        lastScan = 0
        await poll($, { today: true, place: true, account: true })
      })(),
    ])
  } finally {
    await update($, refreshing, () => false)
  }
}

// ---- drawing ----

// Higher is better: most input re-read from cache keeps cost and limits down.
function cacheTone(percent: number): Tone {
  return percent >= 80 ? 'success' : percent >= 50 ? 'warning' : 'error'
}

function bar(percent: number): { full: string; empty: string } {
  // Any use at all shows at least one cell; a full window fills the bar.
  const filled = percent <= 0 ? 0 : Math.min(BAR_CELLS, Math.max(1, Math.round((percent / 100) * BAR_CELLS)))
  return { full: '━'.repeat(filled), empty: '━'.repeat(BAR_CELLS - filled) }
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = max - 1
  return `${text.slice(0, Math.ceil(keep / 2))}…${text.slice(text.length - Math.floor(keep / 2))}`
}

function countdown(msLeft: number): string {
  if (msLeft < 10 * 60_000) {
    // The last ten minutes count down by the second.
    const secs = Math.max(0, Math.floor(msLeft / 1000))
    return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`
  }
  const mins = Math.max(0, Math.ceil(msLeft / 60000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h${mins % 60}m`
  return `${mins}m`
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

// The nearest reset on the band, for the per-second countdown.
async function soonestReset($: EngineInterface, now: number): Promise<number> {
  const s = await read($, snapshot)
  const models = await read($, modelLimits)
  const acct = await read($, accountSession)
  const resets = [
    ...(s?.limits ?? []).map(l => (s ? fiveHour(l, s, acct) : l).resetsAt),
    ...models.map(m => m.resetsAt),
  ]
  let soonest = Infinity
  for (const r of resets) {
    const left = r ? Date.parse(r) - now : Infinity
    if (left > 0 && left < soonest) soonest = left
  }
  return soonest
}

// ---- the glow: a metric that changes lights up, then settles ----

// Flash in the accent color, hold bold, then back to normal. Only on a real
// change: the first value a metric shows does not glow.
const FLASH_MS = 400
const GLOW_MS = 1_400
const seen = new Map<string, { value: string; at: number }>()

function glowAge(key: string, value: string, now: number): number {
  const last = seen.get(key)
  if (!last) {
    seen.set(key, { value, at: -Infinity })
    return Infinity
  }
  if (last.value !== value) seen.set(key, { value, at: now })
  return now - (seen.get(key)?.at ?? -Infinity)
}

type Glow = { color?: string; bold?: boolean }
function glow(age: number, color?: string): Glow {
  if (age < FLASH_MS) return { color: 'claude', bold: true }
  if (age < GLOW_MS) return { color, bold: true }
  return { color }
}

// The frames after a change: one redraw as the flash ends, one as the glow does.
async function glowFrames($: EngineInterface): Promise<void> {
  await $.clock.sleep(FLASH_MS)
  $.ui.invalidate('ui.render')
  await $.clock.sleep(GLOW_MS - FLASH_MS)
  $.ui.invalidate('ui.render')
}

let started = false

// Everything the band runs on: the first readings, the wait loop, the account
// refresh and the tick. Once per load of the module, and only where a screen
// shows the band: a session with a surface, or the first ask to draw it.
async function start($: EngineInterface): Promise<void> {
  if (started) return
  started = true
  // The `/usage` refresh runs `claude -p`, which loads this mod too: there,
  // do nothing, or each refresh would start another.
  if ((await $.env.get('USAGE_METER_CHILD')) === '1') return
  helper = `${$.plugin.root}/bin/usage-meter-helper`
  // Which build last ran, for anyone checking the store by hand.
  await $.store.set('loaded', { version: VERSION, at: await $.clock.now() })
  await syncHistory($)
  await measure($, await $.session.usage())
  // Started by an ask to draw, which found nothing yet: ask again.
  $.ui.invalidate('ui.render')
  const gen = ++watchGen
  quietly(watchLoop($, gen))
  quietly(refreshAccountUsage($, true))

  let lastDrawn = 0
  let lastUsage = 0
  let lastSync = 0
  let lastPoll = 0
  $.clock.every(TICK_MS, () =>
    quietly(
      (async () => {
        const t = await $.clock.now()
        if (t - lastDrawn >= REDRAW_MS || (await soonestReset($, t)) < 10 * 60_000) {
          lastDrawn = t
          await update($, nowAtom, () => t)
        }
        if (t - lastUsage >= USAGE_EVERY_MS) {
          // The session's own cost, mid-turn too: the engine answers this for free.
          lastUsage = t
          await measure($, await $.session.usage())
        }
        if (t - lastSync >= 30_000) {
          lastSync = t
          await syncHistory($)
        }
        // Without the wait loop, poll: the folder and account every few
        // seconds, today's spend every SCAN_EVERY_MS (poll spaces that itself).
        if (!watching && t - lastPoll >= POLL_EVERY_MS) {
          lastPoll = t
          await poll($, { today: true, place: true, account: true })
        }
        quietly(refreshAccountUsage($, false))
      })(),
    ),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Headless runs (`claude -p`, other tools' background sessions) show no
    // band: start nothing there. A desktop session may attach its surface
    // later; its first ask to draw starts the mod then.
    if (e.surface !== null || e.isInteractive) await start($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      await measure($, e)
    }
    // A turn may have spent, or switched branch or directory; the watcher
    // sees that by itself, so this is the fallback only.
    if (!watching) quietly(poll($, { today: e.changed.includes('cost'), place: true }))
    return next(e)
  })

  // Compact readout in the footer, beside the other mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const s = await read($, snapshot)
    const models = await read($, modelLimits)
    const acct = await read($, accountSession)
    const parts = [
      ...(s?.limits ?? [])
        .map(l => (s ? fiveHour(l, s, acct) : l))
        .map(l => `${LABELS[l.kind] ?? l.kind} ${l.percentUsed}%`),
      ...models.map(m => `${m.name} ${m.percent}%`),
    ]
    if (parts.length === 0) return next(e)
    const label = parts.join(' · ')
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!started) quietly(start($))
    const s = await read($, snapshot)
    if (e.props.hasSurvey || !s) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, nowAtom)
    const isBusy = await read($, refreshing)
    const t = await read($, today)
    const p = await read($, place)
    const models = await read($, modelLimits)
    const acct = await read($, accountSession)
    const hist = await read($, history)

    // A metric whose value differs from the last draw glows for a moment.
    const clockNow = await $.clock.now()
    let changed = false
    const lit = (key: string, value: string, color?: string): Glow => {
      const age = glowAge(key, value, clockNow)
      if (age === 0) changed = true
      return glow(age, color)
    }

    // One row that wraps whole segments onto the next line, never mid-item.
    const band = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {p && (
          <Box key="place" flexShrink={0}>
            <Text wrap="truncate-end">
              <Text bold>{shorten(p.folder, 24)}</Text>
              {p.branch && <Text dimColor> ⎇ </Text>}
              {p.branch && <Text {...lit('branch', p.branch, 'suggestion')}>{shorten(p.branch, 48)}</Text>}
            </Text>
          </Box>
        )}
        {s.limits.map(raw => {
          const l = fiveHour(raw, s, acct)
          const b = bar(l.percentUsed)
          const msLeft = l.resetsAt ? Date.parse(l.resetsAt) - now : null
          const pc = pace(hist[l.kind] ?? [], l.percentUsed, l.resetsAt, WINDOW_MS[l.kind] ?? 5 * HOUR, now, activity(t, null, now))
          const g = lit(l.kind, String(l.percentUsed), pc.tone)
          return (
            <Box key={l.kind} flexShrink={0}>
              <Text wrap="truncate-end">
                <Text dimColor>{LABELS[l.kind] ?? l.kind} </Text>
                <Text {...g}>{b.full}</Text>
                <Text dimColor>{b.empty}</Text>
                <Text {...g}> {l.percentUsed}%</Text>
                {msLeft !== null && <Text dimColor> ↻ </Text>}
                {msLeft !== null && <Text color={pc.tone}>{countdown(msLeft)}</Text>}
                {pc.tone !== 'success' && pc.msToEmpty !== null && <Text dimColor>/</Text>}
                {pc.tone !== 'success' && pc.msToEmpty !== null && (
                  <Text color={pc.tone}>{countdown(pc.msToEmpty)}</Text>
                )}
              </Text>
            </Box>
          )
        })}
        {models.map(m => {
          const msLeft = m.resetsAt ? Date.parse(m.resetsAt) - now : null
          const isReset = msLeft !== null && msLeft <= 0
          const b = bar(isReset ? 0 : m.percent)
          const pc = pace(hist[`model-${m.name}`] ?? [], m.percent, m.resetsAt, WINDOW_MS.weekly ?? 7 * 24 * HOUR, now, activity(t, m.name, now))
          const g = lit(`model-${m.name}`, isReset ? 'reset' : String(m.percent), pc.tone)
          return (
            <Box key={`model-${m.name}`} flexShrink={0}>
              <Text wrap="truncate-end">
                <Text dimColor>{m.name} </Text>
                <Text {...g}>{b.full}</Text>
                <Text dimColor>{b.empty}</Text>
                {isReset && <Text dimColor> reset</Text>}
                {!isReset && <Text {...g}> {m.percent}%</Text>}
                {!isReset && msLeft !== null && <Text dimColor> ↻ </Text>}
                {!isReset && msLeft !== null && <Text color={pc.tone}>{countdown(msLeft)}</Text>}
                {!isReset && pc.tone !== 'success' && pc.msToEmpty !== null && <Text dimColor>/</Text>}
                {!isReset && pc.tone !== 'success' && pc.msToEmpty !== null && (
                  <Text color={pc.tone}>{countdown(pc.msToEmpty)}</Text>
                )}
              </Text>
            </Box>
          )
        })}
        {(s.costUsd !== null || t) && (
          <Box key="cost" flexShrink={0}>
            <Text wrap="truncate-end">
              {s.costUsd !== null && <Text dimColor>session </Text>}
              {s.costUsd !== null && <Text {...lit('session', usd(s.costUsd))}>{usd(s.costUsd)}</Text>}
              {s.costUsd !== null && t && <Text dimColor>{'  ·  '}</Text>}
              {t && <Text dimColor>today </Text>}
              {t && <Text {...lit('today', usd(t.usd))}>{usd(t.usd)}</Text>}
              {t && t.cacheHit !== null && <Text dimColor>{'  ·  '}cache </Text>}
              {t && t.cacheHit !== null && <Text {...lit('cache', String(Math.round(t.cacheHit)), cacheTone(t.cacheHit))}>{Math.round(t.cacheHit)}%</Text>}
            </Text>
          </Box>
        )}
        <Box key="refresh-slot" flexShrink={0}>
          <Button
            key="refresh"
            plain
            dimColor
            label={isBusy ? '…' : '↻ refresh'}
            onPress={() => quietly(refreshAll($))}
          />
        </Box>
      </Box>
    )
    if (changed) quietly(glowFrames($))
    return band
  })
}
