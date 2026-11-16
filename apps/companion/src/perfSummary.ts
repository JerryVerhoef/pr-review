import { Option, Schema } from 'effect'
import { PerformanceEvent } from './Perf.ts'

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(PerformanceEvent))

/** Events from a `performance.jsonl`, skipping lines that don't parse and those before `since` (epoch ms). */
export const parseLog = (text: string, since = 0): PerformanceEvent[] =>
  text.split('\n').flatMap((line) => Option.toArray(Option.filter(decodeLine(line), (e) => Date.parse(e.timestamp) >= since)))

/** `7d`, `24h`, `30m` before `now`, or a date; 0 (everything) when empty. */
export const parseSince = (since: string, now = Date.now()): number => {
  if (!since) return 0
  const rel = /^(\d+)([mhd])$/.exec(since)
  if (rel) return now - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'm' | 'h' | 'd']
  const at = Date.parse(since)
  if (Number.isNaN(at)) throw new Error(`--since takes 7d, 24h, 30m or a date, not ${since}`)
  return at
}

export type Stats = { n: number; total: number; avg: number; p50: number; p95: number; max: number }

/** Nearest-rank percentiles. */
export const stats = (values: ReadonlyArray<number>): Stats => {
  const xs = [...values].sort((a, b) => a - b)
  const at = (p: number) => xs[Math.max(0, Math.ceil(p * xs.length) - 1)] ?? 0
  const total = xs.reduce((a, b) => a + b, 0)
  return { n: xs.length, total, avg: xs.length ? total / xs.length : 0, p50: at(0.5), p95: at(0.95), max: xs.at(-1) ?? 0 }
}

/** Pearson's r, or undefined when either side is flat. */
export const correlation = (pairs: ReadonlyArray<readonly [number, number]>): number | undefined => {
  const n = pairs.length
  if (n < 2) return undefined
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : undefined
}

const childrenOf = (events: ReadonlyArray<PerformanceEvent>) => {
  const children = new Map<string, PerformanceEvent[]>()
  for (const e of events) if (e.parentId) children.set(e.parentId, [...(children.get(e.parentId) ?? []), e])
  return children
}

/**
 * Each event's own time: its duration less the union of its direct children's intervals, so nested phases are
 * counted once and children that ran in parallel aren't subtracted twice.
 */
export const selfTimes = (events: ReadonlyArray<PerformanceEvent>): Map<string, number> => {
  const children = childrenOf(events)
  const self = new Map<string, number>()
  for (const e of events) {
    const start = e.offsetMs
    const end = e.offsetMs + e.durationMs
    let covered = 0
    let reach = start
    for (const c of [...(children.get(e.spanId) ?? [])].sort((a, b) => a.offsetMs - b.offsetMs)) {
      const from = Math.max(c.offsetMs, reach)
      const to = Math.min(c.offsetMs + c.durationMs, end)
      if (to > from) covered += to - from
      reach = Math.max(reach, Math.min(c.offsetMs + c.durationMs, end))
    }
    self.set(e.spanId, Math.max(0, e.durationMs - covered))
  }
  return self
}

const subtree = (root: PerformanceEvent, children: Map<string, PerformanceEvent[]>) => {
  const out: PerformanceEvent[] = []
  const walk = (e: PerformanceEvent) => {
    out.push(e)
    for (const c of children.get(e.spanId) ?? []) walk(c)
  }
  walk(root)
  return out
}

const num = (e: PerformanceEvent, k: string) => {
  const v = e.metadata?.[k]
  return typeof v === 'number' ? v : undefined
}

/** Workload numbers of an operation: sizes from the largest value seen in it, agent work summed over its prompts. */
const workload = (events: ReadonlyArray<PerformanceEvent>) => {
  const max = (k: string) => events.reduce<number | undefined>((m, e) => (num(e, k) === undefined ? m : Math.max(m ?? 0, num(e, k)!)), undefined)
  const sum = (k: string) => {
    const prompts = events.filter((e) => e.phase === 'agent.prompt' && num(e, k) !== undefined)
    return prompts.length ? prompts.reduce((s, e) => s + num(e, k)!, 0) : undefined
  }
  return {
    files: max('files'),
    'lines changed': max('additions') !== undefined || max('deletions') !== undefined ? (max('additions') ?? 0) + (max('deletions') ?? 0) : undefined,
    'diff bytes': max('diffBytes'),
    'prompt bytes': sum('promptBytes'),
    'tool calls': sum('toolCalls'),
    'input tokens': sum('inputTokens'),
    'output tokens': sum('outputTokens'),
  }
}

