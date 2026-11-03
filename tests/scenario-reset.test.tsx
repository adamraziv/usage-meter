import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The scenario: 70% of the 5h window used (30% left), the app closes, the
// window resets while it is closed, the app opens again. Two tests, two loads
// of the mod; `disk` is the mod's store, which outlives the app.
const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse('2026-10-14T11:00:00Z')
const OLD_RESET = '2026-10-14T15:00:00Z'
const FABLE_RESET = '2026-10-17T19:00:00Z'
const disk = new Map<string, unknown>()
const frames: string[] = []

type Acct = { fetchedAt: number; session: { percent: number; resetsAt: string | null } | null; models: unknown[] }
let rateLimits: { kind: string; percentUsed: number; resetsAt: string }[] = []
let cache: Acct | null = null // ~/.claude.json's cachedUsageUtilization
let afterUsageFetch: (() => void) | null = null // what `claude -p /usage` writes there

function stubs(on: On, now: number) {
  const clock = mock.clock(on, { now })
  on('store.get', (_$, e) => ({ value: disk.get(e.key) }) as never)
  on('store.set', (_$, e) => (disk.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }) as never)
  on('store.delete', (_$, e) => (disk.delete(e.key), { value: undefined }) as never)
  on('store.keys', () => ({ value: [...disk.keys()] }) as never)
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200000 }, rateLimits, cost: { usd: 0 } } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.cwd', () => ({ value: '/tmp/x' }))
  on('session.id', () => ({ value: 'S1' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_$, e) => {
    if (e.argv[1] === '--wait') return { value: { exitCode: 1, stdout: '', stderr: '' } } as never
    if (e.argv[1] === '-p') {
      afterUsageFetch?.()
      return { value: { exitCode: 0, stdout: '{}', stderr: '' } } as never
    }
    const out: Record<string, unknown> = e.argv.includes('--account') ? { account: cache } : {}
    if (e.argv.includes('--today')) out.today = { usd: 12.5, cacheHit: 90, byModel: { Fable: 2 }, recent: [], date: '2026-10-14' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } } as never
  })
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>{''}</Text>
  })
  return clock
}

const at = (ms: number) => new Date(ms).toISOString().slice(11, 16) + ' UTC'

// The band as one line, colored runs marked [tone|text].
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown } | string | number | null | undefined
function line(el: unknown, inherit: { color?: string; dim?: boolean } = {}): string {
  if (el === null || el === undefined || el === false) return ''
  if (typeof el === 'string' || typeof el === 'number') {
    const s = String(el)
    if (!s.trim()) return s
    const tag = inherit.color ?? (inherit.dim ? 'dim' : '')
    return tag ? `[${tag}|${s}]` : s
  }
  if (Array.isArray(el)) return el.map(x => line(x, inherit)).join('')
  const n = el as Exclude<Node, string | number | null | undefined>
  const p = (n.props ?? {}) as Record<string, unknown>
  const style = {
    color: (p.color as string | undefined) ?? inherit.color,
    dim: (p.dimColor as boolean | undefined) ?? inherit.dim,
  }
  if (p.bold && p.color) style.color = `${p.color}*`
  if (n.type === 'Button') return `[button|${p.label as string}]`
  const kids = p.children ?? n.children
  const inner = Array.isArray(kids) ? kids.map(k => line(k, style)) : [line(kids, style)]
  return n.type === 'Box' && (p.flexDirection === 'row') ? inner.filter(Boolean).join('   ') : inner.join('')
}

async function frame($: Parameters<Parameters<typeof test>[1]>[0], now: number, label: string) {
  const ui = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  let text = line(await ui.drawn())
  for (let prev = ''; prev !== text; ) {
    prev = text
    text = text.replace(/\[([^|\]]+)\|([^\]]*)\]\[\1\|([^\]]*)\]/g, '[$1|$2$3]')
  }
  await ui.unmount()
  frames.push(`@ ${at(now)}  ${label}\n   ${text || '(no band)'}\n   store: ${JSON.stringify(disk.get('history'))}`)
  return text
}

