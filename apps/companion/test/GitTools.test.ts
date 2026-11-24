import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Config } from '../src/Config.ts'
import { Git } from '../src/Git.ts'
import { GitTools } from '../src/GitTools.ts'
import { git, makeRemote, tmp } from './helpers.ts'

const key = 'example.com/acme/app'

const setup = () => {
  const remote = makeRemote()
  const cacheRoot = tmp()
  const layer = GitTools.layer.pipe(
    Layer.provideMerge(Git.layer),
    Layer.provide(Config.layerTest({ cacheRoot, remotes: { [key]: `file://${remote}` } })),
    Layer.provideMerge(NodeServices.layer),
  )
  return { remote, layer, cacheRoot }
}

/** A minimal Streamable HTTP MCP client: the session id from initialize, JSON or SSE answers. */
const client = (url: string, headers: Record<string, string>) => {
  let session: string | undefined
  let id = 0
  const send = (method: string, params: unknown) =>
    Effect.promise(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      })
      session ??= res.headers.get('mcp-session-id') ?? undefined
      const body = await res.text()
      const json = res.headers.get('content-type')?.includes('event-stream') ? body.split('\n').find((l) => l.startsWith('data: '))!.slice(6) : body
      return { status: res.status, json: body ? JSON.parse(json) : undefined }
    })
  const notify = (method: string) =>
    Effect.promise(() =>
      fetch(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', method }),
      }),
    )
  return {
    send,
    init: Effect.andThen(send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }), notify('notifications/initialized')),
    call: (name: string, args: Record<string, unknown>) =>
      Effect.map(send('tools/call', { name, arguments: args }), (r) => (r.json.result.content as Array<{ text: string }>).map((c) => c.text).join('')),
  }
}

/** The default branch checkout at `sha`, once it is there. */
const treeAt = (cacheRoot: string, sha: string) =>
  Effect.gen(function* () {
    const dir = join(cacheRoot, 'trees', key, sha)
    for (let i = 0; !existsSync(dir) && i < 100; i++) yield* Effect.sleep('50 millis')
    assert.isTrue(existsSync(dir), `no checkout at ${sha}`)
    return dir
  })

