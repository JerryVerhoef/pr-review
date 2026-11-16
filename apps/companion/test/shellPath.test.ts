import { expect, test } from 'vitest'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { directCommand, shellPath } from '../src/shellPath.ts'
import { tmp } from './helpers.ts'

const fakeShell = (body: string) => {
  const path = join(tmp(), 'shell')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test("reads the PATH from the user's shell, past whatever its startup files print", async () => {
  // Like `bash -ilc <command>`: the rc files run (and may print), then the command.
  const shell = fakeShell('echo "welcome back"; shift; PATH=/home/u/.nvm/bin:/usr/bin exec /bin/sh -c "$1"')
  expect(await shellPath(shell)).toBe('/home/u/.nvm/bin:/usr/bin')
})

test('a shell that fails leaves the PATH as it was', async () => {
  expect(await shellPath(fakeShell('exit 1'))).toBeUndefined()
  expect(await shellPath('/no/such/shell')).toBeUndefined()
})

test('npx -y runs the package bin it resolves to, and anything else stays as it is', async () => {
  const root = tmp()
  const bin = join(root, 'cache', 'node_modules', '.bin')
  mkdirSync(join(root, 'cache', 'node_modules', '@acme', 'agent-acp'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(root, 'cache', 'node_modules', '@acme', 'agent-acp', 'package.json'), JSON.stringify({ bin: { 'agent-acp': 'dist/index.js' } }))
  mkdirSync(join(root, 'path'))
  // Like npx -c: the command runs with the package's .bin first on PATH.
  writeFileSync(join(root, 'path', 'npx'), `#!/bin/sh\necho "${bin}:$PATH"\n`)
  chmodSync(join(root, 'path', 'npx'), 0o755)
  const env = { ...process.env, PATH: `${join(root, 'path')}:${process.env.PATH}` }
  expect(await directCommand('npx -y @acme/agent-acp@1.2.3 --acp', env)).toBe(`'${join(bin, 'agent-acp')}' --acp`)
  expect(await directCommand('npx -y @acme/other@1.0.0', env)).toBe('npx -y @acme/other@1.0.0')
  expect(await directCommand('cursor-agent acp', env)).toBe('cursor-agent acp')
})
