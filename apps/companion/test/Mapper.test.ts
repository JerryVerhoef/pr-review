import { assert, describe, it } from '@effect/vitest'
import { type AgentArchitecture, defaultSettings, type Decision, type SortResult, type StackEntry } from '@pr-review/domain'
import { Effect, Layer, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Config } from '../src/Config.ts'
import { Mapper } from '../src/Mapper.ts'
import { Sorter } from '../src/Sorter.ts'
import { Store } from '../src/Store.ts'
import { fakeAgent, fakeGit, fakeGitHub, pr, ref } from './fakes.ts'

const entry = (number: number, baseRef: string, headRef: string, headSha = `sha${number}`): StackEntry => ({ number, title: `PR ${number}`, baseRef, headRef, headSha })
const stack = [entry(6, 'master', 'f6'), entry(7, 'f6', 'f7'), entry(8, 'f7', 'f8')]

const decision: Decision = { id: 'model', title: 'Decision model', lens: 'architecture', reason: 'data-model', theme: 't', note: 'n', existing: null, authorWhy: null, files: [] }
const sorted: SortResult = { headSha: 'sha6', summary: 'Adds the model.', decisions: [decision], skim: [], trusted: [], claims: [], unclaimedDecisionIds: [], lines: { decision: 0, skim: 0, trusted: 0 } }

/** A sort would be a paid run per PR and fails the test. */
const fakeSorter = Layer.succeed(Sorter, Sorter.of({ sort: (r) => Effect.die(`sorted #${r.number}`), cached: (r) => Effect.succeed(r.number === 6 ? sorted : undefined), steps: () => Stream.never, prepare: () => Effect.die('prepared'), since: () => Effect.undefined, claim: () => Effect.die('claimed'), remember: () => Effect.void }))

const reply: AgentArchitecture = {
  summary: 'Billing now writes usage.',
  nodes: [
    { id: 'billing', kind: 'module', name: 'Billing', status: 'changed', what: 'w', paths: ['src/billing'], prs: [7] },
    { id: 'usage', kind: 'table', name: 'usage_events', status: 'new', what: 'w', paths: ['src/usage/Usage.ts'], prs: [6] },
    { id: 'ghost', kind: 'module', name: 'Ghost', status: 'new', what: 'w', paths: ['src/ghost'], prs: [8] },
  ],
  edges: [
    { from: 'billing', to: 'usage', kind: 'write', method: null, status: 'new', prs: [7], evidence: { ref: 'head', path: 'src/billing/Bill.ts', line: 9, quote: 'usage.insert(' } },
    { from: 'usage', to: 'billing', kind: 'invoke', method: null, status: 'new', prs: [8], evidence: { ref: 'head', path: 'src/usage/Usage.ts', line: 1, quote: 'not in the file' } },
  ],
}

const setup = (o: { prs?: () => StackEntry[]; diff?: string; maxDiffKb?: number } = {}) => {
  const agent = fakeAgent(() => Effect.succeed(reply))
  const git = fakeGit({
    files: [{ path: 'src/billing/Bill.ts', additions: 3, deletions: 1 }, { path: 'pnpm-lock.yaml', additions: 900, deletions: 0 }],
    diff: o.diff ?? 'THE DIFF',
    rules: ['src/billing/Bill.ts', 'src/usage/Usage.ts'],
    show: { 'sha7:src/billing/Bill.ts': 'a\nawait usage.insert(row)\n', 'sha8:src/usage/Usage.ts': 'export class Usage {}\n', 'HEAD1:src/billing/Bill.ts': 'await usage.insert(row)\n' },
  })
  const layer = Mapper.layer.pipe(
    Layer.provide([
      agent.layer,
      git.layer,
      fakeGitHub({ listOpenPrs: () => Effect.sync(() => (o.prs ? o.prs() : stack)), getPr: (_o, _r, n) => Effect.succeed({ ...pr, number: n, title: `PR ${n}`, headSha: n === 7 && !o.prs ? 'sha7' : pr.headSha }) }),
      Config.layerTest({ cacheRoot: '/cache', settings: { ...defaultSettings, hosts: [ref.host], review: { ...defaultSettings.review, maxDiffKb: o.maxDiffKb ?? defaultSettings.review.maxDiffKb } } }),
      fakeSorter,
    ]),
    Layer.provide(Store.layerWith(KeyValueStore.layerMemory)),
  )
  return { agent, git, layer }
}

