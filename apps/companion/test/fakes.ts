import { type AgentAccount, AgentError, type AgentSort, defaultSettings, type FileStat, GitError, type PrMeta, type StackOverview } from '@pr-review/domain'
import { Effect, Layer, Schema, Stream } from 'effect'
import { Agent } from '../src/Agent.ts'
import { Config } from '../src/Config.ts'
import { Git } from '../src/Git.ts'
import { GitHub, type GitHubClient } from '../src/GitHub.ts'

export const ref = { host: 'h', owner: 'o', repo: 'r', number: 7 }
export const repoKey = 'h/o/r'

export const configLayer = (cacheRoot = '/cache') => Config.layerTest({ cacheRoot, settings: { ...defaultSettings, hosts: [ref.host] } })

/** Session turns carry their session (numbered from 1), account, index in the session (from 0) and the model asked for. */
export type AgentCall = {
  prompt: string
  cwd: string
  related?: ReadonlyArray<string>
  prefer?: 'deep'
  resume?: string
  log: { kind: string; number: number; headSha?: string }
  session?: number
  account?: string
  turn?: number
  model?: 'fast' | 'main'
  onText?: (line: string) => Effect.Effect<void>
  onDelta?: (delta: string) => Effect.Effect<void>
}

export const fakeAccount: AgentAccount = { id: 'fake', name: 'Fake', agent: 'custom', command: 'x', env: {}, concurrency: 1, enabled: true }
export const fakeAccount2: AgentAccount = { ...fakeAccount, id: 'fake2', name: 'Fake 2' }

/**
 * An Agent whose structured runs and session turns answer with `reply()`, streaming runs emit `Hi` then Done, and ticket runs answer with `ticket()` (default: no ticket account).
 * A session takes the least busy `pool` account it doesn't avoid (the first of equals); `freeSlots()` is the pool's slots but one, the asking session's.
 * A session failing with "usage limit" benches its account for later sessions too: `use` reruns in a new session on the next pool account, while there is one.
 */
export const fakeAgent = (
  reply: (call: AgentCall) => Effect.Effect<unknown, any> = () => Effect.succeed({ decisions: [], skim: [], claims: [] } satisfies AgentSort),
  ticket: (prompt: string) => Effect.Effect<string, AgentError> = () => Effect.fail(new AgentError({ message: 'No AI account is set to read tickets' })),
  pool: ReadonlyArray<AgentAccount> = [fakeAccount],
) => {
  const calls: AgentCall[] = []
  let sessions = 0
  const busy = new Map<string, number>()
  const benched = new Set<string>()
  const ticketPrompts: string[] = []
  const ticketModels: Array<'fast' | 'main' | undefined> = []
  const answer = (call: AgentCall, onStep: ((s: string) => Effect.Effect<void>) | undefined, schema: Schema.Top) =>
    Effect.suspend(() => {
      calls.push(call)
      return (onStep?.('Searching for "x"') ?? Effect.void).pipe(
        Effect.andThen(reply(call)),
        Effect.flatMap((x) => Effect.orDie(Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>)(x))),
      )
    })
  const layer = Layer.succeed(
    Agent,
    Agent.of({
      structured: (o) => answer(o, o.onStep, o.schema) as never,
      session: (o, use) => {
        const attempt = (tried: ReadonlySet<string>): ReturnType<typeof use> =>
          Effect.suspend(() => {
            const session = ++sessions
            const free = (a: AgentAccount) => !o.avoid?.has(a.id) && !tried.has(a.id) && !benched.has(a.id)
            const account = pool.filter(free).sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))[0] ?? fakeAccount
            busy.set(account.id, (busy.get(account.id) ?? 0) + 1)
            let turn = 0
            return use(
              {
                ready: Effect.void,
                structured: (prompt, schema, model = 'main', turnKind) =>
                  answer({ ...o, prompt, session, account: account.id, turn: turn++, model, log: turnKind ? { ...o.log, kind: turnKind } : o.log }, o.onStep, schema) as never,
              },
              account,
            ).pipe(
              Effect.ensuring(Effect.sync(() => void busy.set(account.id, busy.get(account.id)! - 1))),
              Effect.catchIf((e) => /usage limit/.test(e.message) && pool.some((a) => a.id !== account.id && free(a)), () => (benched.add(account.id), attempt(new Set([...tried, account.id])))),
            )
          })
        return attempt(new Set())
      },
      freeSlots: () => Effect.succeed(pool.reduce((n, a) => n + a.concurrency, 0) - 1),
      streaming: (o) =>
        Stream.suspend(() => {
          calls.push(o)
          return Stream.make({ _tag: 'Text' as const, delta: 'Hi' }, { _tag: 'Done' as const, sessionId: 'sess-1' })
        }),
      ticket: (o) => Effect.suspend(() => (ticketPrompts.push(o.prompt), ticketModels.push(o.model), ticket(o.prompt))),
      status: Effect.succeed([]),
    }),
  )
  return { calls, ticketPrompts, ticketModels, layer, sessions: () => sessions }
}