describe('GitTools', () => {
  it.live('serves read-only git over MCP to a registered session', () =>
    Effect.gen(function* () {
      const { remote, layer, cacheRoot } = setup()
      const head = git(remote, 'rev-parse', 'feat')
      yield* Effect.gen(function* () {
        yield* (yield* Git).fetchPr(key, 7, 'master', head)
        const { url, headers } = (yield* (yield* GitTools).register(key)) as { url: string; headers: Array<{ name: string; value: string }> }
        const c = client(url, Object.fromEntries(headers.map((h) => [h.name, h.value])))
        yield* c.init
        const tools = yield* c.send('tools/list', {})
        assert.deepStrictEqual((tools.json.result.tools as Array<{ name: string }>).map((t) => t.name).sort(), ['diff', 'grep', 'list_files', 'log', 'show'])
        assert.strictEqual(yield* c.call('show', { ref: head, path: 'b.txt' }), '1\tnew')
        assert.strictEqual(yield* c.call('list_files', { ref: head }), 'a.txt\nb.txt')
        assert.match(yield* c.call('diff', { from: 'origin/master', to: head }), /\+two/)
        assert.match(yield* c.call('show', { ref: '--output=/tmp/x', path: 'a.txt' }), /Not a ref/)
        // The default branch checkout comes up in the background; until then and after, a grep answers at the ref asked.
        assert.strictEqual(yield* c.call('grep', { pattern: 'two|new', ref: head }), 'a.txt:1:two\nb.txt:1:new')
        yield* treeAt(cacheRoot, git(remote, 'rev-parse', 'master'))
        assert.strictEqual(yield* c.call('grep', { pattern: 'two|new', ref: head }), 'a.txt:1:two\nb.txt:1:new')
        assert.strictEqual(yield* c.call('grep', { pattern: 'one', ref: 'origin/master' }), 'a.txt:1:one')
        assert.strictEqual(yield* c.call('grep', { pattern: 'n', ref: head, glob: 'b.*' }), 'b.txt:1:new')
      }).pipe(Effect.scoped, Effect.provide(layer))
    }), 30_000)

  it.live('a grep at a ref that moved a file finds it only at its new path', () =>
    Effect.gen(function* () {
      const { remote, layer, cacheRoot } = setup()
      git(remote, 'checkout', '-qb', 'moved', 'master')
      git(remote, 'mv', 'a.txt', 'c.txt')
      git(remote, 'commit', '-qm', 'move')
      git(remote, 'update-ref', 'refs/pull/8/head', 'moved')
      git(remote, 'checkout', '-q', 'master')
      const head = git(remote, 'rev-parse', 'moved')
      yield* Effect.gen(function* () {
        yield* (yield* Git).fetchPr(key, 8, 'master', head)
        const { url, headers } = (yield* (yield* GitTools).register(key)) as { url: string; headers: Array<{ name: string; value: string }> }
        const c = client(url, Object.fromEntries(headers.map((h) => [h.name, h.value])))
        yield* c.init
        // The default branch checkout still has a.txt.
        assert.strictEqual(readFileSync(join(yield* treeAt(cacheRoot, git(remote, 'rev-parse', 'master')), 'a.txt'), 'utf8'), 'one\n')
        assert.strictEqual(yield* c.call('grep', { pattern: 'one', ref: head }), 'c.txt:1:one')
      }).pipe(Effect.scoped, Effect.provide(layer))
    }), 30_000)

  it.live('both halves of a grep read Perl regex and tracked files .gitignore names; a new default branch commit gets its own checkout', () =>
    Effect.gen(function* () {
      const { remote, layer, cacheRoot } = setup()
      writeFileSync(join(remote, '.gitignore'), 'gen.txt\n')
      writeFileSync(join(remote, 'gen.txt'), 'some one\n')
      git(remote, 'add', '-f', '.gitignore', 'gen.txt')
      git(remote, 'commit', '-qm', 'gen')
      const head = git(remote, 'rev-parse', 'feat')
      yield* Effect.gen(function* () {
        yield* (yield* Git).fetchPr(key, 7, 'master', head)
        const register = Effect.map(Effect.flatMap(GitTools, (t) => t.register(key)), (s) => s as { url: string; headers: Array<{ name: string; value: string }> })
        const { url, headers } = yield* register
        const c = client(url, Object.fromEntries(headers.map((h) => [h.name, h.value])))
        yield* c.init
        const first = yield* treeAt(cacheRoot, git(remote, 'rev-parse', 'master'))
        // From the checkout (rg) and from the ref (git grep): \b and \d mean the same in both.
        assert.strictEqual(yield* c.call('grep', { pattern: '\\bone\\b', ref: 'origin/master' }), 'a.txt:1:one\ngen.txt:1:some one')
        assert.strictEqual(yield* c.call('grep', { pattern: '\\bnew\\b|\\d', ref: head }), 'b.txt:1:new')

        writeFileSync(join(remote, 'a.txt'), 'three\n')
        git(remote, 'commit', '-qam', 'three')
        git(remote, 'update-ref', 'refs/pull/9/head', 'feat')
        yield* (yield* Git).fetchPr(key, 9, 'master', head)
        yield* register
        const second = yield* treeAt(cacheRoot, git(remote, 'rev-parse', 'master'))
        assert.notStrictEqual(second, first)
        // A grep that started on the earlier checkout can still read it.
        assert.isTrue(existsSync(join(first, 'a.txt')))
        assert.strictEqual(yield* c.call('grep', { pattern: 'three', ref: 'origin/master' }), 'a.txt:1:three')
      }).pipe(Effect.scoped, Effect.provide(layer))
    }), 30_000)

  it.live('refuses a request without a registered token', () =>
    Effect.gen(function* () {
      const { layer } = setup()
      yield* Effect.gen(function* () {
        const server = (yield* Effect.scoped((yield* GitTools).register(key))) as { url: string; headers: Array<{ name: string; value: string }> }
        // The session's scope closed, so its token is gone.
        const r = yield* client(server.url, Object.fromEntries(server.headers.map((h) => [h.name, h.value]))).send('tools/list', {})
        assert.strictEqual(r.status, 401)
      }).pipe(Effect.provide(layer))
    }))
})