const mapOf = (stacked: boolean) =>
  Effect.gen(function* () {
    return yield* (yield* Mapper).map(ref, stacked)
  })

describe('Mapper', () => {
  it.effect('maps the stack in one agent call at default effort and never sorts', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup()
      const m = yield* mapOf(true).pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.length, 1)
      assert.strictEqual(agent.calls[0]!.log.kind, 'architecture')
      const p = agent.calls[0]!.prompt
      assert.match(p, /untrusted input/)
      const order = ['# Tools', '# Refs', '# Review guidance', '# PRs', '# Files changed', '# Diff'].map((s) => p.indexOf(s))
      assert.notInclude(order, -1)
      assert.deepStrictEqual(order, [...order].sort((a, b) => a - b))
      assert.match(p, /#6 head sha6, merge base MB1\n#7 head sha7, merge base MB1\n#8 head sha8, merge base MB1/)
      assert.match(p, /#6 PR 6 \(head sha6\)\nAdds the model\.\n- \[architecture\/data-model\] Decision model/)
      assert.match(p, /#8\n {2}src\/billing\/Bill\.ts \+3 -1/)
      assert.deepStrictEqual(m.heads, { 6: 'sha6', 7: 'sha7', 8: 'sha8' })
    }))

  it.effect("inlines each PR's own diff without lockfiles, unless it is too large", () =>
    Effect.gen(function* () {
      const { agent, git, layer } = setup()
      yield* mapOf(true).pipe(Effect.provide(layer))
      assert.match(agent.calls[0]!.prompt, /## #6\nTHE DIFF\n\n## #7\nTHE DIFF\n\n## #8\nTHE DIFF/)
      assert.deepStrictEqual(git.diffPaths, [['src/billing/Bill.ts'], ['src/billing/Bill.ts'], ['src/billing/Bill.ts']])

      const big = setup({ diff: 'x'.repeat(600), maxDiffKb: 1 })
      yield* mapOf(true).pipe(Effect.provide(big.layer))
      assert.match(big.agent.calls[0]!.prompt, /# Diff\nDiff too large/)
      assert.notInclude(big.agent.calls[0]!.prompt, 'xxx')
    }))

  it.effect('drops what it cannot check and corrects a citation’s line', () =>
    Effect.gen(function* () {
      const { layer } = setup()
      const m = yield* mapOf(true).pipe(Effect.provide(layer))
      // src/ghost is at no mapped commit; the second edge's quote is not in its file.
      assert.deepStrictEqual(m.nodes.map((n) => n.id), ['billing', 'usage'])
      assert.deepStrictEqual(m.edges.map((e) => [e.from, e.to, e.evidence.line]), [['billing', 'usage', 2]])
      assert.deepStrictEqual(m.dropped, { nodes: 1, edges: 1 })
      assert.strictEqual(m.summary, 'Billing now writes usage.')
    }))

  it.effect('maps one PR alone, also when it is in a stack', () =>
    Effect.gen(function* () {
      const { agent, layer } = setup()
      const m = yield* mapOf(false).pipe(Effect.provide(layer))
      assert.deepStrictEqual(m.heads, { 7: 'sha7' })
      assert.notMatch(agent.calls[0]!.prompt, /#6 head/)
      // The node the agent gave to #6 is this PR's, as it is the only one.
      assert.deepStrictEqual(m.nodes.map((n) => n.prs), [[7], [7]])
    }))

  it.effect('cached per set of heads, and a PR outside any stack is a stack of one', () =>
    Effect.gen(function* () {
      let top = 'sha8'
      const { agent, layer } = setup({ prs: () => [...stack.slice(0, 2), entry(8, 'f7', 'f8', top)] })
      yield* Effect.gen(function* () {
        const m = yield* Mapper
        assert.isUndefined(yield* m.cached(ref, true))
        const first = yield* m.map(ref, true)
        assert.deepStrictEqual(yield* m.map(ref, true), first)
        assert.deepStrictEqual(yield* m.cached(ref, true), first)
        top = 'sha8-new'
        assert.isUndefined(yield* m.cached(ref, true))
        assert.strictEqual((yield* m.map(ref, true)).heads[8], 'sha8-new')
        // #99 is not open: no stack, so the PR itself.
        assert.deepStrictEqual((yield* m.map({ ...ref, number: 99 }, true)).heads, { 99: 'HEAD1' })
      }).pipe(Effect.provide(layer))
      assert.strictEqual(agent.calls.length, 3)
    }))
})
