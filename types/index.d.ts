export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  limits: Limit[]
  measuredAt: number
  costUsd: number | null
}

/** A reply the helper saw lately: when (ms), what it cost, the model family. */
export type Reply = [t: number, usd: number, family: string]

export type Today = {
  usd: number
  cacheHit: number | null
  /** Today's spend by model family ("Fable", "Opus"), as the limits name them. */
  byModel?: Record<string, number>
  /** The last hour's replies across every session, for the pace's activity. */
  recent?: Reply[]
  /** The local date the totals are for; spend is only compared within a day. */
  date?: string | null
}

export type ModelLimit = { name: string; percent: number; resetsAt: string | null; fetchedAt: number }

/**
 * One reading of a limit: when it was true, the % used then, and the reset
 * time of the window it was read in (`w`), which names that window. `c` is
 * what had been spent that day (`d`) in this limit's share of the models when
 * it was read, so two readings calibrate how much % a dollar costs.
 */
export type Sample = { t: number; pct: number; w?: string | null; c?: number | null; d?: string | null }


declare module 'claude-code' {
  interface PluginState {
    'usage-meter': { snapshot: Snapshot | null; today: Today | null; modelLimits: ModelLimit[]; accountSession: ModelLimit | null; isRefreshing: boolean; history: Record<string, Sample[]>; now: number }
  }
}
