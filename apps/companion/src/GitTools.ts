import type * as acp from '@agentclientprotocol/sdk'
import { NodeHttpServer } from '@effect/platform-node'
import { GitError } from '@pr-review/domain'
import { Context, Effect, FileSystem, Layer, Schema, type Scope, Stream } from 'effect'
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
    'Lines matching a Perl-compatible regular expression (| for alternation, no backslash before it; \\b, \\d, \\s work) in the files at a ref, as path:line:text. Much faster than git grep.',
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
interface GrepOptions {
  readonly pattern: string
  readonly glob?: string | undefined
  readonly fixed?: boolean | undefined
  readonly ignoreCase?: boolean | undefined
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

      const fs = yield* FileSystem.FileSystem
      const commit = (repo: string, ref: string) => Effect.flatMap(safeRef(ref), (r) => git.revParse(repo, r))

      // A checkout of each repo's default branch for ripgrep, one directory per commit. A grep never waits for a new one;
      // one already reading the tree before it keeps it until the next.
      const trees = new Map<string, { dir: string; sha: string }>()
      const moving = new Set<string>()
      const refreshTree = (repo: string) =>
        Effect.gen(function* () {
          if (moving.has(repo)) return
          const sha = yield* commit(repo, `origin/${yield* git.defaultBranch(repo)}`)
          const previous = trees.get(repo)?.sha
          if (previous === sha) return
          moving.add(repo)
          const root = join(config.cacheRoot, 'trees', repo)
          const dir = join(root, sha)
          if (!(yield* fs.exists(dir))) {
            yield* fs.remove(`${dir}.partial`, { recursive: true, force: true })
            yield* git.pruneTrees(repo)
            yield* git.addTree(repo, dir, sha)
          }
          trees.set(repo, { dir, sha })
          const stale = (yield* fs.readDirectory(root)).filter((d) => d !== sha && d !== previous)
          yield* Effect.forEach(stale, (d) => fs.remove(join(root, d), { recursive: true, force: true }))
          if (stale.length) yield* git.pruneTrees(repo)
        }).pipe(
          Effect.ensuring(Effect.sync(() => void moving.delete(repo))),
          Effect.ignore,
        )

