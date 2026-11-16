import { Cause, Context, Duration, Effect, Exit, Layer, Option, Predicate, Schema, Stream, Tracer } from 'effect'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Config } from './Config.ts'

/**
 * Performance events: Effect spans marked with a `perf.phase` attribute, written as JSON Lines to
 * `performance.jsonl`. Everything else the tracer sees (Effect.fn spans, RPC spans) is never written.
 * Only primitive metadata that passes `safe` is written: no prompts, diffs, paths, URLs, commands or error messages.
 */

export const Status = Schema.Literals(['success', 'error', 'cancelled'])
export type Status = typeof Status.Type
export type Meta = Record<string, string | number | boolean | undefined>

export const PerformanceEvent = Schema.Struct({
  timestamp: Schema.String,
  /** The outermost measured span this one runs under (its own id when it is the outermost). */
  operationId: Schema.String,
  spanId: Schema.String,
  /** The nearest measured span this one runs under. */
  parentId: Schema.optionalKey(Schema.String),
  /** Start, in ms after the operation's start, so nested and concurrent phases can be laid out. */
  offsetMs: Schema.Number,
  kind: Schema.String,
  phase: Schema.String,
  owner: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  prNumber: Schema.optionalKey(Schema.Number),
  headSha: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  durationMs: Schema.Number,
  status: Status,
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
})
export type PerformanceEvent = typeof PerformanceEvent.Type

const P = 'perf.'
const PHASE = `${P}phase`
/** Inherited from the nearest measured ancestor that has them. */
const CONTEXT = ['kind', 'owner', 'repo', 'prNumber', 'headSha', 'agent', 'model'] as const

/** Strings that can't be a prompt, path, URL, command line or message: one short token, no whitespace or slashes. */
const SAFE = /^[\w.@:+#=,[\]-]{1,80}$/
export const safe = (v: unknown): v is string | number | boolean =>
  typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && SAFE.test(v))

const attributes = (meta: Meta) => {
  const out: Record<string, unknown> = {}
  for (const k in meta) if (meta[k] !== undefined) out[P + k] = meta[k]
  return out
}

const isPerf = (s: Tracer.AnySpan): s is Tracer.Span => s._tag === 'Span' && s.attributes.has(PHASE)

const measuredAncestors = (span: Tracer.Span) => {
  const out: Tracer.Span[] = []
  for (let p = Option.getOrUndefined(span.parent); p; p = p._tag === 'Span' ? Option.getOrUndefined(p.parent) : undefined) if (isPerf(p)) out.push(p)
  return out
}

/** Times `effect` as `phase`. `meta`, and what `after` takes from the result, go on its event. */
export const measure =
  <B = unknown>(phase: string, meta: Meta = {}, after?: (a: B) => Meta) =>
  <A extends B, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withSpan(after ? Effect.tap(effect, (a) => annotate(after(a))) : effect, `perf ${phase}`, { attributes: attributes({ ...meta, phase }) })

/** As `measure`, over a stream's whole run. */
export const measureStream =
  (phase: string, meta: Meta = {}) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    Stream.withSpan(stream, `perf ${phase}`, { attributes: attributes({ ...meta, phase }) })

/** Adds metadata to the nearest measured span. A no-op outside one. */
export const annotate = (meta: Meta): Effect.Effect<void> =>
  Effect.option(Effect.currentSpan).pipe(
    Effect.map((span) => {
      if (Option.isNone(span)) return
      const target = isPerf(span.value) ? span.value : measuredAncestors(span.value)[0]
      if (!target) return
      for (const [k, v] of Object.entries(attributes(meta))) target.attribute(k, v)
    }),
  )

/** Starts a measured span by hand at `startTime` (Clock nanos), for work that isn't an Effect (an agent's tool call). End it with `end`. */
export const startSpan = (tracer: Tracer.Tracer, parent: Tracer.AnySpan, startTime: bigint, phase: string, meta: Meta = {}): Tracer.Span => {
  const span = tracer.span({ name: `perf ${phase}`, parent: Option.some(parent), annotations: Context.empty(), links: [], startTime, kind: 'internal', root: false, sampled: true })
  for (const [k, v] of Object.entries(attributes({ ...meta, phase }))) span.attribute(k, v)
  return span
}

const statusOf = (exit: Exit.Exit<unknown, unknown>): { status: Status; errorTag?: string } => {
  if (Exit.isSuccess(exit)) return { status: 'success' }
  if (Cause.hasInterruptsOnly(exit.cause)) return { status: 'cancelled' }
  const e = Cause.squash(exit.cause)
  const tag = Predicate.hasProperty(e, '_tag') ? e._tag : e instanceof Error ? e.name : undefined
  return { status: 'error', ...(typeof tag === 'string' && safe(tag) ? { errorTag: tag } : {}) }
}

export const round = (ms: number) => Math.round(ms * 10) / 10
/** Clock nanos between two instants, in ms to one decimal. */
export const elapsedMs = (from: bigint, to: bigint) => round(Duration.toMillis(Duration.nanos(to - from)))

/**
 * A tracer that hands each finished measured span to `write` as a PerformanceEvent. Times are the span's own start
 * and end, from Effect's Clock. Nothing it does can fail the traced effect.
 */
