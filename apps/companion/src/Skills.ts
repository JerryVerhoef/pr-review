import type { AgentAccount } from '@pr-review/domain'
import { Cache, Context, Effect, Exit, FileSystem, Layer, Schema } from 'effect'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { Config } from './Config.ts'
import { Git } from './Git.ts'
import { repoSkills } from './repoSkills.ts'
import { expandHome } from './shellPath.ts'

const EnabledPlugins = Schema.fromJsonString(Schema.Struct({ enabledPlugins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)) }))
const InstalledPlugins = Schema.fromJsonString(Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Array(Schema.Struct({ installPath: Schema.String }))) }))

/**
 * Skills for review agents, as plugins that hold nothing but skills: no hooks, permission rules, MCP or LSP servers.
 * Loading the account's own settings instead would bring its permission rules, which approve tools past the git gate.
 */
export class Skills extends Context.Service<
  Skills,
  {
    /** The account's own skills (its skills folder and its enabled plugins'), and those of `repo` (a repo key) at its default branch. Never fails. */
    plugins(account: AgentAccount, repo?: string): Effect.Effect<ReadonlyArray<string>>
    /** Whether a Read may open `path`: a file in a skill handed out, once symlinks are resolved. */
    readable(path: string): boolean
  }
>()('pr-review/Skills') {
  static readonly layer = Layer.effect(
    Skills,
    Effect.gen(function* () {
      const config = yield* Config
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem
      const root = join(config.cacheRoot, 'skills')
      /** Real paths of the skill folders handed out; an own skill is a symlink to the account's folder. */
      const readableRoots = new Set<string>()

      /** Writes a plugin once: into a partial folder, renamed into place, so a reader never sees half of one. */
      const plugin = (dir: string, name: string, fill: (skills: string) => Effect.Effect<void, unknown>) =>
        Effect.gen(function* () {
          if (yield* fs.exists(dir)) return dir
          const partial = `${dir}.partial`
          yield* fs.remove(partial, { recursive: true, force: true })
          yield* fs.makeDirectory(join(partial, '.claude-plugin'), { recursive: true })
          yield* fs.writeFileString(join(partial, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }))
          yield* fs.makeDirectory(join(partial, 'skills'))
          yield* fill(join(partial, 'skills'))
          yield* fs.rename(partial, dir)
          return dir
        })

      const skillDirs = (parent: string) =>
        Effect.flatMap(Effect.orElseSucceed(fs.readDirectory(parent), () => []), (names) =>
          Effect.filter(names.map((n) => join(parent, n)), (d) => Effect.orElseSucceed(fs.exists(join(d, 'SKILL.md')), () => false)),
        )

      const own = (env: Readonly<Record<string, string>>) =>
        Effect.gen(function* () {
          const home = expandHome(env.CLAUDE_CONFIG_DIR ?? '~/.claude')
          const read = <S extends Schema.Top & { readonly DecodingServices: never }>(file: string, schema: S) =>
            fs.readFileString(join(home, file)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)), Effect.option)
          const enabled = yield* read('settings.json', EnabledPlugins)
          const installed = yield* read(join('plugins', 'installed_plugins.json'), InstalledPlugins)
          const paths = [
            ...(yield* skillDirs(join(home, 'skills'))),
            ...(enabled._tag === 'Some' && installed._tag === 'Some'
              ? yield* Effect.forEach(
                  Object.entries(enabled.value.enabledPlugins ?? {}).flatMap(([id, on]) => (on ? (installed.value.plugins[id]?.slice(0, 1) ?? []) : [])),
                  (p) => skillDirs(join(p.installPath, 'skills')),
                )
              : []
            ).flat(),
          ]
          const byName = new Map<string, string>()
          for (const p of paths) if (!byName.has(p.split(sep).at(-1)!)) byName.set(p.split(sep).at(-1)!, p)
          if (byName.size === 0) return undefined
          const id = createHash('sha256').update(JSON.stringify([...byName])).digest('hex').slice(0, 16)
          return yield* plugin(join(root, 'own', id), 'own', (skills) => Effect.forEach([...byName], ([name, target]) => fs.symlink(target, join(skills, name)), { discard: true }))
        })

      const fromRepo = (key: string) =>
        Effect.gen(function* () {
          const sha = yield* git.revParse(key, `origin/${yield* git.defaultBranch(key)}`)
          const blobs = yield* git.blobs(key, sha)
          const skills = repoSkills(blobs.map((b) => b.path))
          if (skills.size === 0) return undefined
          const files = [...skills].flatMap(([name, s]) => s.files.map((f) => ({ to: join(name, f), from: s.dir + f })))
          const wanted = new Set(files.map((f) => f.from))
          // Named by the skills' content, so a commit that leaves them alone reuses the folder.
          const id = createHash('sha256').update(JSON.stringify(blobs.filter((b) => wanted.has(b.path)))).digest('hex').slice(0, 16)
          const dir = yield* plugin(join(root, 'repo', key, id), 'repo', (skillsDir) =>
            Effect.forEach(
              files,
              ({ to, from }) =>
                Effect.andThen(fs.makeDirectory(dirname(join(skillsDir, to)), { recursive: true }), Effect.flatMap(git.show(key, sha, from), (text) => fs.writeFileString(join(skillsDir, to), text))),
              { concurrency: 8, discard: true },
            ),
          )
          // ponytail: a session still reading an older folder loses its skills' files; keep the last few if that bites.
          const older = (yield* fs.readDirectory(join(root, 'repo', key))).filter((n) => n !== id)
          yield* Effect.forEach(older, (n) => fs.remove(join(root, 'repo', key, n), { recursive: true, force: true }), { discard: true })
          return dir
        })
      // One build per key at a time; a failed build is tried again next session.
      const builds = yield* Cache.makeWith((spec: string) => {
        const [kind, a] = JSON.parse(spec) as [string, string]
        return (kind === 'repo' ? fromRepo(a) : own(JSON.parse(a) as Record<string, string>)).pipe(
          Effect.tapCause((cause) => Effect.logWarning(`Skills for review agents not loaded: ${cause}`)),
          Effect.orElseSucceed(() => undefined),
        )
        // A repo's skills are looked up again for each session, for a push to its default branch.
      }, { capacity: 64, timeToLive: (exit: Exit.Exit<string | undefined>, spec: string) => (spec.startsWith('["repo"') || !Exit.isSuccess(exit) || exit.value === undefined ? 0 : Infinity) })

      /** Lets Reads into each skill of `plugins`, wherever its folder really is. */
      const allow = (plugins: ReadonlyArray<string>) =>
        Effect.forEach(plugins, (p) =>
          Effect.flatMap(Effect.orElseSucceed(fs.readDirectory(join(p, 'skills')), () => []), (names) =>
            Effect.forEach(names, (n) => Effect.map(Effect.option(fs.realPath(join(p, 'skills', n))), (real) => real._tag === 'Some' && void readableRoots.add(real.value))),
          ),
        )

      return Skills.of({
        plugins: (account, repo) =>
          Effect.all([Cache.get(builds, JSON.stringify(['own', JSON.stringify(account.env)])), repo ? Cache.get(builds, JSON.stringify(['repo', repo])) : Effect.undefined], { concurrency: 2 }).pipe(
            Effect.map((ps) => ps.filter((p): p is string => p !== undefined)),
            Effect.tap(allow),
          ),
        readable: (path) => {
          try {
            const real = realpathSync(path)
            return [...readableRoots].some((r) => real.startsWith(r + sep))
          } catch {
            return false
          }
        },
      })
    }),
  )

  static readonly layerTest = (plugins: ReadonlyArray<string> = []) => Layer.succeed(Skills, Skills.of({ plugins: () => Effect.succeed(plugins), readable: () => false }))
}
