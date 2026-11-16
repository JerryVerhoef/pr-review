import type { AgentAccount } from '@pr-review/domain'
import { Cache, Context, Effect, Exit, FileSystem, Layer, Schema } from 'effect'
import { createHash } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'
import { expandHome } from './Acp.ts'
import { Config } from './Config.ts'
import { Git } from './Git.ts'

/** A file of a skill kept in a repo: `<…>/.agents/skills/<name>/…` or `<…>/.claude/skills/<name>/…`. */
export const REPO_SKILL = /^(?:.*\/)?\.(?:agents|claude)\/skills\/([^/]+)\/(.+)$/

const EnabledPlugins = Schema.fromJsonString(Schema.Struct({ enabledPlugins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)) }))
const InstalledPlugins = Schema.fromJsonString(Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Array(Schema.Struct({ installPath: Schema.String }))) }))

/** The repo's skills, each by name with its files relative to the skill folder; a name's first folder wins. */
export const repoSkills = (paths: ReadonlyArray<string>) => {
  const skills = new Map<string, { dir: string; files: string[] }>()
  for (const p of paths) {
    const m = REPO_SKILL.exec(p)
    if (!m) continue
    const dir = p.slice(0, p.length - m[2]!.length)
    const skill = skills.get(m[1]!) ?? skills.set(m[1]!, { dir, files: [] }).get(m[1]!)!
    if (skill.dir === dir) skill.files.push(m[2]!)
  }
  return new Map([...skills].filter(([, s]) => s.files.includes('SKILL.md')))
}

/**
 * Skills for review agents, as plugins that hold nothing but skills: no hooks, permission rules, MCP or LSP servers.
 * Loading the account's own settings instead would bring its permission rules, which approve tools past the git gate.
 */
export class Skills extends Context.Service<
  Skills,
  {
    /** The account's own skills (its skills folder and its enabled plugins'), and the repo's at its default branch. Never fails. */
    plugins(account: AgentAccount, cwd: string): Effect.Effect<ReadonlyArray<string>>
    /** Where the plugins live; agents may Read under it, for the files a skill names. */
    readonly root: string
  }
>()('pr-review/Skills') {
  static readonly layer = Layer.effect(
    Skills,
    Effect.gen(function* () {
      const config = yield* Config
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem
      const root = join(config.cacheRoot, 'skills')
      const repos = join(config.cacheRoot, 'repos') + sep

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

      const fromRepo = (key: string, sha: string) =>
        Effect.gen(function* () {
          const skills = repoSkills(yield* git.lsTree(key, sha, []))
          if (skills.size === 0) return undefined
          return yield* plugin(join(root, 'repo', key, sha), 'repo', (dir) =>
            Effect.forEach(
              [...skills].flatMap(([name, s]) => s.files.map((f) => ({ to: join(dir, name, f), from: s.dir + f }))),
              ({ to, from }) => Effect.andThen(fs.makeDirectory(dirname(to), { recursive: true }), Effect.flatMap(git.show(key, sha, from), (text) => fs.writeFileString(to, text))),
              { concurrency: 8, discard: true },
            ),
          )
        })
      // One build per key at a time; a failed build is tried again next session.
      const builds = yield* Cache.makeWith((spec: string) => {
        const [kind, a, b] = JSON.parse(spec) as [string, string, string]
        return (kind === 'repo' ? fromRepo(a, b) : own(JSON.parse(a) as Record<string, string>)).pipe(
          Effect.tapCause((cause) => Effect.logWarning(`Skills for review agents not loaded: ${cause}`)),
          Effect.orElseSucceed(() => undefined),
        )
      }, { capacity: 64, timeToLive: (exit: Exit.Exit<string | undefined>) => (Exit.isSuccess(exit) && exit.value !== undefined ? Infinity : 0) })

      const repoPlugin = (cwd: string) =>
        Effect.gen(function* () {
          if (!cwd.startsWith(repos) || !cwd.endsWith('.git')) return undefined
          const key = relative(repos, cwd).slice(0, -'.git'.length)
          const sha = yield* git.revParse(key, `origin/${yield* git.defaultBranch(key)}`)
          return yield* Cache.get(builds, JSON.stringify(['repo', key, sha]))
        }).pipe(Effect.orElseSucceed(() => undefined))

      return Skills.of({
        root,
        plugins: (account, cwd) =>
          Effect.map(Effect.all([Cache.get(builds, JSON.stringify(['own', JSON.stringify(account.env), ''])), repoPlugin(cwd)], { concurrency: 2 }), (ps) =>
            ps.filter((p): p is string => p !== undefined),
          ),
      })
    }),
  )

  static readonly layerTest = (plugins: ReadonlyArray<string> = []) => Layer.succeed(Skills, Skills.of({ root: '/skills', plugins: () => Effect.succeed(plugins) }))
}
