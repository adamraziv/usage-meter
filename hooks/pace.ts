import type { Sample, Today } from '../types'

/**
 * Will this limit run out before it resets?
 *
 * The rate (% per ms) is estimated from what was observed, never from an
 * assumed window length where that can be avoided:
 *
 *   activity  how much % a dollar costs (calibrated from this window's own
 *           readings) times what is being spent per minute right now, from
 *           the replies of every session over the last 15 minutes: it moves
 *           with each reply, and idling is zero, exactly
 *   recent  the slope over the readings of the last fifth of the window
 *           (an hour of a 5h window), the best guide to what comes next
 *   whole   the slope from the earliest reading of this window to the latest:
 *           smoother, and it needs no idea of when the window opened
 *   prior   the average since the window nominally opened (reset − length);
 *           the only estimate on a cold start, and the only one that can be
 *           wrong when a window is not its nominal length
 *
 * Each observed slope is trusted by its span: weight = span / (span + τ),
 * so two readings a minute apart (rounding noise alone can make that 1%/min)
 * barely count, and an hour of readings nearly fully. The rest of the weight
 * goes to the next estimate down; with none left, to zero, which reads as
 * "nothing to worry about yet". The prior thus fades within the first τ-ish
 * of observed readings, and a window of any length is estimated right once
 * it has been watched for a while.
 */

export type Tone = 'success' | 'warning' | 'error'
export type Pace = { tone: Tone; msToEmpty: number | null; rate: number | null }

const HOUR = 3600_000

/** How far back "recent" reaches, as a share of the window: an hour of 5h. */
export const RECENT_SHARE = 1 / 5
/** The span at which an observed slope and its fallback weigh the same: 10 min of 5h. */
export const TAU_SHARE = 1 / 30
/** The prior is not trusted before this much of the window has passed: 15 min of 5h. */
export const WARMUP_SHARE = 1 / 20
/** The prior is not trusted below this much use: too little to average. */
export const PRIOR_MIN_PCT = 5
/** A last reading older than this is joined by "now, same %": idling counts. */
export const STALE_MS = 5 * 60_000
/** Running out within this is red; before the reset but later is yellow. */
export const URGENT_MS = HOUR
/** Spend over this long, divided by it, is the activity. */
export const ACTIVITY_MS = 15 * 60_000
/** The % a calibration spans at which it and the slopes weigh the same. */
export const CALIBRATION_TAU_PCT = 5

/** $ per ms spent lately on a family's models (all of them for `null`). */
export function activity(spend: Pick<Today, 'recent'> | null, family: string | null, now: number): number | null {
  if (!spend?.recent) return null
  let usd = 0
  for (const [t, cost, fam] of spend.recent) {
    if (now - t <= ACTIVITY_MS && now - t >= 0 && (family === null || fam === family)) usd += cost
  }
  return usd / ACTIVITY_MS
}

type Calibration = { perUsd: number; spanPct: number }

/** How much % a dollar costs: the widest same-day pair of readings with spend. */
function calibrate(points: readonly Sample[]): Calibration | null {
  const priced = points.filter(x => typeof x.c === 'number' && x.d)
  const last = priced[priced.length - 1]
  if (!last) return null
  const first = priced.find(x => x.d === last.d)
  if (!first || first === last) return null
  const dPct = last.pct - first.pct
  const dUsd = (last.c ?? 0) - (first.c ?? 0)
  if (dPct <= 0 || dUsd <= 0) return null
  return { perUsd: dPct / dUsd, spanPct: dPct }
}

type Slope = { rate: number; span: number }

function slope(points: readonly Sample[]): Slope | null {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || last.t <= first.t) return null
  return { rate: (last.pct - first.pct) / (last.t - first.t), span: last.t - first.t }
}

/** The slope weighed by its span against what it falls back to (or zero). */
function blend(obs: Slope | null, fallback: number | null, tauMs: number): number | null {
  if (!obs) return fallback
  const w = obs.span / (obs.span + tauMs)
  return w * obs.rate + (1 - w) * (fallback ?? 0)
}

export function pace(
  samples: readonly Sample[],
  pct: number,
  resetsAt: string | null | undefined,
  windowMs: number,
  now: number,
  usdPerMs: number | null = null,
): Pace {
  const msToReset = resetsAt ? Date.parse(resetsAt) - now : Infinity
  if (msToReset <= 0) return { tone: 'success', msToEmpty: null, rate: null }
  if (pct >= 100) return { tone: 'error', msToEmpty: 0, rate: null }

  // The readings, in order; and now at the current % when the last one is
  // old, since nothing having moved since is itself a reading.
  const points = [...samples].sort((a, b) => a.t - b.t)
  const last = points[points.length - 1]
  if (!last || now - last.t > STALE_MS) points.push({ t: now, pct })

  const recent = slope(points.filter(x => now - x.t <= windowMs * RECENT_SHARE))
  const whole = slope(points)
  const tau = windowMs * TAU_SHARE

  let prior: number | null = null
  if (resetsAt) {
    const elapsed = now - (Date.parse(resetsAt) - windowMs)
    if (elapsed >= windowMs * WARMUP_SHARE && pct >= PRIOR_MIN_PCT) prior = pct / elapsed
  }

  let rate = prior
  // The whole window adds nothing when the recent readings are all of it.
  if (whole && whole.span !== recent?.span) rate = blend(whole, rate, tau)
  rate = blend(recent, rate, tau)

  // On top, the activity: trusted by how much % its calibration spans.
  const cal = usdPerMs === null ? null : calibrate(points)
  if (cal && usdPerMs !== null) {
    const w = cal.spanPct / (cal.spanPct + CALIBRATION_TAU_PCT)
    rate = w * cal.perUsd * usdPerMs + (1 - w) * (rate ?? 0)
  }

  if (rate === null || rate <= 0) return { tone: 'success', msToEmpty: null, rate }
  const msToEmpty = (100 - pct) / rate
  if (msToEmpty >= msToReset) return { tone: 'success', msToEmpty, rate }
  return { tone: msToEmpty <= URGENT_MS ? 'error' : 'warning', msToEmpty, rate }
}
