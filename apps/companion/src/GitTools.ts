import type * as acp from '@agentclientprotocol/sdk'
import { NodeHttpServer } from '@effect/platform-node'
import { GitError } from '@pr-review/domain'
import { Context, Effect, Layer, Schema, type Scope, Stream } from 'effect'
import { McpProtocol, McpServer, Tool, Toolkit } from 'effect/ai'
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { basename, join, matchesGlob } from 'node:path'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { loginPath } from './shellPath.ts'
import { annotate, measure } from './Perf.ts'

/** The repo a tool call reads: the clone its session was registered for. */
class Caller extends Context.Service<Caller, { readonly repo: string }>()('pr-review/GitTools/Caller') {}

const dependencies = [Caller]
const Ref = Schema.String.annotate({ description: 'A commit, branch (origin/<name>) or tag, as named under "Refs" in your instructions' })
const Paths = Schema.Array(Schema.String).annotate({ description: 'Files or directories to limit it to, relative to the repo root' })
const tool = <const N extends string, P extends Schema.Struct.Fields>(name: N, description: string, parameters: P) =>
  Tool.make(name, { description, parameters: Schema.Struct(parameters), success: Schema.String, failure: GitError, failureMode: 'return', dependencies })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false)

export const GitToolkit = Toolkit.make(
  tool('show', 'A file at a ref, with line numbers. Pass from and to (1-based, inclusive) for part of a long file.', {
    ref: Ref,
    path: Schema.String,
    from: Schema.optionalKey(Schema.Number),
    to: Schema.optionalKey(Schema.Number),
  }),
  tool(
    'grep',
    'Lines matching a regular expression (Rust regex syntax: | for alternation, no backslash before it) in the files at a ref, as path:line:text. Much faster than git grep.',
    {
      pattern: Schema.String,
      ref: Ref,
      paths: Schema.optionalKey(Paths),
      glob: Schema.optionalKey(Schema.String.annotate({ description: 'File name glob such as *.php; with a slash it matches the whole path' })),
      fixed: Schema.optionalKey(Schema.Boolean.annotate({ description: 'Match the pattern as plain text' })),
      ignoreCase: Schema.optionalKey(Schema.Boolean),
    },
  ),
  tool('diff', 'The unified diff between two refs.', { from: Ref, to: Ref, paths: Schema.optionalKey(Paths) }),
  tool('list_files', 'Every file path at a ref, under a directory when given.', { ref: Ref, path: Schema.optionalKey(Schema.String) }),
  tool('log', 'Commits reachable from a ref, newest first: hash, date, author, subject.', {
    ref: Ref,
    path: Schema.optionalKey(Schema.String),
    max: Schema.optionalKey(Schema.Number.annotate({ description: 'At most this many, default 20' })),
  }),
)

const MAX_MATCHES = 200
const MAX_LINES = 2000
const MAX_DIFF = 60_000
/** Past this many files changed against the default branch checkout, a grep reads the ref itself instead. */
const MAX_DIFFERING = 3000

const fail = (message: string) => new GitError({ message })
// Every argument starting with "-" would be an option to git or rg.
const safeRef = (ref: string) => (/^[\w./~^@{}-]+$/.test(ref) && !ref.startsWith('-') ? Effect.succeed(ref) : Effect.fail(fail(`Not a ref: ${ref}`)))
const safePath = (p: string) => {
  const path = p.replace(/^\.?\/+/, '').replace(/\/+$/, '')
  return path.startsWith('-') || path.split('/').includes('..') ? Effect.fail(fail(`Not a repo path: ${p}`)) : Effect.succeed(path)
}
const underAny = (paths: ReadonlyArray<string>) => (file: string) => paths.length === 0 || paths.some((p) => p === '' || file === p || file.startsWith(`${p}/`))
const globMatch = (glob: string | undefined) => (file: string) => glob === undefined || matchesGlob(glob.includes('/') ? file : basename(file), glob)
const numbered = (text: string, from = 1, to?: number) => {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const last = Math.min(lines.length, to ?? from + MAX_LINES - 1, from + MAX_LINES - 1)
  const body = lines.slice(from - 1, last).map((l, i) => `${from + i}\t${l}`).join('\n')
  return last < lines.length ? `${body}\n(lines ${from}-${last} of ${lines.length}; pass from and to for more)` : body
}
const capped = (matches: ReadonlyArray<string>) =>
  matches.length > MAX_MATCHES
    ? `${matches.slice(0, MAX_MATCHES).join('\n')}\n(${matches.length - MAX_MATCHES} more matches; narrow the pattern or paths)`
    : matches.join('\n') || '(no matches)'

