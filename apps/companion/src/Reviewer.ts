import { type AgentAccount, AgentOpinion, AgentQuick, AgentSort, Decision, impact, opinionsMode, type Phase, type PrOpinion, type PrRef, repoSettings, smallPrLines, type SortResult } from '@pr-review/domain'
import { readFileSync } from 'node:fs'
import { type Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Stream, SubscriptionRef } from 'effect'
import { Agent, type AgentTurns, type SessionOptions } from './Agent.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { judged, type OpinionContext, Opiner, quickDecision } from './Opiner.ts'
import { annotate, measure } from './Perf.ts'
import { completeItems } from './partialJson.ts'
import { type SortError, Sorter } from './Sorter.ts'
import { Store } from './Store.ts'
import { type TicketSummary, Tickets } from './Tickets.ts'
import { buildTrusted } from './trusted.ts'

const quickInstructions = readFileSync(new URL('../prompts/quick.md', import.meta.url), 'utf8')

export type Review = { sort: SortResult; opinion: PrOpinion | null; opinionError?: string }

type Worker = Phase['workers'][number]
type Phases = SubscriptionRef.SubscriptionRef<ReadonlyArray<Phase>>

/** Phase updates that only set values, so a session `use` that reruns on another account repeats them harmlessly. */
const tracker = (phases: Phases) => {
  const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
  const update = (id: Phase['id'], f: (p: Phase) => Phase) => SubscriptionRef.update(phases, (ps) => ps.map((p) => (p.id === id ? f(p) : p)))
  return {
    begin: (id: Phase['id'], label: string) =>
      Effect.flatMap(now, (startedAt) =>
        SubscriptionRef.update(phases, (ps) =>
          ps.some((p) => p.id === id) ? ps.map((p) => (p.id === id ? { ...p, label, state: 'running' as const } : p)) : [...ps, { id, label, state: 'running' as const, startedAt, workers: [] }],
        ),
      ),
    end: (id: Phase['id'], state: 'done' | 'failed') => Effect.flatMap(now, (endedAt) => update(id, (p) => ({ ...p, state, endedAt }))),
    failRunning: Effect.flatMap(now, (endedAt) => SubscriptionRef.update(phases, (ps) => ps.map((p) => (p.state === 'running' ? { ...p, state: 'failed' as const, endedAt } : p)))),
    worker: (id: Phase['id'], i: number, f: (w: Worker) => Worker) =>
      update(id, (p) => {
        const workers = [...p.workers]
        workers[i] = f(workers[i] ?? { account: '', recent: [] })
        return { ...p, workers }
      }),
  }
}
type Tracker = ReturnType<typeof tracker>

/** Where a session's steps go. */
type Slot = { phase: Phase['id']; worker: number }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const decodeDecision = Schema.decodeUnknownOption(Decision)

export class Reviewer extends Context.Service<
  Reviewer,
  {
    /** Starts preparing the review of this head, or joins the run already going. Runs in the companion's scope. */
    prepare(ref: PrRef, headSha: string): Effect.Effect<void>
    /** The running preparation's phases: the current ones, then each change. Never ends; empty when nothing runs. */
    progress(ref: PrRef, headSha: string): Stream.Stream<ReadonlyArray<Phase>>
    /** The prepared review, starting a preparation when none runs. A failed opinion still returns the sort. */
    result(ref: PrRef, headSha: string): Effect.Effect<Review, SortError>
  }