      const text = (s: Stream.Stream<Uint8Array, unknown>) => Stream.mkString(Stream.decodeText(s))
      // ripgrep on the host's PATH, else on the login shell's (a browser starts the host with a bare one).
      let rgPath: string | undefined
      let noRg = false
      const rgRun = (args: ReadonlyArray<string>, cwd: string, PATH?: string) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make('rg', args, { cwd, ...(PATH ? { env: { PATH }, extendEnv: true } : {}) }))
          const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: 'unbounded' })
          if (code !== 0 && code !== 1) return yield* fail(`rg: ${stderr.trim().split('\n')[0] || `exit ${code}`}`)
          return stdout
        }).pipe(
          Effect.scoped,
          Effect.mapError((e) => (e instanceof GitError ? e : fail(String(e)))),
        )
      /** `path:line:text` lines in a checkout, or undefined when there is no ripgrep with PCRE2 to run. */
      const rg = (dir: string, o: GrepOptions & { paths: ReadonlyArray<string> }): Effect.Effect<ReadonlyArray<string> | undefined, GitError> => {
        if (noRg) return Effect.succeed(undefined)
        // --no-ignore: a tracked file that .gitignore names is still in the tree, and git grep reads it.
        const args = ['-n', '--no-heading', '--color', 'never', '--hidden', '--no-ignore', '-g', '!.git', ...(o.glob ? ['-g', o.glob] : []), o.fixed ? '-F' : '-P', ...(o.ignoreCase ? ['-i'] : []), '-e', o.pattern, '--', ...(o.paths.length ? o.paths : ['.'])]
        const once = (PATH?: string) => Effect.map(rgRun(args, dir, PATH), (out) => out.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, '')))
        const missing = (e: GitError) => /ENOENT|not found/i.test(e.message)
        return once(rgPath).pipe(
          Effect.catchIf(
            (e) => missing(e) && rgPath === undefined,
            (e) => Effect.flatMap(Effect.promise(loginPath), (PATH) => (PATH ? Effect.tap(once(PATH), () => Effect.sync(() => void (rgPath = PATH))) : Effect.fail(e))),
          ),
          Effect.catchIf(
            (e) => missing(e) || /PCRE2 is not available/i.test(e.message),
            () => Effect.sync(() => void (noRg = true)),
          ),
        )
      }

      const fileOf = (line: string) => line.slice(0, line.indexOf(':'))
      const grep = (repo: string, o: GrepOptions & { ref: string; paths?: ReadonlyArray<string> | undefined }) =>
        Effect.gen(function* () {
          const sha = yield* commit(repo, o.ref)
          const paths = yield* Effect.forEach(o.paths ?? [], safePath)
          const wanted = (file: string) => underAny(paths)(file) && globMatch(o.glob)(file)
          const atRef = (files: ReadonlyArray<string>) => git.grep(repo, sha, { ...o, files })
          const whole = Effect.map(atRef(paths), (ls) => ls.filter((l) => wanted(fileOf(l))))
          const tree = trees.get(repo)
          // A moved file counts at both paths, so the old one's lines in the checkout are dropped.
          const differing = tree ? yield* git.changedPaths(repo, tree.sha, sha) : []
          yield* annotate({ tree: tree !== undefined, differing: differing.length })
          const fromTree = tree && differing.length <= MAX_DIFFERING ? yield* rg(tree.dir, { ...o, paths }) : undefined
          let lines: ReadonlyArray<string>
          if (fromTree === undefined) lines = yield* whole
          else {
            const differs = new Set(differing)
            const changed = differing.filter(wanted)
            // A file the ref deletes is absent there; git grep skips it.
            lines = [...fromTree.filter((l) => !differs.has(fileOf(l)) && wanted(fileOf(l))), ...(changed.length ? yield* atRef(changed) : [])]
          }
          const sorted = [...lines].sort((a, b) => {
            const [pa, la] = [fileOf(a), Number(a.split(':')[1])]
            const [pb, lb] = [fileOf(b), Number(b.split(':')[1])]
            return pa === pb ? la - lb : pa < pb ? -1 : 1
          })
          return capped(sorted.map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)))
        })

      const handlers = GitToolkit.toLayer({
        show: ({ ref, path, from, to }) =>
          Effect.gen(function* () {
            const { repo } = yield* Caller
            return numbered(yield* git.show(repo, yield* commit(repo, ref), yield* safePath(path)), Math.max(1, from ?? 1), to)
          }).pipe(measure('mcp.tool', { tool: 'show' })),
        grep: (o) => Effect.flatMap(Caller, ({ repo }) => grep(repo, o)).pipe(measure('mcp.tool', { tool: 'grep' })),
        diff: ({ from, to, paths }) =>
          Effect.gen(function* () {
            const { repo } = yield* Caller
            const [a, b] = yield* Effect.all([commit(repo, from), commit(repo, to)])
            const out = yield* git.diff(repo, a, b, yield* Effect.forEach(paths ?? [], safePath))
            return out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n(diff cut at ${MAX_DIFF} characters; pass paths for the rest)` : out || '(no changes)'
          }).pipe(measure('mcp.tool', { tool: 'diff' })),
        list_files: ({ ref, path }) =>
          Effect.gen(function* () {
            const { repo } = yield* Caller
            const files = yield* git.lsTree(repo, yield* commit(repo, ref), path ? [yield* safePath(path)] : [])
            return files.length > MAX_LINES ? `${files.slice(0, MAX_LINES).join('\n')}\n(${files.length - MAX_LINES} more; pass a path)` : files.join('\n') || '(no files)'
          }).pipe(measure('mcp.tool', { tool: 'list_files' })),
        log: ({ ref, path, max }) =>
          Effect.gen(function* () {
            const { repo } = yield* Caller
            const out = yield* git.log(repo, yield* commit(repo, ref), path ? yield* safePath(path) : undefined, Math.min(100, Math.max(1, max ?? 20)))
            return out || '(no commits)'
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