test('before closing: 70% used, burning 15%/h', { timeoutMs: 60_000 }, async ($, on) => {
  disk.clear()
  let now = T0
  const clock = stubs(on, now)
  cache = { fetchedAt: now, session: { percent: 55, resetsAt: OLD_RESET }, models: [{ name: 'Fable', percent: 12, resetsAt: FABLE_RESET }] }
  await $.session.start({ source: 'startup', cwd: '/tmp/x', surface: 'desktop', isInteractive: true } as never)
  for (const [mins, pct] of [[0, 55], [30, 62], [60, 70]] as const) {
    await clock.advance(mins * MIN - (now - T0))
    now = T0 + mins * MIN
    rateLimits = [
      { kind: 'five_hour', percentUsed: pct, resetsAt: OLD_RESET },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-20T00:00:00Z' },
    ]
    await $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] } as never)
  }
  await clock.advance(3_000)
  const text = await frame($, now, 'last look before the app closes')
  // Each reading carries that day's spend on its limit's models, for calibration.
  const saved = disk.get('history') as Record<string, { c?: number | null; d?: string | null }[]>
  expect(saved.five_hour?.at(-1)).toMatchObject({ c: 12.5, d: '2026-10-14' })
  expect(saved['model-Fable']?.at(-1)).toMatchObject({ c: 2, d: '2026-10-14' })
  expect(text).toContain('[warning|70%]')
  expect(text).toContain('[warning|3h0m][dim|/][warning|1h50m]')
})

test('reopened at 16:00, an hour after the 15:00 reset', { timeoutMs: 60_000 }, async ($, on) => {
  let now = Date.parse('2026-10-14T16:00:00Z')
  const clock = stubs(on, now)
  // A fresh session: no reply yet, so the engine has no 5h/7d reading.
  rateLimits = []
  // ~/.claude.json still holds the copy fetched before closing.
  cache = { fetchedAt: Date.parse('2026-10-14T12:00:00Z'), session: { percent: 70, resetsAt: OLD_RESET }, models: [{ name: 'Fable', percent: 13, resetsAt: FABLE_RESET }] }
  // The background `/usage` fetch brings the new, not yet started window.
  afterUsageFetch = () => {
    cache = { fetchedAt: now, session: { percent: 0, resetsAt: null }, models: [{ name: 'Fable', percent: 13, resetsAt: FABLE_RESET }] }
  }
  frames.length = 0
  frames.push(`--- reopen; store on disk: ${JSON.stringify(disk.get('history'))}`)
  await $.session.start({ source: 'startup', cwd: '/tmp/x', surface: 'desktop', isInteractive: true } as never)
  const first = await frame($, now, 'app open, first draw')
  // The old window's readings are gone the moment the mod loads; Fable's stay.
  const stored = disk.get('history') as Record<string, unknown[]>
  expect(stored.five_hour).toBeUndefined()
  expect(stored['model-Fable']).toBeDefined()
  expect(first).not.toContain('70%')
  await clock.advance(2_000)
  now += 2_000
  await frame($, now, '2s later (account refresh done)')

  // First message in the new window: it starts at 16:00, resets at 21:00.
  const NEW_RESET = '2026-10-14T21:00:00Z'
  const shown: string[] = []
  const steps: [number, number][] = [[1, 1], [11, 4], [20, 8], [40, 16], [60, 25]]
  for (const [mins, pct] of steps) {
    const target = Date.parse('2026-10-14T16:00:00Z') + mins * MIN
    await clock.advance(target - now)
    now = target
    rateLimits = [
      { kind: 'five_hour', percentUsed: pct, resetsAt: NEW_RESET },
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-20T00:00:00Z' },
    ]
    await $.session.measure({ context: { window: 200000 }, rateLimits, changed: ['rateLimits'] } as never)
    await clock.advance(3_000)
    now += 3_000
    shown.push(await frame($, now, `reply: 5h at ${pct}%`))
  }
  // The estimate is rebuilt from the new window's readings alone.
  expect(shown[0]).toContain('[success|1%]')
  expect(shown[1]).toContain('[success|4h49m]') // 1 -> 4% in 10m: lasts past the reset
  expect(shown[2]).toContain('[warning|4h40m][dim|/][warning|4h3m]') // 1 -> 8% in 19m
  expect(shown[4]).toMatch(/\[warning\|4h0m\]\[dim\|\/\]\[warning\|3h\d+m\]/)
})