export const ms = (v: number) => (v < 1000 ? `${Math.round(v)}ms` : v < 60_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.floor(v / 60_000)}m${Math.round((v % 60_000) / 1000)}s`)
const pct = (v: number) => `${Math.round(v * 100)}%`

const table = (head: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string | number>>) => {
  if (!rows.length) return '  (no data)'
  const cells = [head, ...rows.map((r) => r.map(String))]
  const widths = head.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)))
  return cells.map((r) => '  ' + r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')).join('\n')
}

const groupBy = <K>(xs: ReadonlyArray<PerformanceEvent>, key: (e: PerformanceEvent) => K) => {
  const out = new Map<K, PerformanceEvent[]>()
  for (const e of xs) out.set(key(e), [...(out.get(key(e)) ?? []), e])
  return out
}

const durationRow = (name: string, es: ReadonlyArray<PerformanceEvent>) => {
  const s = stats(es.map((e) => e.durationMs))
  const failed = es.filter((e) => e.status === 'error').length
  const cancelled = es.filter((e) => e.status === 'cancelled').length
  return [name, s.n, failed, cancelled, ms(s.avg), ms(s.p50), ms(s.p95), ms(s.max)]
}
const durationHead = ['', 'n', 'err', 'cancel', 'avg', 'p50', 'p95', 'max']

const byKind = (es: ReadonlyArray<PerformanceEvent>) => [...groupBy(es, (e) => e.kind)].sort(([a], [b]) => a.localeCompare(b)).map(([k, xs]) => durationRow(k, xs))

/** The report `pr-review perf` prints. */
export const summarize = (events: ReadonlyArray<PerformanceEvent>, o: { top?: number } = {}): string => {
  const top = o.top ?? 10
  if (!events.length) return 'No performance events yet. They are written to ~/.cache/pr-review/performance.jsonl while the companion runs reviews.'
  const self = selfTimes(events)
  const children = childrenOf(events)
  const phase = (p: string) => events.filter((e) => e.phase === p)
  const operations = phase('operation')
  const out: string[] = []
  const first = events.reduce((m, e) => (e.timestamp < m ? e.timestamp : m), events[0]!.timestamp)
  const last = events.reduce((m, e) => (e.timestamp > m ? e.timestamp : m), events[0]!.timestamp)
  out.push(`${events.length} events, ${operations.length} operations, ${first} to ${last}`)

  out.push('', 'Operations, end to end (a nested operation also counts toward the one it runs in)', table(durationHead, byKind(operations)))
  out.push('', 'Agent turns by kind (the runs usage.jsonl times)', table(durationHead, byKind(phase('agent.turn'))))

  const phases = [...groupBy(events, (e) => e.phase)].map(([p, es]) => {
    const own = es.map((e) => self.get(e.spanId) ?? 0)
    const s = stats(es.map((e) => e.durationMs))
    return { p, n: es.length, wall: s.total, own: own.reduce((a, b) => a + b, 0), avg: s.avg, p95: s.p95, max: s.max }
  })
  phases.sort((a, b) => b.own - a.own)
  out.push(
    '',
    'Phases, by own time (own = minus measured phases inside it, so own times add up without double counting)',
    table(
      ['phase', 'n', 'own total', 'wall total', 'avg', 'p95', 'max'],
      phases.map((r) => [r.p, r.n, ms(r.own), ms(r.wall), ms(r.avg), ms(r.p95), ms(r.max)]),
    ),
  )

  const prompts = phase('agent.prompt')
  out.push(
    '',
    'Agent prompts: tool time vs everything else (unclassified = model, the agent itself and the protocol; not told apart)',
    table(
      ['kind', 'n', 'prompt total', 'tools', 'unclassified', 'tools %', 'avg tools', 'first activity', 'first text', 'avg in tok', 'avg out tok'],
      [...groupBy(prompts, (e) => e.kind)].map(([k, es]) => {
        const total = es.reduce((s, e) => s + e.durationMs, 0)
        const tools = es.reduce((s, e) => s + (num(e, 'toolMs') ?? 0), 0)
        const avg = (key: string) => {
          const xs = es.flatMap((e) => (num(e, key) === undefined ? [] : [num(e, key)!]))
          return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined
        }
        const fmt = (v: number | undefined, f: (v: number) => string) => (v === undefined ? '-' : f(v))
        return [
          k,
          es.length,
          ms(total),
          ms(tools),
          ms(es.reduce((s, e) => s + (num(e, 'unclassifiedMs') ?? 0), 0)),
          total ? pct(tools / total) : '-',
          fmt(avg('toolCalls'), (v) => v.toFixed(1)),
          fmt(avg('firstActivityMs'), ms),
          fmt(avg('firstTextMs'), ms),
          fmt(avg('inputTokens'), (v) => String(Math.round(v))),
          fmt(avg('outputTokens'), (v) => String(Math.round(v))),
        ]
      }),
    ),
  )

  const tools = phase('agent.tool')
  const toolName = (e: PerformanceEvent) => {
    const m = e.metadata ?? {}
    return [m.tool ?? m.toolKind ?? 'unknown', m.command, m.subcommand].filter(Boolean).join(' ')
  }
  out.push(
    '',
    'Tool calls (from the agent announcing a call to its last status)',
    table(
      ['tool', 'n', 'total', 'avg', 'p95', 'max', 'failed', 'rejected'],
      [...groupBy(tools, toolName)]
        .map(([name, es]) => ({ name, es, s: stats(es.map((e) => e.durationMs)) }))
        .sort((a, b) => b.s.total - a.s.total)
        .map(({ name, es, s }) => [name, s.n, ms(s.total), ms(s.avg), ms(s.p95), ms(s.max), es.filter((e) => e.status === 'error').length, es.filter((e) => e.metadata?.permission === 'rejected').length]),
    ),
  )

  const reads = phase('cache.read').filter((e) => typeof e.metadata?.hit === 'boolean')
  out.push(
    '',
    'Cache reads',
    table(
      ['store', 'reads', 'hits', 'hit rate'],
      [...groupBy(reads, (e) => String(e.metadata?.store ?? '?'))].map(([store, es]) => {
        const hits = es.filter((e) => e.metadata?.hit === true).length
        return [store, es.length, hits, pct(hits / es.length)]
      }),
    ),
  )

  const slowest = [...operations].sort((a, b) => b.durationMs - a.durationMs).slice(0, top)
  out.push('', `Slowest operations (top ${top}), with where their time went`)
  for (const e of slowest) {
    const own = new Map<string, number>()
    for (const x of subtree(e, children)) own.set(x.phase, (own.get(x.phase) ?? 0) + (self.get(x.spanId) ?? 0))
    const parts = [...own].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, t]) => `${p === 'operation' ? 'unmeasured' : p} ${ms(t)}`)
    out.push(`  ${ms(e.durationMs).padStart(7)}  ${e.kind} #${e.prNumber ?? '?'} ${e.timestamp} ${e.status}`, `           ${parts.join(', ')}`)
  }

  const MIN = 5
  const rows: Array<Array<string | number>> = []
  for (const [kind, es] of groupBy(operations, (e) => e.kind)) {
    if (es.length < MIN) continue
    const loads = es.map((e) => ({ d: e.durationMs, w: workload(subtree(e, children)) }))
    for (const metric of Object.keys(loads[0]!.w) as Array<keyof (typeof loads)[number]['w']>) {
      const pairs = loads.flatMap((l) => (l.w[metric] === undefined ? [] : [[l.w[metric]!, l.d] as const]))
      const r = pairs.length >= MIN ? correlation(pairs) : undefined
      if (r !== undefined) rows.push([kind, metric, pairs.length, r.toFixed(2)])
    }
  }
  out.push(
    '',
    `Workload vs operation duration (Pearson r; kinds with ${MIN}+ operations; near 1 = grows with it, near 0 = unrelated)`,
    table(['kind', 'metric', 'n', 'r'], rows),
  )
  return out.join('\n')
}