>()('pr-review/Reviewer') {
  static readonly layer = Layer.effect(
    Reviewer,
    Effect.gen(function* () {
      const agent = yield* Agent
      const config = yield* Config
      const git = yield* Git
      const github = yield* GitHub
      const sorter = yield* Sorter
      const opiner = yield* Opiner
      const store = yield* Store
      const tickets = yield* Tickets
      const scope = yield* Effect.scope
      const keyOf = (ref: PrRef, headSha: string) => `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}@${headSha}`
      const runs = new Map<string, { phases: Phases; done: Deferred.Deferred<Review, SortError> }>()

      /** Small PRs get one turn on the whole change instead of piles. Undefined means sort as usual. */
      const quick = Effect.fnUntraced(function* (ref: PrRef, headSha: string, t: Tracker, ticket: Fiber.Fiber<TicketSummary>) {
        const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
        const settings = yield* config.settings
        const gh = yield* github.forHost(ref.host)
        const pr = yield* gh.getPr(ref.owner, ref.repo, ref.number)
        const { headSha: head, mergeBase } = yield* git.fetchPr(repoKey, ref.number, pr.baseRef, headSha)
        const [files, checks] = yield* Effect.all([git.numstat(repoKey, mergeBase, head), gh.getChecks(ref.owner, ref.repo, head)], { concurrency: 2 })
        const { groups, rest } = buildTrusted(files, checks, settings.review.likelyTrusted, settings.review.neverTrust)
        const lines = rest.reduce((n, f) => n + f.additions + f.deletions, 0)
        yield* annotate({
          files: files.length,
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0),
          reviewLines: lines,
          quick: lines < smallPrLines(settings),
        })
        if (lines >= smallPrLines(settings)) return undefined

        const contextFiber = yield* Effect.forkChild(opiner.context(ref, headSha))
        yield* t.end('fetch', 'done')
        yield* t.begin('quick', `Reading the change: ${lines} lines in ${plural(rest.length, 'file')}`)
        if (!ticket.pollUnsafe()) yield* t.worker('quick', 0, (w) => ({ ...w, step: 'Reading the ticket' }))
        yield* Fiber.join(ticket).pipe(measure('context.wait', { on: 'ticket' }))
        const c = yield* Fiber.join(contextFiber).pipe(
          measure('context.wait', { on: 'context' }),
          Effect.onError(() => t.end('quick', 'failed')),
        )
        const changes = quickDecision({ skim: [{ area: 'Changes', summary: '', files: rest.map((f) => f.path) }] })
        const prompt = `${yield* c.prompt([changes])}\n\n${quickInstructions}`
        const options: SessionOptions = {
          cwd: c.cwd,
          related: c.related,
          log: { kind: 'sort', owner: ref.owner, repo: ref.repo, number: ref.number, headSha },
          onStep: (s) => Effect.suspend(() => t.worker('quick', 0, (w) => ({ ...w, step: s, recent: w.step ? [...w.recent, w.step].slice(-4) : w.recent }))),
        }
        const answer = yield* agent
          .session(options, (turns, account) =>
            Effect.andThen(
              t.worker('quick', 0, (w) => ({ ...w, account: account.name })),
              turns.structured(prompt, AgentQuick, 'fast', 'sort'),
            ),
          )
          .pipe(Effect.onError(() => t.end('quick', 'failed')))

        const sort: SortResult = {
          headSha: head,
          mergeBase,
          summary: answer.summary,
          decisions: [],
          skim: [{ area: 'Changes', summary: answer.summary, files: rest.map((f) => f.path) }],
          trusted: groups,
          claims: [],
          unclaimedDecisionIds: [],
          lines: { decision: 0, skim: lines, trusted: files.reduce((n, f) => n + f.additions + f.deletions, 0) - lines },
          quick: true,
        }
        yield* sorter.remember(ref, headSha, sort)
        const made = yield* Effect.result(c.finish({ decisions: [{ decisionId: 'changes', authorCase: answer.authorCase, checked: answer.checked, findings: answer.findings }] }, [changes]))
        let opinion: PrOpinion | undefined
        let opinionError: string | undefined
        if (made._tag === 'Failure') opinionError = made.failure.message
        else {
          opinion = made.success
          yield* opiner.remember(ref, headSha, opinion)
          yield* Effect.orDie(store.lastOpinion.set(`${repoKey}#${ref.number}`, { headSha, mergeBase, opinion }))
        }
        yield* t.end('quick', 'done')
        return { sort, opinion: opinion ?? null, ...(opinionError ? { opinionError } : {}) } satisfies Review
      })

      const work = Effect.fnUntraced(function* (ref: PrRef, headSha: string, t: Tracker) {
        const automatic = opinionsMode(yield* config.settings) === 'automatic'
        const [cachedSort, cachedOpinion] = yield* Effect.all([sorter.cached(ref, headSha), opiner.cached(ref, headSha)])
        yield* annotate({ automatic, sortCached: cachedSort !== undefined, opinionCached: cachedOpinion !== undefined })
        if (cachedSort && (cachedOpinion || !automatic)) return { sort: cachedSort, opinion: cachedOpinion ?? null } satisfies Review
        if (cachedSort) return yield* prepared(ref, headSha, t, cachedSort, cachedOpinion)
        // A sort started elsewhere (the stack page, say) is joined, so one head never has two sorts with different decision ids.
        const claim = yield* sorter.claim(ref, headSha)
        yield* annotate({ sortJoined: 'running' in claim })
        if ('running' in claim) return yield* prepared(ref, headSha, t, undefined, cachedOpinion, claim.running)
        return yield* prepared(ref, headSha, t, undefined, cachedOpinion).pipe(Effect.onExit((exit) => claim.done(Exit.map(exit, (r) => r.sort))))
      })

      const prepared = Effect.fnUntraced(function* (
        ref: PrRef,
        headSha: string,
        t: Tracker,
        sortedEarlier: SortResult | undefined,
        cachedOpinion: PrOpinion | undefined,
        running?: Effect.Effect<SortResult, SortError>,
      ) {
        const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
        const settings = yield* config.settings
        const automatic = opinionsMode(settings) === 'automatic'
        yield* t.begin('fetch', `Fetching #${ref.number}`)
        const gh = yield* github.forHost(ref.host)
        const pr = yield* gh.getPr(ref.owner, ref.repo, ref.number)
        yield* t.begin('fetch', `Fetching #${ref.number}: ${pr.title}`)
        // Started now so the turn that needs it waits least; `opiner.context` joins the same lookup.
        const ticket = yield* Effect.forkChild(tickets.summary(ref, pr))
        let cachedSort = sortedEarlier
        if (running) {
          yield* t.end('fetch', 'done')
          yield* t.begin('sort', `Sorting #${ref.number}: joining the sort already running`)
          cachedSort = yield* running.pipe(measure('sort.join'))
          yield* t.end('sort', 'done')
          if (cachedOpinion || !automatic) {
            yield* Fiber.interrupt(ticket)
            return { sort: cachedSort, opinion: cachedOpinion ?? null } satisfies Review
          }
        } else if (!cachedSort) {
          const q = yield* quick(ref, headSha, t, ticket)
          if (q) return q
        }
        const wantOpinion = automatic && !cachedOpinion
        if (!wantOpinion) yield* Fiber.interrupt(ticket)
        // Fetched while the sort runs.
        const contextFiber = wantOpinion ? yield* Effect.forkChild(opiner.context(ref, headSha)) : undefined
        const sortPrompt = cachedSort ? undefined : yield* sorter.prepare(ref, headSha)
        yield* t.end('fetch', 'done')
        if (sortedEarlier) {
          yield* t.begin('sort', 'Sorted earlier')
          yield* t.end('sort', 'done')
        }

        // Kept outside the sessions, so a rerun on another account skips what already finished.
        let sort = cachedSort
        let context: OpinionContext | undefined
        let opinionError: string | undefined
        const answered = new Map<string, AgentOpinion['decisions'][number]>()
        // Each decision once: taken from the sort as it writes them, then the rest of the finished sort.
        const queue = yield* Queue.unbounded<Decision, Cause.Done>()
        const queued: Decision[] = []
        const found = yield* Deferred.make<void>()
        let streamed = 0
        // Opinion workers are numbered as they join, so sessions that start during the sort come first.
        let workers = 0

        const enqueue = (ds: ReadonlyArray<Decision>) =>
          Effect.gen(function* () {
            const fresh = ds.filter((d) => !queued.some((q) => q.id === d.id))
            if (!fresh.length) return
            queued.push(...fresh)
            yield* Queue.offerAll(queue, fresh)
            yield* t.begin('opinion', `Judging ${plural(queued.length, 'decision')}`)
            yield* Deferred.succeed(found, undefined)
          })
        const known = new Set(sortPrompt?.files.map((f) => f.path))
        let sortText = ''
        /** Decisions the sort has finished writing, kept as `normalize` keeps them. */
        const fromSort = (delta: string) =>
          Effect.suspend(() => {
            sortText += delta
            const ds = completeItems(sortText, 'decisions').flatMap((x) => {
              const d = Option.getOrUndefined(decodeDecision(x))
              const files = d?.files.filter((f) => known.has(f.path)) ?? []
              return d && files.length ? [{ ...d, files }] : []
            })
            return enqueue(ds)
          })

        const step = (w: Worker, s: string): Worker => ({ ...w, step: s, recent: w.step ? [...w.recent, w.step].slice(-4) : w.recent })
        const options = (slot: Slot): SessionOptions => ({
          cwd: git.dir(repoKey),
          ...(wantOpinion ? { related: repoSettings(settings, repoKey).related.map((r) => r.repo) } : {}),
          log: { kind: 'sort', owner: ref.owner, repo: ref.repo, number: ref.number, headSha },
          onStep: (s) => Effect.suspend(() => t.worker(slot.phase, slot.worker, (w) => step(w, s))),
        })
        const named = (slot: Slot, a: AgentAccount) => t.worker(slot.phase, slot.worker, (w) => ({ ...w, account: a.name }))

        /**
         * Judges decisions from the queue one turn each until it is drained. The first turn in a session gets the whole
         * context, later ones only their decision and diff; `continued` means the sort ran in this session.
         */
        const judge = (turns: AgentTurns, slot: Slot, continued: boolean) =>
          Effect.gen(function* () {
            yield* turns.ready
            if (!contextFiber!.pollUnsafe())
              yield* t.worker('opinion', slot.worker, (w) => step(w, ticket.pollUnsafe() ? 'Reading the stack and review guidance' : 'Reading the ticket'))
            const got = yield* Effect.result(Fiber.join(contextFiber!).pipe(measure('context.wait', { on: 'context' })))
            if (got._tag === 'Failure') return void (opinionError = got.failure.message)
            const c = (context = got.success)
            let first = true
            for (;;) {
              const d = yield* Queue.take(queue).pipe(Effect.orElseSucceed(() => undefined))
              if (!d) return
              // The finished sort may have dropped a decision it was writing.
              if (sort && !judged(sort).some((x) => x.id === d.id)) continue
              yield* t.worker('opinion', slot.worker, (w) => ({ ...w, current: `Judging ${queued.indexOf(d) + 1} of ${queued.length}: ${d.title}` }))
              const prompt = yield* c.prompt([d], { continued, brief: !first })
              const model = sort?.quick || impact(d) === 'high' ? 'main' : 'fast'
              const answer = yield* turns.structured(prompt, AgentOpinion, model, 'opinion')
              for (const a of answer.decisions) answered.set(a.decisionId, a)
              first = false
            }
          })

        // Never waits for a slot; the sort's session and the others drain the queue without it.
        const side = Effect.suspend(() => {
          const slot: Slot = { phase: 'opinion', worker: 0 }
          return agent.session({ ...options(slot), noWait: true }, (turns, account) =>
            Effect.andThen(
              Effect.suspend(() => ((slot.worker = workers++), named(slot, account))),
              judge(turns, slot, false),
            ),
          )
        })
        /** Once there is something to judge and the context is ready, a session on every free slot. */
        const sides = Effect.gen(function* () {
          yield* Deferred.await(found)
          if (!contextFiber || !queued.length) return
          yield* Fiber.await(contextFiber)
          const free = yield* agent.freeSlots()
          yield* annotate({ freeSlots: free })
          yield* Effect.forEach(Array.from({ length: free }), () => Effect.ignore(side), { concurrency: 'unbounded', discard: true })
        })

        const main: Slot = { phase: 'sort', worker: 0 }
        // Begun before the session takes an account, so a wait for one shows on it.
        if (!sort) yield* t.begin('sort', `Sorting ${plural(sortPrompt!.files.length, 'file')}`)
        else if (!judged(sort).length) opinionError = 'Nothing to judge'
        else yield* t.begin('opinion', `Judging ${plural(judged(sort).length, 'decision')}`)
        const session = agent.session({ ...options(main), ...(contextFiber && !sort ? { onDelta: (d: string) => (main.phase === 'sort' ? fromSort(d) : Effect.void) } : {}) }, (turns, account) =>
          Effect.gen(function* () {
            let continued = false
            if (!sort) {
              main.phase = 'sort'
              sortText = ''
              yield* t.begin('sort', `Sorting ${plural(sortPrompt!.files.length, 'file')}`)
              yield* named(main, account)
              sort = sortPrompt!.finish(yield* turns.structured(sortPrompt!.prompt, AgentSort, 'main', 'sort'))
              yield* sorter.remember(ref, headSha, sort)
              yield* t.end('sort', 'done')
              streamed = queued.length
              continued = true
            }
            if (!contextFiber) return
            yield* enqueue(judged(sort))
            yield* Queue.end(queue)
            if (!judged(sort).length) return void (opinionError = 'Nothing to judge')
            yield* t.begin('opinion', `Judging ${plural(judged(sort).length, 'decision')}`)
            if (main.phase === 'sort') main.worker = workers++
            main.phase = 'opinion'
            yield* named(main, account)
            yield* judge(turns, main, continued)
          }),
        )
        // Nothing for a session to do: the sort is known and there is no opinion to make.
        const outcome =
          sort && (!contextFiber || opinionError)
            ? undefined
            : (yield* Effect.all([Effect.result(session).pipe(Effect.ensuring(Effect.andThen(Queue.end(queue), Deferred.succeed(found, undefined)))), sides], { concurrency: 'unbounded' }))[0]
        if (outcome?._tag === 'Failure') {
          if (!sort) return yield* outcome.failure
          opinionError ??= outcome.failure.message
        }
        if (!sort) return yield* Effect.die('the session ended without a sort')

        // A turn that failed in another session left its decision; one more try, all of them in one turn.
        const left = context && !opinionError ? judged(sort).filter((d) => !answered.has(d.id)) : []
        if (left.length) {
          const retried = yield* Effect.result(
            agent.session(options(main), (turns) =>
              Effect.flatMap(context!.prompt(left), (prompt) => turns.structured(prompt, AgentOpinion, 'main', 'opinion')).pipe(
                Effect.tap((answer) => Effect.sync(() => answer.decisions.forEach((a) => answered.set(a.decisionId, a)))),
              ),
            ),
          )
          if (retried._tag === 'Failure') opinionError = retried.failure.message
        }
        if (contextFiber && judged(sort).length) {
          const decisions = judged(sort)
          yield* annotate({ decisions: decisions.length, highDecisions: decisions.filter((d) => impact(d) === 'high').length, streamed, retried: left.length })
        }

        let opinion: PrOpinion | undefined
        if (context && !opinionError) {
          const decisions = judged(sort)
          const order = new Map(decisions.map((d, i) => [d.id, i]))
          const made = yield* Effect.result(context.finish({ decisions: decisions.flatMap((d) => (answered.has(d.id) ? [answered.get(d.id)!] : [])) }, decisions))
          if (made._tag === 'Failure') opinionError = made.failure.message
          else {
            opinion = made.success
            yield* opiner.remember(ref, headSha, opinion)
            yield* Effect.orDie(store.lastOpinion.set(`${repoKey}#${ref.number}`, { headSha, ...(sort.mergeBase ? { mergeBase: sort.mergeBase } : {}), opinion }))
          }
        }
        if (wantOpinion) yield* t.end('opinion', opinionError ? 'failed' : 'done')
        return { sort, opinion: opinion ?? cachedOpinion ?? null, ...(opinionError ? { opinionError } : {}) } satisfies Review
      })

      const ensure = Effect.fnUntraced(function* (ref: PrRef, headSha: string) {
        const key = keyOf(ref, headSha)
        const running = runs.get(key)
        if (running) return running
        const phases = yield* SubscriptionRef.make<ReadonlyArray<Phase>>([])
        const done = yield* Deferred.make<Review, SortError>()
        // Another caller may have started one while these were made.
        const raced = runs.get(key)
        if (raced) return raced
        const run = { phases, done }
        runs.set(key, run)
        const t = tracker(phases)
        yield* Effect.forkIn(
          work(ref, headSha, t).pipe(
            measure('operation', { kind: 'review', owner: ref.owner, repo: ref.repo, prNumber: ref.number, headSha }),
            Effect.onError(() => t.failRunning),
            Effect.onExit((exit) => Effect.andThen(Deferred.done(done, exit), Effect.sync(() => void runs.delete(key)))),
          ),
          scope,
        )
        return run
      })

      return Reviewer.of({
        prepare: (ref, headSha) => Effect.asVoid(ensure(ref, headSha)),
        progress: (ref, headSha) =>
          Stream.unwrap(
            Effect.sync(() => {
              const run = runs.get(keyOf(ref, headSha))
              return run ? SubscriptionRef.changes(run.phases) : Stream.empty
            }),
          ),
        result: (ref, headSha) => Effect.flatMap(ensure(ref, headSha), (run) => Deferred.await(run.done)),
      })
    }),
  )
}
