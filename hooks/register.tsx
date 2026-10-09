import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Cache, Usage } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, null)
// Bumped on a timer while the cache is warm, so the countdown redraws.
const tick = atom({ plugin: 'usage-band', key: 'tick' } as const, 0)

const TTL_MS: Record<string, number> = { '1h': 3_600_000, '5m': 300_000 }

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'Spend' }

// Calm below 60%, warm toward the limit, red past 85%.
const CLAY = '#D97757'
const AMBER = '#E0A030'
const RED = '#E5484D'
const BLUE = '#7C8CF8'
const TEAL = '#3FB8A0'

export const tone = (percent: number) => (percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : 'green')
const hue = (percent: number, calm: string) => (percent >= 85 ? RED : percent >= 60 ? AMBER : calm)

export const kTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

export const resetIn = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : h > 0 ? `${h}h${m}m` : `${m}m`
}

const pct = (n: number) => `${Math.round(n)}%`

// Share of the last request's prompt read back from the cache.
export const hitRate = (u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) => {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return total > 0 ? (u.cache_read_input_tokens / total) * 100 : null
}

// What is left of the cache's lifetime: ms remaining and the share left, 0 once cold.
export const cacheLeft = (c: Cache, ttl: number, now: number) => {
  const ms = Math.max(0, c.at + ttl - now)
  return { ms, share: ms / ttl }
}

