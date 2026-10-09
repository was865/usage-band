import { expect, mock, test } from 'claude-code/testing'

import { bar, cacheLeft, countdown, hitRate, kTokens, resetIn, rowSvg, tone } from './register'

test('helpers', async () => {
  expect(bar(50)).toBe('█████     ')
  expect(bar(55, 10)).toBe('█████▌    ')
  expect(bar(0, 4)).toBe('    ')
  expect(tone(90)).toBe('red')
  expect(tone(70)).toBe('yellow')
  expect(tone(10)).toBe('green')
  expect(kTokens(123456)).toBe('123k')
  expect(kTokens(1_000_000)).toBe('1M')
  expect(resetIn('2026-10-09T12:30:00Z', Date.parse('2026-10-09T10:00:00Z'))).toBe('2h30m')
})

test('cache helpers', async () => {
  expect(hitRate({ input_tokens: 2, cache_read_input_tokens: 96, cache_creation_input_tokens: 2 })).toBe(96)
  expect(hitRate({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(null)
  expect(countdown(42 * 60_000 + 5000)).toBe('42m')
  expect(countdown(30_000)).toBe('<1m')
  expect(countdown(0)).toBe('cold')
  expect(cacheLeft({ at: 0, hit: 90 }, 3_600_000, 2_700_000)).toEqual({ ms: 900_000, share: 0.25 })
})

test('svg row carries every figure', async () => {
  const svg = rowSvg(
    { contextPercent: 42, contextTokens: 84000, contextWindow: 200000, limits: [{ kind: 'seven_day', percentUsed: 91 }], usd: 3.5 },
    900,
    600_000,
    { at: 0, hit: 96 },
    3_600_000,
  )
  expect(svg).toContain('Cache')
  expect(svg).toContain('96%')
  expect(svg).toContain('◷ 50m')
  expect(svg).toContain('84k / 200k')
  expect(svg).toContain('42%')
  expect(svg).toContain('7d')
  expect(svg).toContain('91%')
  expect(svg).toContain('$3.50')
})

test('a short context fill keeps its true width', async () => {
  const usage = { contextPercent: 9, contextTokens: 85000, contextWindow: 1_000_000, limits: [], usd: null }
  const svg = rowSvg(usage, 400, 0)
  // The label moves into the empty track instead of a pill wider than the fill.
  expect(svg).toContain('<text class="ub-m"')
  expect(svg).toContain('85k / 1M')
  expect(svg).not.toContain('fill="#fff">85k')
  expect(rowSvg({ ...usage, contextPercent: 60, contextTokens: 600_000 }, 900, 0)).toContain('fill="#fff">600k / 1M')
})

test('band shows context, limits and cost on every surface', async ($, on) => {
  const mockClock = mock.clock(on, { now: Date.parse('2026-10-09T10:00:00Z') })
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 84000, window: 200000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-09T12:30:00Z' }],
    cost: { usd: 1.234 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await $.turn.complete({
    answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 980, cache_creation_input_tokens: 10 } as never,
  })
  await mockClock.advance(18 * 60_000)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: {} as never })
    const svg = await ui.find({ type: 'Svg' })
    if (svg) {
      expect(String(svg.props.alt)).toBe('Context 42%, Cache 98%, 42m, 5h 24%, $1.23')
      expect(String(svg.props.source)).toContain('↻ 2h12m')
    } else {
      expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /↻2h12m/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /98%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /42m/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\$1\.23/ })).toBeDefined()
    }
    await ui.unmount()
  }
})
