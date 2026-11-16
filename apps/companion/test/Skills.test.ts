import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { type AgentAccount, defaultSettings } from '@pr-review/domain'
import { Effect, Layer } from 'effect'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Config } from '../src/Config.ts'
import { repoSkills } from '../src/repoSkills.ts'
import { Skills } from '../src/Skills.ts'
import { fakeGit } from './fakes.ts'
import { tmp } from './helpers.ts'

const file = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

describe('Skills', () => {
  it('finds a repo skill by its SKILL.md, the first folder of a name winning', () => {
    const skills = repoSkills([
      '.agents/skills/api/SKILL.md',
      '.agents/skills/api/ref/rules.md',
      'apps/web/.claude/skills/api/SKILL.md',
      '.claude/skills/notes/README.md',
      'src/skills/x/SKILL.md',
    ])
    assert.deepStrictEqual([...skills], [['api', { dir: '.agents/skills/api/', files: ['SKILL.md', 'ref/rules.md'] }]])
  })

  it.effect("loads the account's skills and its enabled plugins' skills, and the repo's at its default branch", () =>
    Effect.gen(function* () {
      const home = tmp()
      const cacheRoot = tmp()
      const plugin = join(home, 'plugins', 'cache', 'p')
      file(join(home, 'skills', 'mine', 'SKILL.md'), 'mine')
      file(join(plugin, 'skills', 'theirs', 'SKILL.md'), 'theirs')
      file(join(home, 'plugins', 'cache', 'off', 'skills', 'off', 'SKILL.md'), 'off')
      file(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'p@m': true, 'off@m': false }, permissions: { allow: ['Read(//**)'] } }))
      file(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: plugin }], 'off@m': [{ installPath: join(home, 'plugins', 'cache', 'off') }] } }))
      const show: Record<string, string> = { 'origin/master:.agents/skills/api/SKILL.md': 'api', 'origin/master:.agents/skills/api/ref/rules.md': 'rules' }
      const git = fakeGit({ rules: ['.agents/skills/api/SKILL.md', '.agents/skills/api/ref/rules.md', 'src/a.ts'], show })
      const account: AgentAccount = { id: 'a', name: 'A', agent: 'claude', command: 'x', env: { CLAUDE_CONFIG_DIR: home }, concurrency: 1, enabled: true }
      const layer = Skills.layer.pipe(Layer.provide([git.layer, Config.layerTest({ cacheRoot, settings: defaultSettings }), NodeServices.layer]))

      yield* Effect.gen(function* () {
        const skills = yield* Skills
        const plugins = yield* skills.plugins(account, 'h/o/r')
        assert.deepStrictEqual(yield* skills.plugins(account, 'h/o/r'), plugins)
        const [own, repo] = plugins as [string, string]
        assert.strictEqual(readlinkSync(join(own, 'skills', 'mine')), join(home, 'skills', 'mine'))
        assert.strictEqual(readlinkSync(join(own, 'skills', 'theirs')), join(plugin, 'skills', 'theirs'))
        assert.throws(() => readlinkSync(join(own, 'skills', 'off')))
        assert.strictEqual(readFileSync(join(repo, 'skills', 'api', 'ref', 'rules.md'), 'utf8'), 'rules')
        assert.deepInclude(JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8')), { name: 'repo' })

        // Reads stay in the skills, judged by where a file really is: `..` through a symlink leaves them.
        file(join(home, 'secret'), 'x')
        symlinkSync(join(home, 'secret'), join(home, 'skills', 'mine', 'link'))
        assert.isTrue(skills.readable(join(own, 'skills', 'mine', 'SKILL.md')))
        assert.isTrue(skills.readable(join(repo, 'skills', 'api', 'ref', 'rules.md')))
        assert.isFalse(skills.readable(join(own, 'skills', 'mine', '..', '..', 'secret')))
        assert.isFalse(skills.readable(join(own, 'skills', 'mine', 'link')))
        assert.isFalse(skills.readable(join(home, 'settings.json')))

        // A commit that leaves the skills alone keeps the folder; one that changes them replaces it.
        assert.strictEqual((yield* skills.plugins(account, 'h/o/r'))[1], repo)
        show['origin/master:.agents/skills/api/SKILL.md'] = 'api v2'
        const [, next] = (yield* skills.plugins(account, 'h/o/r')) as [string, string]
        assert.notStrictEqual(next, repo)
        assert.strictEqual(readFileSync(join(next, 'skills', 'api', 'SKILL.md'), 'utf8'), 'api v2')
        assert.isFalse(existsSync(repo))
        assert.deepStrictEqual(readdirSync(join(cacheRoot, 'skills', 'repo', 'h/o/r')), [next.split('/').at(-1)])
      }).pipe(Effect.provide(layer))
    }))

  it.effect('a session outside a repo gets no repo skills, and an account without skills none', () =>
    Effect.gen(function* () {
      const layer = Skills.layer.pipe(Layer.provide([fakeGit().layer, Config.layerTest({ cacheRoot: tmp(), settings: defaultSettings }), NodeServices.layer]))
      const account: AgentAccount = { id: 'a', name: 'A', agent: 'claude', command: 'x', env: { CLAUDE_CONFIG_DIR: tmp() }, concurrency: 1, enabled: true }
      const plugins = yield* Effect.gen(function* () {
        return yield* (yield* Skills).plugins(account)
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(plugins, [])
    }))
})