export const overviewReply: StackOverview = { summary: 's', tables: [], modules: [], endpoints: [], sharedLayers: [] }

export const fakeGit = (o: { files?: FileStat[]; /** A `GitError` from the function fails that diff. */ diff?: string | ((from: string, to: string, paths: ReadonlyArray<string>) => string | GitError); /** One text for every file, or texts keyed `ref:path` (others fail). */ show?: string | Record<string, string>; rules?: string[] } = {}) => {
  const diffPaths: Array<ReadonlyArray<string>> = []
  const shown: string[] = []
  const listed: Array<ReadonlyArray<string>> = []
  const layer = Layer.succeed(
    Git,
    Git.of({
      dir: () => '/cache/repo.git',
      ensureClone: () => Effect.void,
      maintain: () => Effect.void,
      fetchPr: (_k, _n, _b, headSha) => Effect.succeed({ headSha: headSha || 'HEAD1', baseSha: 'BASE1', mergeBase: 'MB1' }),
      numstat: () => Effect.succeed(o.files ?? []),
      diff: (_k, from, to, paths = []) =>
        Effect.suspend(() => {
          diffPaths.push(paths)
          const d = typeof o.diff === 'function' ? o.diff(from, to, paths) : (o.diff ?? '')
          return typeof d === 'string' ? Effect.succeed(d) : Effect.fail(d)
        }),
      show: (_k, ref, path) =>
        Effect.suspend(() => {
          shown.push(ref)
          if (typeof o.show !== 'object') return Effect.succeed(o.show ?? '')
          const text = o.show[`${ref}:${path}`]
          return text === undefined ? Effect.fail(new GitError({ message: `no ${ref}:${path}` })) : Effect.succeed(text)
        }),
      lsTree: (_k, _ref, paths) => Effect.sync(() => (listed.push(paths), o.rules ?? [])),
      // A file's text stands in for its blob id.
      blobs: (_k, ref) => Effect.sync(() => (o.rules ?? []).map((path) => ({ path, id: typeof o.show === 'object' ? `${o.show[`${ref}:${path}`]}` : path }))),
      defaultBranch: () => Effect.succeed('master'),
      revParse: (_k, ref) => Effect.succeed(ref),
    }),
  )
  return { diffPaths, shown, listed, layer }
}

export const pr: PrMeta = { number: 7, title: 'Add a thing', author: 'dev', body: '## Decisions\n- one', baseRef: 'master', headRef: 'feat', headSha: 'HEAD1', state: 'open' }

export const fakeGitHub = (overrides: Partial<GitHubClient> = {}) =>
  Layer.succeed(
    GitHub,
    GitHub.of({
      forHost: () =>
        Effect.succeed({
          getPr: () => Effect.succeed(pr),
          getChecks: () => Effect.succeed('pass' as const),
          listOpenPrs: () => Effect.succeed([]),
          listThreads: () => Effect.succeed([]),
          viewer: () => Effect.succeed('me'),
          requestedReviewers: () => Effect.succeed([]),
          fileAt: () => Effect.undefined,
          getIssue: () => Effect.succeed(null),
          description: () => Effect.succeed(''),
          submitReview: () => Effect.die('unused'),
          ...overrides,
        } satisfies GitHubClient),
    }),
  )