export const makeTracer = (write: (e: PerformanceEvent) => void): Tracer.Tracer => {
  let operations = 0

  type Options = Parameters<Tracer.Tracer['span']>[0]

  class PerfSpan implements Tracer.Span {
    readonly _tag = 'Span'
    readonly name: string
    readonly parent: Option.Option<Tracer.AnySpan>
    readonly annotations: Context.Context<never>
    readonly kind: Tracer.SpanKind
    readonly sampled: boolean
    readonly attributes = new Map<string, unknown>()
    readonly links: Tracer.SpanLink[]
    status: Tracer.SpanStatus
    private id: string | undefined
    private trace: string | undefined
    constructor(o: Options) {
      this.name = o.name
      this.parent = o.parent
      this.annotations = o.annotations
      this.kind = o.kind
      this.sampled = o.sampled
      this.links = [...o.links]
      this.status = { _tag: 'Started', startTime: o.startTime }
    }
    get spanId() {
      return (this.id ??= randomBytes(8).toString('hex'))
    }
    get traceId() {
      return (this.trace ??= Option.getOrUndefined(this.parent)?.traceId ?? randomBytes(16).toString('hex'))
    }
    attribute(key: string, value: unknown) {
      if (this.status._tag === 'Ended') return
      if (key === PHASE && value === 'operation' && !this.attributes.has(PHASE)) this.attributes.set(`${P}concurrentOperations`, ++operations)
      this.attributes.set(key, value)
    }
    event() {}
    addLinks() {}
    end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
      if (this.status._tag === 'Ended') return
      this.status = { _tag: 'Ended', startTime: this.status.startTime, endTime, exit }
      if (!this.attributes.has(PHASE)) return
      if (this.attributes.get(PHASE) === 'operation') operations--
      try {
        write(this.toEvent(endTime, exit))
      } catch {
        // A broken log never touches the review.
      }
    }
    private toEvent(endTime: bigint, exit: Exit.Exit<unknown, unknown>): PerformanceEvent {
      const start = this.status.startTime
      const ancestors = measuredAncestors(this)
      const root = ancestors.at(-1) ?? this
      const context: Record<string, unknown> = {}
      for (const key of CONTEXT)
        for (const s of [this, ...ancestors]) {
          const v = s.attributes.get(P + key)
          if (safe(v)) {
            context[key] = v
            break
          }
        }
      const metadata: Record<string, string | number | boolean> = {}
      for (const [k, v] of this.attributes)
        if (k.startsWith(P) && k !== PHASE && !(CONTEXT as ReadonlyArray<string>).includes(k.slice(P.length)) && safe(v)) metadata[k.slice(P.length)] = v
      const { status, errorTag } = statusOf(exit)
      if (errorTag) metadata.errorTag = errorTag
      const parent = ancestors[0]
      return {
        timestamp: new Date(Number(start / 1_000_000n)).toISOString(),
        operationId: root.spanId,
        spanId: this.spanId,
        ...(parent ? { parentId: parent.spanId } : {}),
        offsetMs: elapsedMs(root.status.startTime, start),
        kind: typeof context.kind === 'string' ? context.kind : 'other',
        phase: String(this.attributes.get(PHASE)),
        ...(typeof context.owner === 'string' ? { owner: context.owner } : {}),
        ...(typeof context.repo === 'string' ? { repo: context.repo } : {}),
        ...(typeof context.prNumber === 'number' ? { prNumber: context.prNumber } : {}),
        ...(typeof context.headSha === 'string' ? { headSha: context.headSha } : {}),
        ...(typeof context.agent === 'string' ? { agent: context.agent } : {}),
        ...(typeof context.model === 'string' ? { model: context.model } : {}),
        durationMs: elapsedMs(start, endTime),
        status,
        ...(Object.keys(metadata).length ? { metadata } : {}),
      }
    }
  }

  return Tracer.make({
    span: (o) => new PerfSpan(o),
  })
}

/**
 * Appends events to `path` off the hot path: lines are batched and written after the current tick. At most
 * `maxPending` lines wait (more are dropped), and a file past `maxBytes` is moved to `<path>.1` first. Write
 * errors drop the batch.
 */
export const fileSink = (path: string, o: { maxBytes?: number; maxPending?: number } = {}) => {
  const maxBytes = o.maxBytes ?? 20_000_000
  const maxPending = o.maxPending ?? 2_000
  let pending: string[] = []
  let flushing: Promise<void> | undefined
  let dirMade = false
  const flush = async () => {
    while (pending.length) {
      const batch = pending.join('')
      pending = []
      try {
        if (!dirMade) await mkdir(dirname(path), { recursive: true })
        dirMade = true
        if ((await stat(path).then((s) => s.size, () => 0)) > maxBytes) await rename(path, `${path}.1`)
        await appendFile(path, batch)
      } catch {
        // Dropped: the log is best effort.
      }
    }
  }
  return {
    write: (e: PerformanceEvent) => {
      if (pending.length >= maxPending) return
      pending.push(JSON.stringify(e) + '\n')
      flushing ??= new Promise<void>((resolve) => setImmediate(resolve)).then(flush).finally(() => (flushing = undefined))
    },
    /** Resolves when everything written so far is on disk (or dropped). */
    drain: async () => {
      while (flushing) await flushing
    },
  }
}

export const performanceFile = (cacheRoot: string) => join(cacheRoot, 'performance.jsonl')

/** The tracer writing to `performance.jsonl` in the cache root. */
export const PerfLive = Layer.unwrap(
  Effect.gen(function* () {
    const { cacheRoot } = yield* Config
    return Layer.succeed(Tracer.Tracer, makeTracer(fileSink(performanceFile(cacheRoot)).write))
  }),
)
