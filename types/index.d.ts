export type Usage = {
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd: number | null
}

/** When the main thread's last request landed and how much of its prompt the cache served. */
export type Cache = { at: number; hit: number | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Usage | null; cache: Cache | null; tick: number }
  }
}