export const countdown = (ms: number) => {
  if (ms <= 0) return 'cold'
  const m = Math.floor(ms / 60_000)
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`
  return m >= 1 ? `${m}m` : '<1m'
}

// Eighth blocks give the terminal bar a smooth head.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
export const bar = (percent: number, width = 10) => {
  const units = Math.max(0, Math.min(width * 8, Math.round((percent / 100) * width * 8)))
  const full = Math.floor(units / 8)
  const head = EIGHTHS[units % 8] ?? ''
  return '█'.repeat(full) + head + ' '.repeat(width - full - (head ? 1 : 0))
}

const toUsage = (u: {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}): Usage => ({
  contextPercent: u.context.percent ?? null,
  contextTokens: u.context.tokens ?? null,
  contextWindow: u.context.window,
  limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  usd: u.cost?.usd ?? null,
})

// ---- Desktop: the whole row is one SVG, so nothing wraps. ----

const H = 24
const BAR_H = 16
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Rough advance of system UI text, enough to lay segments side by side.
const textW = (s: string, size: number) =>
  [...s].reduce(
    (w, ch) => w + (/[\s.,:|il()]/.test(ch) ? 0.32 : /[A-Z%$@mw↻]/.test(ch) ? 0.82 : /[0-9]/.test(ch) ? 0.64 : 0.6) * size,
    0,
  )

// Fixed noise so the dither holds still between redraws.
const noise = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

const ring = (cx: number, cy: number, r: number, percent: number, color: string) => {
  const c = 2 * Math.PI * r
  const dash = (Math.min(100, Math.max(0, percent)) / 100) * c
  return `<circle class="ub-ring" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="3"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`
}

export const rowSvg = (u: Usage, W: number, now: number, c: Cache | null = null, ttl = TTL_MS['1h']!) => {
  const parts: string[] = []
  const cy = H / 2

  // Right side first: limits and cost take what they need, the bar gets the rest.
  const right: { w: number; draw: (x: number) => string }[] = []
  const showReset = W > 560
  if (c) {
    const { ms, share } = cacheLeft(c, ttl, now)
    const isCold = ms <= 0
    const hit = c.hit === null ? '—' : pct(c.hit)
    const left = countdown(ms)
    const color = share < 0.2 ? AMBER : TEAL
    const w = 22 + textW('Cache', 11) + 4 + textW(hit, 12.5) + 6 + textW(`◷ ${left}`, 11)
    right.push({
      w,
      draw: x => {
        // The ring drains as the cache ages; a cold cache leaves only the track.
        let s = isCold ? ring(x + 8, cy, 7, 0, color) : ring(x + 8, cy, 7, share * 100, color)
        let tx = x + 22
        s += `<text class="ub-m" x="${tx}" y="${cy + 4}" font-size="11" font-weight="500">Cache</text>`
        tx += textW('Cache', 11) + 4
        s += `<text class="${isCold ? 'ub-m' : 'ub-t'}" x="${tx}" y="${cy + 4.5}" font-size="12.5" font-weight="600">${hit}</text>`
        tx += textW(hit, 12.5) + 6
        s += `<text class="ub-m" x="${tx}" y="${cy + 4}" font-size="11"${isCold ? '' : ` fill="${color}" style="fill:${color}"`}>◷ ${left}</text>`
        return s
      },
    })
  }
  for (const l of u.limits) {
    const name = LABELS[l.kind] ?? l.kind
    const reset = showReset ? resetIn(l.resetsAt, now) : ''
    const value = pct(l.percentUsed)
    const color = hue(l.percentUsed, BLUE)
    const w = 22 + textW(name, 11) + 4 + textW(value, 12.5) + (reset ? 6 + textW(`↻ ${reset}`, 11) : 0)
    right.push({
      w,
      draw: x => {
        let s = ring(x + 8, cy, 7, l.percentUsed, color)
        let tx = x + 22
        s += `<text class="ub-m" x="${tx}" y="${cy + 4}" font-size="11" font-weight="500">${xml(name)}</text>`
        tx += textW(name, 11) + 4
        s += `<text class="ub-t" x="${tx}" y="${cy + 4.5}" font-size="12.5" font-weight="600">${value}</text>`
        tx += textW(value, 12.5) + 6
        if (reset) s += `<text class="ub-m" x="${tx}" y="${cy + 4}" font-size="11">↻ ${reset}</text>`
        return s
      },
    })
  }
  if (u.usd !== null) {
    const text = `$${u.usd.toFixed(2)}`
    const w = Math.round(textW(text, 12) + 18)
    right.push({
      w,
      draw: x =>
        `<rect class="ub-k" x="${x}" y="${(H - 18) / 2}" width="${w}" height="18" rx="9"/>` +
        `<text class="ub-t" x="${x + w / 2}" y="${cy + 4.5}" text-anchor="middle" font-size="12" font-weight="600">${text}</text>`,
    })
  }

  const GAP = 22
  const rightW = right.reduce((s, r) => s + r.w, 0) + GAP * right.length

  // Context: label, dithered bar, a pill riding the fill head, the percent.
  const label = 'Context'
  const p = u.contextPercent ?? 0
  const color = hue(p, CLAY)
  const percentText = u.contextPercent === null ? '—' : pct(p)
  const BAR_X = Math.round(16 + textW(label, 13) + 12)
  const BAR_W = Math.round(Math.max(80, W - BAR_X - rightW - 12 - textW('100%', 12.5)))
  const fillW = Math.round(BAR_W * (p / 100))
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  const dots: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density)
        dots.push(`<rect class="ub-t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  const pillText = `${u.contextTokens === null ? '—' : kTokens(u.contextTokens)} / ${kTokens(u.contextWindow)}`
  const pillW = Math.round(18 + pillText.length * 6.2)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))

  parts.push(`<circle cx="5" cy="${cy}" r="4" fill="${color}"/>`)
  parts.push(`<text class="ub-t" x="16" y="${cy + 4.5}" font-size="13" font-weight="500">${label}</text>`)
  parts.push(`<g transform="translate(${BAR_X},${(H - BAR_H) / 2})">
<rect class="ub-k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#ub-clip)"><g fill="${color}">${dots.join('')}</g></g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#fff">${pillText}</text>
</g>`)
  parts.push(`<text class="ub-m" x="${BAR_X + BAR_W + 8}" y="${cy + 4.5}" font-size="12.5">${percentText}</text>`)

  let x = W - rightW + GAP
  for (const r of right) {
    parts.push(`<line class="ub-sep" x1="${x - GAP / 2}" y1="6" x2="${x - GAP / 2}" y2="${H - 6}"/>`)
    parts.push(r.draw(x))
    x += r.w + GAP
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
<style>
.ub-t{fill:#1f1f1f}.ub-m{fill:#8a8a8a}.ub-k{fill:#e4e4e2}.ub-ring{stroke:#e4e4e2}.ub-sep{stroke:#d8d8d4;stroke-width:1}
@media (prefers-color-scheme: dark){.ub-t{fill:#ececec}.ub-m{fill:#9a9a9a}.ub-k{fill:#3a3a3a}.ub-ring{stroke:#3d3d3d}.ub-sep{stroke:#4a4a4a}}
.ub-t0,.ub-t1,.ub-t2,.ub-t3{animation:ub-tw 2.6s ease-in-out infinite}
.ub-t1{animation-duration:3.1s;animation-delay:-.7s}.ub-t2{animation-duration:2.2s;animation-delay:-1.3s}.ub-t3{animation-duration:3.6s;animation-delay:-.4s}
@keyframes ub-tw{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion: reduce){.ub-t0,.ub-t1,.ub-t2,.ub-t3{animation:none}}
</style>
<defs><clipPath id="ub-clip"><rect width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
${parts.join('\n')}
</svg>`
}

export const register: Register = (on, options) => {
  const ttl = TTL_MS[String(options.cacheTtl)] ?? TTL_MS['1h']!

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const u = await $.session.usage()
    await update($, usage, () => toUsage(u))
    // Redraw the countdown twice a minute while the cache is warm or just went cold.
    $.clock.every(30_000, async () => {
      const c = await read($, cache)
      if (c && (await $.clock.now()) - c.at < ttl + 60_000) await update($, tick, n => n + 1)
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.usage) {
      const hit = hitRate(e.usage)
      const at = await $.clock.now()
      await update($, cache, () => ({ at, hit }))
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u === null) return next(e)

    const ui = $.ui.resolve(e)
    await read($, tick)
    const now = await $.clock.now()
    const c = await read($, cache)

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(320, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 16))
      const alt = [
        `Context ${u.contextPercent === null ? '—' : pct(u.contextPercent)}`,
        ...(c ? [`Cache ${c.hit === null ? '—' : pct(c.hit)}, ${countdown(cacheLeft(c, ttl, now).ms)}`] : []),
        ...u.limits.map(l => `${LABELS[l.kind] ?? l.kind} ${pct(l.percentUsed)}`),
        u.usd !== null ? `$${u.usd.toFixed(2)}` : '',
      ]
        .filter(Boolean)
        .join(', ')
      return <Svg source={rowSvg(u, W, now, c, ttl)} alt={alt} width={W} height={H} />
    }

    const { Box, Text } = ui
    const cols = e.props.bodyColumns || 80
    const barW = Math.max(8, Math.min(24, cols - 60))
    const p = u.contextPercent

    return (
      <Box flexDirection="row" gap={2}>
        <Text>
          <Text color={p === null ? 'gray' : tone(p)}>● </Text>
          <Text bold>Context </Text>
          <Text color={p === null ? 'gray' : tone(p)}>
            {bar(p ?? 0, barW)}
          </Text>
          <Text bold> {p === null ? '—' : pct(p)}</Text>
          <Text dimColor>
            {' '}
            {u.contextTokens === null ? '—' : kTokens(u.contextTokens)}/{kTokens(u.contextWindow)}
          </Text>
        </Text>
        {c &&
          (() => {
            const { ms, share } = cacheLeft(c, ttl, now)
            return (
              <Text key="cache">
                <Text color={ms <= 0 ? 'gray' : share < 0.2 ? 'yellow' : 'cyan'}>◷ </Text>
                <Text dimColor>Cache </Text>
                <Text bold>{c.hit === null ? '—' : pct(c.hit)}</Text>
                <Text dimColor> {countdown(ms)}</Text>
              </Text>
            )
          })()}
        {u.limits.map(l => {
          const reset = resetIn(l.resetsAt, now)
          return (
            <Text key={l.kind}>
              <Text color={tone(l.percentUsed)}>{l.percentUsed >= 85 ? '◉' : l.percentUsed >= 50 ? '◑' : '◔'} </Text>
              <Text dimColor>{LABELS[l.kind] ?? l.kind} </Text>
              <Text bold>{pct(l.percentUsed)}</Text>
              {reset ? <Text dimColor> ↻{reset}</Text> : null}
            </Text>
          )
        })}
        {u.usd !== null && <Text color="green">${u.usd.toFixed(2)}</Text>}
      </Box>
    )
  })
}
