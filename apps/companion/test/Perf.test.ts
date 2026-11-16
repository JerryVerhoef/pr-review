import { assert, describe, it } from '@effect/vitest'
import { AgentError } from '@pr-review/domain'
import { Deferred, Effect, Fiber } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { annotate, fileSink, makeTracer, measure, type PerformanceEvent } from '../src/Perf.ts'
import { tmp } from './helpers.ts'
import { TestClock } from 'effect/testing'

/** A tracer collecting events; under `it.effect` the clock only moves when `tick` says. */
const collector = () => {
  const events: PerformanceEvent[] = []
  const tracer = makeTracer((e) => void events.push(e))
  const tick = (ms: number) => TestClock.adjust(`${ms} millis`)
  const traced = <A, E>(effect: Effect.Effect<A, E>) => Effect.withTracer(effect, tracer)
  const by = (phase: string) => events.filter((e) => e.phase === phase)
  return { events, tick, traced, by }
}

const op = { kind: 'sort', owner: 'o', repo: 'r', prNumber: 7, headSha: 'abc' }

describe('Perf tracer', () => {
  it.effect('measures durations on the Clock', () =>
    Effect.gen(function* () {
      const c = collector()
      yield* c.traced(c.tick(250).pipe(measure('git.fetch')))
      assert.strictEqual(c.events.length, 1)
      assert.strictEqual(c.events[0]!.durationMs, 250)
      assert.strictEqual(c.events[0]!.status, 'success')
    }))

  it.live('measures real time with the default clock', () =>
    Effect.gen(function* () {
      const events: PerformanceEvent[] = []
      yield* Effect.sleep('30 millis').pipe(measure('git.fetch'), Effect.withTracer(makeTracer((e) => void events.push(e))))
      assert.isAtLeast(events[0]!.durationMs, 25)
      assert.isBelow(events[0]!.durationMs, 1000)
    }))

  it.effect('nests phases under their operation, and inherits its context', () =>
    Effect.gen(function* () {
      const c = collector()
      yield* c.traced(
        Effect.gen(function* () {
          yield* c.tick(10)
          yield* Effect.all([c.tick(20).pipe(measure('git.diff')), c.tick(5).pipe(measure('agent.tool'), measure('agent.prompt'))], { concurrency: 2 })
        }).pipe(measure('operation', op)),
      )
      const [operation] = c.by('operation')
      const [diff] = c.by('git.diff')
      const [prompt] = c.by('agent.prompt')
      const [tool] = c.by('agent.tool')
      assert.isUndefined(operation!.parentId)
      assert.strictEqual(operation!.operationId, operation!.spanId)
      assert.strictEqual(diff!.parentId, operation!.spanId)
      assert.strictEqual(tool!.parentId, prompt!.spanId)
      for (const e of [diff, prompt, tool]) {
        assert.strictEqual(e!.operationId, operation!.spanId)
        assert.strictEqual(e!.kind, 'sort')
        assert.strictEqual(e!.prNumber, 7)
        assert.strictEqual(e!.headSha, 'abc')
      }
      assert.strictEqual(diff!.offsetMs, 10)
      assert.strictEqual(new Set(c.events.map((e) => e.spanId)).size, 4)
    }))

  it.effect('keeps concurrent operations apart, and counts them', () =>
    Effect.gen(function* () {
      const c = collector()
      const gate = yield* Deferred.make<void>()
      const one = (n: number) => Deferred.await(gate).pipe(measure('git.fetch'), measure('operation', { ...op, prNumber: n }))
      yield* c.traced(
        Effect.gen(function* () {
          const fibers = yield* Effect.all([Effect.forkChild(one(1)), Effect.forkChild(one(2))])
          yield* Effect.yieldNow
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.joinAll(fibers)
        }),
      )
      const ops = c.by('operation')
      assert.strictEqual(ops.length, 2)
      assert.notStrictEqual(ops[0]!.operationId, ops[1]!.operationId)
      for (const f of c.by('git.fetch')) assert.strictEqual(f.operationId, ops.find((o) => o.prNumber === f.prNumber)!.spanId)
      assert.deepStrictEqual(ops.map((o) => o.metadata?.concurrentOperations).sort(), [1, 2])
    }))

  it.effect('records success, error and cancelled, with the error tag but never its message', () =>
    Effect.gen(function* () {
      const c = collector()
      yield* c.traced(Effect.void.pipe(measure('a')))
      yield* c.traced(Effect.fail(new AgentError({ message: 'secret in /home/me/.ssh' })).pipe(measure('b'), Effect.ignore))
      const fiber = yield* Effect.forkChild(c.traced(Effect.never.pipe(measure('c'))))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(
        c.events.map((e) => [e.phase, e.status, e.metadata?.errorTag]),
        [
          ['a', 'success', undefined],
          ['b', 'error', 'AgentError'],
          ['c', 'cancelled', undefined],
        ],
      )
      assert.notInclude(JSON.stringify(c.events), 'secret')
    }))

  it.effect('leaves out optional fields it has no value for', () =>
    Effect.gen(function* () {
      const c = collector()
      yield* c.traced(Effect.void.pipe(measure('git.show', { bytes: undefined })))
      const e = c.events[0]!
      assert.strictEqual(e.kind, 'other')
      for (const key of ['parentId', 'owner', 'repo', 'prNumber', 'headSha', 'agent', 'model', 'metadata']) assert.notProperty(e, key)
    }))

  it.effect('writes only short tokens, never prompts, paths, URLs or commands', () =>
    Effect.gen(function* () {
      const c = collector()
      yield* c.traced(
        annotate({ prompt: 'Sort this PR please', file: '/home/me/repo/a.ts', rel: 'src/a.ts', url: 'https://x@github.com/o/r.git', multi: 'a\nb', long: 'x'.repeat(200) }).pipe(
          measure('agent.prompt', { promptBytes: 123, tool: 'Read', hit: true, model: 'claude-opus-4-5[1m]' }),
        ),
      )
      const e = c.events[0]!
      assert.deepStrictEqual(e.metadata, { promptBytes: 123, tool: 'Read', hit: true })
      assert.strictEqual(e.model, 'claude-opus-4-5[1m]')
      const line = JSON.stringify(e)
      for (const leak of ['Sort this', '/home', 'src/a.ts', 'github.com', 'xxxx']) assert.notInclude(line, leak)
    }))

  it.effect('annotates the nearest measured span through unmeasured ones', () =>
    Effect.gen(function* () {
      const c = collector()
      yield* c.traced(annotate({ files: 3 }).pipe(Effect.withSpan('Sorter.prepare'), measure('context.prepare')))
      assert.strictEqual(c.events.length, 1)
      assert.strictEqual(c.events[0]!.metadata?.files, 3)
    }))

  it.effect('a throwing writer never fails the measured effect', () =>
    Effect.gen(function* () {
      const tracer = makeTracer(() => {
        throw new Error('disk full')
      })
      assert.strictEqual(yield* Effect.succeed(42).pipe(measure('git.fetch'), Effect.withTracer(tracer)), 42)
    }))

  it.effect('runs untraced code unchanged with the default tracer', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* Effect.succeed(1).pipe(Effect.tap(() => annotate({ a: 1 })), measure('x')), 1)
    }))
})

