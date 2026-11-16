import { assert, describe, it } from '@effect/vitest'
import type { PerformanceEvent } from '../src/Perf.ts'
import { correlation, parseLog, parseSince, selfTimes, stats, summarize } from '../src/perfSummary.ts'

let n = 0
const ev = (o: Partial<PerformanceEvent> & Pick<PerformanceEvent, 'phase' | 'durationMs'>): PerformanceEvent => {
  const spanId = o.spanId ?? `s${++n}`
  return { timestamp: '2026-11-12T10:00:00.000Z', operationId: spanId, spanId, offsetMs: 0, kind: 'sort', status: 'success', ...o }
}

describe('perfSummary', () => {
  it('takes nearest-rank percentiles', () => {
    assert.deepStrictEqual(stats([5, 1, 4, 2, 3]), { n: 5, total: 15, avg: 3, p50: 3, p95: 5, max: 5 })
    assert.deepStrictEqual(stats([]), { n: 0, total: 0, avg: 0, p50: 0, p95: 0, max: 0 })
  })

  it('counts nested time once: a parent keeps only what its children, parallel or not, did not cover', () => {
    const op = ev({ phase: 'operation', spanId: 'op', durationMs: 100 })
    const a = ev({ phase: 'git.fetch', spanId: 'a', parentId: 'op', operationId: 'op', offsetMs: 10, durationMs: 60 })
    const b = ev({ phase: 'git.diff', spanId: 'b', parentId: 'op', operationId: 'op', offsetMs: 50, durationMs: 40 })
    const inner = ev({ phase: 'git.clone', spanId: 'c', parentId: 'a', operationId: 'op', offsetMs: 20, durationMs: 30 })
    const self = selfTimes([op, a, b, inner])
    assert.strictEqual(self.get('op'), 20)
    assert.strictEqual(self.get('a'), 30)
    assert.strictEqual(self.get('b'), 40)
    assert.strictEqual(self.get('c'), 30)
  })

  it('correlates, and gives up on flat data', () => {
    assert.closeTo(correlation([[1, 2], [2, 4], [3, 6]])!, 1, 1e-9)
    assert.isUndefined(correlation([[1, 2], [1, 3]]))
  })

  it('reads the log, skipping broken lines and older events', () => {
    const text = [JSON.stringify(ev({ phase: 'a', durationMs: 1 })), 'not json', '', JSON.stringify(ev({ phase: 'b', durationMs: 1, timestamp: '2020-01-01T00:00:00.000Z' }))].join('\n')
    assert.deepStrictEqual(parseLog(text).map((e) => e.phase), ['a', 'b'])
    assert.deepStrictEqual(parseLog(text, Date.parse('2025-01-01')).map((e) => e.phase), ['a'])
    assert.strictEqual(parseSince('2d', 10 * 86_400_000), 8 * 86_400_000)
    assert.strictEqual(parseSince(''), 0)
    assert.throws(() => parseSince('soon'))
  })

  it('reports operations, phases, prompts, tools, cache hits and the slowest runs', () => {
    const events: PerformanceEvent[] = []
    for (let i = 1; i <= 6; i++) {
      const op = `op${i}`
      events.push(
        ev({ phase: 'operation', spanId: op, kind: 'sort', prNumber: i, durationMs: 10_000 * i, metadata: { concurrentOperations: 1 } }),
        ev({ phase: 'context.prepare', spanId: `${op}c`, parentId: op, operationId: op, durationMs: 500, metadata: { files: i * 3, diffBytes: i * 1000 } }),
        ev({ phase: 'agent.turn', spanId: `${op}t`, parentId: op, operationId: op, offsetMs: 500, durationMs: 10_000 * i - 600 }),
        ev({
          phase: 'agent.prompt',
          spanId: `${op}p`,
          parentId: `${op}t`,
          operationId: op,
          offsetMs: 600,
          durationMs: 10_000 * i - 800,
          metadata: { toolCalls: i, toolMs: 1000 * i, unclassifiedMs: 9000 * i - 800, promptBytes: 5000, inputTokens: 100 * i },
        }),
        ev({ phase: 'agent.tool', spanId: `${op}x`, parentId: `${op}p`, operationId: op, offsetMs: 700, durationMs: 1000 * i, metadata: { tool: 'Bash', command: 'git', subcommand: 'show', permission: 'allowed' } }),
        ev({ phase: 'cache.read', spanId: `${op}r`, parentId: op, operationId: op, durationMs: 2, metadata: { store: 'sort', hit: i % 2 === 0 } }),
      )
    }
    events.push(ev({ phase: 'agent.tool', durationMs: 50, status: 'error', metadata: { toolKind: 'read', permission: 'rejected' } }))
    const report = summarize(events, { top: 3 })
    assert.match(report, /Operations, end to end[\s\S]*sort\s+6\s+0\s+0\s+35\.0s/)
    assert.match(report, /Bash git show\s+6\s+21\.0s/)
    assert.match(report, /read\s+1\s+50ms\s+50ms\s+50ms\s+50ms\s+1\s+1/)
    assert.match(report, /sort\s+6\s+3\s+50%/)
    assert.match(report, /1m0s\s+sort #6/)
    assert.notMatch(report, /sort #3 /)
    assert.match(report, /sort\s+files\s+6\s+1\.00/)
    assert.match(report, /sort\s+tool calls\s+6\s+1\.00/)
  })

  it('says so when there is nothing to report', () => {
    assert.match(summarize([]), /No performance events yet/)
  })
})
