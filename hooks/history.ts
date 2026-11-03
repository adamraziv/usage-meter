import type { Sample } from '../types'

/**
 * Merges readings of one limit from several places (this session, the shared
 * store other sessions write to) into one ordered list, keeping what the pace
 * needs: the readings within `keepMs` of the newest, at most `max` of them.
 * Over the cap, the reading whose neighbours are closest in time goes first,
 * so the earliest and latest always stay and the rest thin out evenly.
 *
 * A drop of `resetDrop` points or more means the window reset, so everything
 * before it goes; a smaller drop is a stale source arriving late, so that
 * reading is skipped.
 */
export function mergeSamples(
  lists: readonly (readonly Sample[] | undefined)[],
  keepMs: number,
  max: number,
  resetDrop = 20,
): Sample[] {
  const byTime = new Map<number, Sample>()
  for (const list of lists) for (const x of list ?? []) byTime.set(x.t, x)
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t)

  let out: Sample[] = []
  for (const x of sorted) {
    const last = out[out.length - 1]
    if (last && x.pct < last.pct) {
      if (last.pct - x.pct < resetDrop) continue
      out = []
    }
    out.push(x)
  }
  const newest = out[out.length - 1]?.t ?? 0
  out = out.filter(x => newest - x.t <= keepMs)
  while (out.length > max) {
    let drop = 1
    let tightest = Infinity
    for (let i = 1; i < out.length - 1; i++) {
      const gap = (out[i + 1]?.t ?? 0) - (out[i - 1]?.t ?? 0)
      if (gap < tightest) {
        tightest = gap
        drop = i
      }
    }
    out.splice(drop, 1)
  }
  return out
}

/**
 * Reset times from different sources differ by moments (12:50:00.000 from a
 * reply, 12:49:59.926 from the account); a new window moves it by hours.
 */
export const SAME_WINDOW_MS = 15 * 60_000

export function sameWindow(a: string, b: string): boolean {
  const da = Date.parse(a)
  const db = Date.parse(b)
  return Number.isFinite(da) && Number.isFinite(db) && Math.abs(da - db) <= SAME_WINDOW_MS
}

/**
 * Keeps only the readings of the window that is still open: drops those whose
 * window has reset (`now` is past its reset time) and those from a window other
 * than `current` (the limit now reports a different reset: a new window began).
 * Reset times are compared, never computed, so windows of any length or start
 * time, and resets that move, are handled alike. Untagged readings go too.
 */
export function dropEndedWindows(
  samples: readonly Sample[],
  current: string | null | undefined,
  now: number,
): Sample[] {
  return samples.filter(x => {
    if (!x.w) return false
    const ends = Date.parse(x.w)
    if (!Number.isFinite(ends) || ends <= now) return false
    return !current || sameWindow(x.w, current)
  })
}