/**
 * Read-only git for review agents, served over MCP from the companion. A call through the agent's shell costs about a
 * second of its own; this is a local HTTP request. `grep` reads a checkout of the default branch with ripgrep, and the
 * files that differ at the asked ref with git grep, so its answer is the ref's at a fraction of a tree grep's time.
 */
export class GitTools extends Context.Service<
  GitTools,
  {
    /** The MCP server for a session reading `repo` (a repo key), valid until the scope closes. */
    register(repo: string): Effect.Effect<acp.McpServer, never, Scope.Scope>
  }
>()('pr-review/GitTools') {
  static readonly layer = Layer.effect(
    GitTools,
    Effect.gen(function* () {
      const git = yield* Git
      const config = yield* Config
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const scope = yield* Effect.scope

      const text = (s: Stream.Stream<Uint8Array, unknown>) => Stream.mkString(Stream.decodeText(s))
      /** stdout, or a GitError; `ok` lists exit codes besides 0 that are an answer (1: no matches). */
      const run = (cmd: string, args: ReadonlyArray<string>, cwd: string, ok: ReadonlyArray<number> = [], PATH?: string) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make(cmd, args, { cwd, env: { GIT_TERMINAL_PROMPT: '0', ...(PATH ? { PATH } : {}) }, extendEnv: true }))
          const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' })
          if (code !== 0 && !ok.includes(code)) return yield* fail(`${cmd} ${args[0]}: ${stderr.trim().split('\n')[0] || `exit ${code}`}`)
          return stdout
        }).pipe(
          Effect.scoped,
          Effect.mapError((e) => (e instanceof GitError ? e : fail(String(e)))),
        )
      const inClone = (repo: string, args: ReadonlyArray<string>, ok?: ReadonlyArray<number>) => run('git', args, git.dir(repo), ok)
      const commit = (repo: string, ref: string) => Effect.flatMap(safeRef(ref), (r) => Effect.map(inClone(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${r}^{commit}`]), (s) => s.trim()))

      // A checkout of each repo's default branch for ripgrep, moved along in the background; a grep never waits for it.
      const trees = new Map<string, { dir: string; sha: string }>()
      const moving = new Set<string>()
      const refreshTree = (repo: string) =>
        Effect.gen(function* () {
          if (moving.has(repo)) return
          const sha = yield* commit(repo, `origin/${yield* git.defaultBranch(repo)}`)
          if (trees.get(repo)?.sha === sha) return
          moving.add(repo)
          trees.delete(repo)
          const dir = join(config.cacheRoot, 'trees', repo)
          const at = yield* run('git', ['rev-parse', 'HEAD'], dir).pipe(Effect.orElseSucceed(() => undefined))
          if (at === undefined) {
            yield* inClone(repo, ['worktree', 'prune'])
            yield* inClone(repo, ['worktree', 'add', '--quiet', '--detach', '--force', dir, sha])
          } else if (at.trim() !== sha) yield* run('git', ['checkout', '--quiet', '--detach', '--force', sha], dir)
          trees.set(repo, { dir, sha })
        }).pipe(
          Effect.ensuring(Effect.sync(() => void moving.delete(repo))),
          measure('git.tree'),
          Effect.ignore,
        )

      // ripgrep on the host's PATH, else on the login shell's (a browser starts the host with a bare one), else none.
      let rgPath: string | undefined
      let rgMissing = false
      /** `path:line:text` lines in the checkout, by ripgrep, or git grep on its files when there is no rg. */
      const grepTree = (dir: string, o: { pattern: string; paths: ReadonlyArray<string>; glob?: string | undefined; fixed?: boolean | undefined; ignoreCase?: boolean | undefined }) => {
        const flags = [...(o.fixed ? ['-F'] : []), ...(o.ignoreCase ? ['-i'] : [])]
        const where = o.paths.length ? o.paths : ['.']
        const viaGit = Effect.map(
          run('git', ['grep', '-n', '-I', '--no-color', ...(o.fixed ? [] : ['-E']), ...flags, '-e', o.pattern, '--', ...where], dir, [1]),
          (out) => out.split('\n').filter(Boolean),
        )
        if (rgMissing) return viaGit
        const viaRg = (PATH?: string) =>
          run('rg', ['-n', '--no-heading', '--color', 'never', '--hidden', '-g', '!.git', ...(o.glob ? ['-g', o.glob] : []), ...flags, '-e', o.pattern, '--', ...where], dir, [1], PATH).pipe(
            Effect.map((out) => out.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''))),
          )
        const missing = (e: GitError) => /ENOENT|not found/i.test(e.message)
        return viaRg(rgPath).pipe(
          Effect.catchIf(missing, () =>
            rgPath !== undefined
              ? Effect.fail(fail('rg: not found'))
              : Effect.flatMap(Effect.promise(loginPath), (PATH) => (PATH ? Effect.tap(viaRg(PATH), () => Effect.sync(() => void (rgPath = PATH))) : Effect.fail(fail('rg: not found')))),
          ),
          Effect.catchIf(missing, () => Effect.andThen(Effect.sync(() => void (rgMissing = true)), viaGit)),
        )
      }

      const grep = (repo: string, o: { pattern: string; ref: string; paths?: ReadonlyArray<string> | undefined; glob?: string | undefined; fixed?: boolean | undefined; ignoreCase?: boolean | undefined }) =>
        Effect.gen(function* () {
          const sha = yield* commit(repo, o.ref)
          const paths = yield* Effect.forEach(o.paths ?? [], safePath)
          const wanted = (file: string) => underAny(paths)(file) && globMatch(o.glob)(file)
          const flags = [...(o.fixed ? ['-F'] : ['-E']), ...(o.ignoreCase ? ['-i'] : [])]
          const atRef = (files: ReadonlyArray<string>) =>
            Effect.map(inClone(repo, ['grep', '-n', '-I', '--no-color', ...flags, '-e', o.pattern, sha, '--', ...files], [1]), (out) =>
              out
                .split('\n')
                .filter(Boolean)
                .map((l) => l.slice(sha.length + 1)),
            )
          const tree = trees.get(repo)
          // Without renames, a moved file counts at both paths, so the old one's lines in the checkout are dropped.
          const differing = tree ? (yield* inClone(repo, ['diff', '--name-only', '--no-renames', '-z', tree.sha, sha])).split('\0').filter(Boolean) : []
          yield* annotate({ tree: tree !== undefined, differing: differing.length })
          let lines: ReadonlyArray<string>
          if (!tree || differing.length > MAX_DIFFERING) lines = (yield* atRef(paths)).filter((l) => wanted(l.slice(0, l.indexOf(':'))))
          else {
            const differs = new Set(differing)
            const fromTree = (yield* grepTree(tree.dir, { ...o, paths })).filter((l) => {
              const file = l.slice(0, l.indexOf(':'))
              return !differs.has(file) && wanted(file)
            })
            const changed = differing.filter(wanted)
            // A file the ref deletes is absent there; git grep skips it.
            lines = [...fromTree, ...(changed.length ? yield* atRef(changed) : [])]
          }
          const sorted = [...lines].sort((a, b) => {
            const [pa, la] = [a.slice(0, a.indexOf(':')), Number(a.split(':')[1])]
            const [pb, lb] = [b.slice(0, b.indexOf(':')), Number(b.split(':')[1])]
            return pa === pb ? la - lb : pa < pb ? -1 : 1
          })
          return capped(sorted.map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)))
        })

      const handlers = GitToolkit.toLayer({
        show: ({ ref, path, from, to }) =>
          Effect.gen(function* () {
            const { repo } = yield* Caller
            const sha = yield* commit(repo, ref)
            const p = yield* safePath(path)
            return numbered(yield* inClone(repo, ['cat-file', '-p', `${sha}:${p}`]), Math.max(1, from ?? 1), to)
          }).pipe(measure('mcp.tool', { tool: 'show' })),
        grep: (o) => Effect.flatMap(Caller, ({ repo }) => grep(repo, o)).pipe(measure('mcp.tool', { tool: 'grep' })),
        diff: ({ from, to, paths }) =>
          Effect.gen(function* () {
            const { repo } = yield* Caller
            const [a, b] = yield* Effect.all([commit(repo, from), commit(repo, to)])
            const out = yield* inClone(repo, ['diff', '--no-color', '--no-ext-diff', '-M', a, b, '--', ...(yield* Effect.forEach(paths ?? [], safePath))])
            return out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n(diff cut at ${MAX_DIFF} characters; pass paths for the rest)` : out || '(no changes)'
          }).pipe(measure('mcp.tool', { tool: 'diff' })),
        list_files: ({ ref, path }) =>
          Effect.gen(function* () {
            const { repo } = yield* Caller
            const sha = yield* commit(repo, ref)
            const files = (yield* inClone(repo, ['ls-tree', '-r', '--name-only', sha, '--', ...(path ? [yield* safePath(path)] : [])])).split('\n').filter(Boolean)
            return files.length > MAX_LINES ? `${files.slice(0, MAX_LINES).join('\n')}\n(${files.length - MAX_LINES} more; pass a path)` : files.join('\n') || '(no files)'
          }).pipe(measure('mcp.tool', { tool: 'list_files' })),
        log: ({ ref, path, max }) =>
          Effect.gen(function* () {
            const { repo } = yield* Caller
            const sha = yield* commit(repo, ref)
            const n = Math.min(100, Math.max(1, max ?? 20))
            return (yield* inClone(repo, ['log', '--no-color', '--date=short', '--format=%h %ad %an %s', `-n${n}`, sha, '--', ...(path ? [yield* safePath(path)] : [])])) || '(no commits)'
          }).pipe(measure('mcp.tool', { tool: 'log' })),
      })

      // A bearer token per session, so a call reads the clone its session was registered for and nothing answers others.
      const sessions = new Map<string, string>()
      const auth = HttpRouter.middleware<{ provides: Caller }>()(
        Effect.succeed((httpEffect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const header = request.headers.authorization ?? ''
            const repo = header.startsWith('Bearer ') ? sessions.get(header.slice(7).trim()) : undefined
            if (repo === undefined) return HttpServerResponse.empty({ status: 401 })
            return yield* Effect.provideService(httpEffect, Caller, { repo })
          }),
        ),
      ).layer

      const app = McpServer.layerHttp({
        name: 'git',
        version: '1',
        path: '/mcp',
        protocols: [McpProtocol.v2025_06_18],
        registrations: McpServer.toolkit(GitToolkit).pipe(Layer.provide(handlers)),
      }).pipe(Layer.provide(auth))
      const server = HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
      )
      const built = yield* Layer.buildWithScope(server, scope)
      const address = Context.get(built, HttpServer.HttpServer).address
      const url = address._tag === 'InetAddressV4' ? `http://127.0.0.1:${address.port}/mcp` : ''

      return GitTools.of({
        register: (repo) =>
          Effect.gen(function* () {
            const token = randomBytes(32).toString('base64url')
            yield* Effect.acquireRelease(
              Effect.sync(() => void sessions.set(token, repo)),
              () => Effect.sync(() => void sessions.delete(token)),
            )
            yield* Effect.forkIn(refreshTree(repo), scope)
            return { type: 'http', name: 'git', url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] } satisfies acp.McpServer
          }),
      })
    }),
  )

  /** No server: sessions get a server entry nothing answers. */
  static readonly layerTest = Layer.succeed(GitTools, GitTools.of({ register: () => Effect.succeed({ type: 'http', name: 'git', url: 'http://127.0.0.1:9/mcp', headers: [] }) }))
}
