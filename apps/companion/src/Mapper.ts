import { AgentArchitecture, AgentError, type ArchitectureMap, type PrRef, underAny } from '@pr-review/domain'
import { Context, Effect, Layer, Stream } from 'effect'
import { readFileSync } from 'node:fs'
import { Agent } from './Agent.ts'
import { checkMap } from './architecture.ts'
import { checkEvidence } from './citations.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { GitHub } from './GitHub.ts'
import { citationReader, describePr, guidanceSection } from './opinionContext.ts'
import { annotate, measure } from './Perf.ts'
import { type SortError, Sorter } from './Sorter.ts'
import { buildStack } from './stack.ts'
import { makeSteps } from './steps.ts'
import { ArchitectureKey, cacheOptions, measuredCache, peek, storeFailuresDie } from './Store.ts'

const instructions = readFileSync(new URL('../prompts/architecture.md', import.meta.url), 'utf8')

// Numbered with the map's shape: a map stored in an older shape is left behind, not read.
const STORE = 'architecture-2'

const idOf = (k: ArchitectureKey) => `${k.host}/${k.owner}/${k.repo} architecture ${k.heads.map((h) => `${h.number}@${h.headSha}`).join(' ')}`

/** The architecture map of one PR or of its stack, only ever on demand. It reads cached sorts and never runs one. */
export class Mapper extends Context.Service<
  Mapper,
  {
    /** The map of the current heads if one is cached, without running it. */
    cached(ref: PrRef, stack: boolean): Effect.Effect<ArchitectureMap | undefined>
    /** Cached per set of heads; a PR alone is a set of one. */
    map(ref: PrRef, stack: boolean): Effect.Effect<ArchitectureMap, SortError>
    /** As `Sorter.steps`. */
    steps(ref: PrRef, stack: boolean): Stream.Stream<string>
  }
