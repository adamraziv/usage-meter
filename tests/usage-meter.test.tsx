import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.parse('2026-10-14T12:00:00Z')

test('limits as bars with live reset countdowns, session and today cost', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('session.cwd', () => ({ value: '/Users/me/code/voltron' }))
  on('session.id', () => ({ value: 'S1' }))
  // The Rust helper answers whichever parts the mod asks for.
  const helperCalls: string[][] = []
  on('process.run', (_$, e) => {
    if (e.argv[1] === '-p') return { value: { exitCode: 0, stdout: '{}', stderr: '' } } as never
    if (e.argv[1] === '--wait') return { value: { exitCode: 1, stdout: '', stderr: 'no watching here' } } as never
    helperCalls.push([...e.argv])
    const out: Record<string, unknown> = {}
    if (e.argv.includes('--today')) out.today = { usd: 49.18, replies: 300, sessions: 6, cacheHit: 93.6, unpriced: [] }
    if (e.argv.includes('--place')) out.place = { folder: 'voltron', branch: 'feat/usage-band' }
    if (e.argv.includes('--account')) {
      out.account = {
        fetchedAt: NOW + 1000,
        session: { percent: 41, resetsAt: '2026-10-14T12:30:00Z' },
        models: [{ name: 'Fable', percent: 40, resetsAt: '2026-10-17T19:00:00Z' }],
      }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } } as never
  })
  // The wait loop fails here (exit 1), so this covers the polling fallback.
  let usageCalls = 0
  let usageCost = 0
  let rateLimits: { kind: string; percentUsed: number; resetsAt: string }[] = []
  on('session.usage', () => {
    usageCalls += 1
    return { value: { startedAt: NOW - 60_000, context: { window: 200000 }, rateLimits, cost: { usd: usageCost } } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>{e.component === 'SessionMode' ? (e.props as { modes: string[] }).modes.join(' & ') : ''}</Text>
  })

  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  rateLimits = [
    { kind: 'five_hour', percentUsed: 33, resetsAt: '2026-10-14T12:30:00Z' },
    { kind: 'seven_day', percentUsed: 75, resetsAt: '2026-10-20T12:00:00Z' },
  ]
  usageCost = 1.32
  await $.session.measure({ context: { window: 200000 }, rateLimits, cost: { usd: usageCost }, changed: ['rateLimits', 'cost'] })
  await clock.advance(1_000) // the first tick polls, with no watcher running

  // Without the watcher, the mod's own binary is polled for all three parts.
  expect(helperCalls.every(c => /\/bin\/usage-meter-helper$/.test(c[0] ?? ''))).toBe(true)
  expect(helperCalls.some(c => c.includes('--today'))).toBe(true)
  expect(helperCalls.some(c => c.includes('--place'))).toBe(false)
  expect(helperCalls.some(c => c.includes('--account'))).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'AbovePrompt', props: { hasSurvey: false } as never })
    expect(await band.find({ type: 'Text', text: /^━━$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^ 41%$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^30m$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^6d0h$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^\$1\.32$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^\$49\.18$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^94%$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /sessions/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /^voltron$/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /^Fable $/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^ 40%$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^3d7h$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /as of/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /^feat\/usage-band$/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /Context/ })).toBeUndefined()
    await band.unmount()

    const footer = await $.ui.mount({ plugin: 'usage-meter', surface, component: 'SessionMode', props: { modes: [] } })
    expect(await footer.find({ type: 'Text', text: /5h 41% · 7d 75% · Fable 40%/ })).toBeDefined()
    await footer.unmount()
  }

  // The countdown moves on its own.
  await clock.advance(10 * 60_000)
  const ticked = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await ticked.find({ type: 'Text', text: /^20m$/ })).toBeDefined()
  await ticked.unmount()

  // The refresh button re-runs every source.
  usageCost = 2
  const before = usageCalls
  {
    const band = await $.ui.mount({ plugin: 'usage-meter', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
    await band.press({ key: 'refresh' })
    expect(usageCalls).toBe(before + 1)
    expect(await band.find({ type: 'Text', text: /^\$2\.00$/ })).toBeDefined()
    await band.unmount()
  }

})