describe('fileSink', () => {
  const event = (n: number): PerformanceEvent => ({ timestamp: 't', operationId: 'o', spanId: `s${n}`, offsetMs: 0, kind: 'k', phase: 'p', durationMs: n, status: 'success' })

  it.live('appends one JSON line per event', () =>
    Effect.promise(async () => {
      const path = join(tmp(), 'nested', 'performance.jsonl')
      writeFileSync(join(path, '..', '..', 'keep'), '')
      const sink = fileSink(path)
      sink.write(event(1))
      sink.write(event(2))
      await sink.drain()
      sink.write(event(3))
      await sink.drain()
      const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PerformanceEvent)
      assert.deepStrictEqual(lines.map((l) => l.durationMs), [1, 2, 3])
    }))

  it.live('drops what does not fit the buffer instead of growing it', () =>
    Effect.promise(async () => {
      const path = join(tmp(), 'performance.jsonl')
      const sink = fileSink(path, { maxPending: 2 })
      for (let i = 1; i <= 5; i++) sink.write(event(i))
      await sink.drain()
      assert.strictEqual(readFileSync(path, 'utf8').trim().split('\n').length, 2)
    }))

  it.live('moves a full file aside before appending', () =>
    Effect.promise(async () => {
      const path = join(tmp(), 'performance.jsonl')
      writeFileSync(path, 'x'.repeat(100))
      const sink = fileSink(path, { maxBytes: 50 })
      sink.write(event(1))
      await sink.drain()
      assert.strictEqual(readFileSync(`${path}.1`, 'utf8'), 'x'.repeat(100))
      assert.strictEqual(JSON.parse(readFileSync(path, 'utf8')).spanId, 's1')
    }))

  it.live('a log it cannot write does not affect the measured run', () =>
    Effect.gen(function* () {
      const dir = tmp()
      writeFileSync(join(dir, 'file'), '')
      // A directory under a regular file can't be made.
      const sink = fileSink(join(dir, 'file', 'performance.jsonl'))
      const result = yield* Effect.succeed('sorted').pipe(measure('operation', op), Effect.withTracer(makeTracer(sink.write)))
      yield* Effect.promise(sink.drain)
      assert.strictEqual(result, 'sorted')
      assert.isFalse(existsSync(join(dir, 'file', 'performance.jsonl')))
    }))
})