>()('pr-review/Mapper') {
  static readonly layer = Layer.effect(
    Mapper,
    Effect.gen(function* () {
      const git = yield* Git
      const github = yield* GitHub
      const agent = yield* Agent
      const config = yield* Config
      const sorter = yield* Sorter
      const steps = yield* makeSteps

      const keyFor = Effect.fnUntraced(function* (ref: PrRef, stack: boolean) {
        const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`
        yield* config.repo(repoKey)
        const gh = yield* github.forHost(ref.host)
        const base = { host: ref.host, owner: ref.owner, repo: ref.repo }
        if (stack) {
          const entries = buildStack([...(yield* gh.listOpenPrs(ref.owner, ref.repo))], ref.number, yield* git.defaultBranch(repoKey))
          if (entries.length) return new ArchitectureKey({ ...base, heads: entries.map((e) => ({ number: e.number, headSha: e.headSha })) })
        }
        // A merged or closed PR is in no stack and can still be mapped.
        const pr = yield* gh.getPr(ref.owner, ref.repo, ref.number)
        return new ArchitectureKey({ ...base, heads: [{ number: pr.number, headSha: pr.headSha }] })
      })

      const run = Effect.fn('Mapper.run')(function* (key: ArchitectureKey) {
        const { host, owner, repo, heads } = key
        const repoKey = `${host}/${owner}/${repo}`
        const report = steps.report(idOf(key))
        yield* report(heads.length > 1 ? 'Reading the stack' : 'Reading the PR')
        const first = heads[0]
        const top = heads.at(-1)
        if (!first || !top) return yield* new AgentError({ message: 'There is no PR to map' })

        const { prs, prompt } = yield* Effect.gen(function* () {
          const settings = yield* config.settings
          const gh = yield* github.forHost(host)
          const prs = yield* Effect.forEach(
            heads,
            (h) =>
              Effect.gen(function* () {
                const pr = yield* gh.getPr(owner, repo, h.number)
                const entry = { number: h.number, title: pr.title, headRef: pr.headRef, baseRef: pr.baseRef, headSha: h.headSha }
                const { mergeBase } = yield* git.fetchPr(repoKey, h.number, pr.baseRef, h.headSha)
                const [files, sort] = yield* Effect.all([git.numstat(repoKey, mergeBase, h.headSha), sorter.cached({ host, owner, repo, number: h.number }, h.headSha)], { concurrency: 2 })
                return { entry, mergeBase, files, sort }
              }),
            { concurrency: 4 },
          )
          const master = `origin/${yield* git.defaultBranch(repoKey)}`
          const { guidance: globs } = settings.review
          const guidance = globs.length ? yield* git.lsTree(repoKey, master, globs) : []
          const prompt = [
            instructions,
            `# Refs\nDefault branch: ${master}\n${prs.map((p) => `#${p.entry.number} head ${p.entry.headSha}, merge base ${p.mergeBase}`).join('\n')}`,
            guidanceSection(master, guidance),
            `# PRs (bottom first)\n${prs.map((p) => describePr(p.entry, p.sort, p.files)).join('\n\n')}`,
            `# Files changed\n${prs.map((p) => `#${p.entry.number}\n${p.files.map((f) => `  ${f.path} +${f.additions} -${f.deletions}`).join('\n')}`).join('\n')}`,
          ].join('\n\n')
          yield* annotate({
            prs: prs.length,
            files: prs.reduce((n, p) => n + p.files.length, 0),
            additions: prs.reduce((n, p) => n + p.files.reduce((m, f) => m + f.additions, 0), 0),
            deletions: prs.reduce((n, p) => n + p.files.reduce((m, f) => m + f.deletions, 0), 0),
            sortsCached: prs.filter((p) => p.sort).length,
            guidanceFiles: guidance.length,
            promptBytes: Buffer.byteLength(prompt),
          })
          return { prs, prompt }
        }).pipe(measure('context.prepare'))

        const answer = yield* agent.structured({
          prompt,
          schema: AgentArchitecture,
          cwd: git.dir(repoKey),
          repo: repoKey,
          log: { kind: 'architecture', owner, repo, number: first.number, headSha: top.headSha },
          onStep: report,
        })

        yield* report('Checking the citations')
        const checked = yield* Effect.gen(function* () {
          const byPr = new Map(prs.map((p) => [p.entry.number, p]))
          // Where a component can live: any mapped head, or below the stack for one it removes.
          const commits = [prs[0]!.mergeBase, ...prs.map((p) => p.entry.headSha)]
          const paths = [...new Set(answer.nodes.flatMap((n) => n.paths))]
          const listed = paths.length
            ? yield* Effect.forEach(commits, (sha) => git.lsTree(repoKey, sha, paths).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])), { concurrency: 4 })
            : []
          const files = [...new Set(listed.flat())]
          const read = (edgePrs: ReadonlyArray<number>) =>
            citationReader(git, github, repoKey, [], (e) => {
              const p = byPr.get(e.pr ?? edgePrs.find((n) => byPr.has(n)) ?? top.number)
              return p && (e.ref === 'head' ? p.entry.headSha : p.mergeBase)
            })
          const evidence = yield* Effect.forEach(answer.edges, (e) => checkEvidence(e.evidence, read(e.prs)), { concurrency: 8 })
          return checkMap(answer, { prs: prs.map((p) => p.entry.number), exists: (path) => files.some((f) => underAny(f, [path])), evidence })
        }).pipe(
          measure('agent.response', { step: 'finish' }, (m: { nodes: ReadonlyArray<unknown>; edges: ReadonlyArray<unknown>; dropped: { nodes: number; edges: number } }) => ({
            nodes: m.nodes.length,
            edges: m.edges.length,
            droppedNodes: m.dropped.nodes,
            droppedEdges: m.dropped.edges,
          })),
        )
        return { heads: Object.fromEntries(heads.map((h) => [h.number, h.headSha])), ...checked } satisfies ArchitectureMap
      }, (effect, k) => measure('operation', { kind: 'architecture', owner: k.owner, repo: k.repo, prNumber: k.heads[0]?.number, headSha: k.heads.at(-1)?.headSha })(effect))

      const cache = yield* measuredCache(run, { storeId: STORE, ...cacheOptions })
      const read = yield* peek(STORE)
      return Mapper.of({
        cached: (ref, stack) => keyFor(ref, stack).pipe(Effect.flatMap(read), Effect.orElseSucceed(() => undefined)),
        map: (ref, stack) => Effect.flatMap(keyFor(ref, stack), (key) => storeFailuresDie(cache.get(key))),
        steps: (ref, stack) => Stream.unwrap(keyFor(ref, stack).pipe(Effect.map((key) => steps.follow(idOf(key))), Effect.orElseSucceed(() => Stream.never))),
      })
    }),
  )
}
