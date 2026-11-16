import { exec, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const MARK = '__pr_review_env__'

/**
 * The PATH the user's terminal has. Browsers start the host with a bare one, where `npx` or `claude` is missing
 * or, under WSL, Windows' own. Asks the login shell for its environment, the way VS Code does.
 */
export async function shellPath(shell = process.env.SHELL || userInfo().shell || '/bin/sh'): Promise<string | undefined> {
  try {
    // `env` prints PATH colon-joined in every shell, fish included; the marks skip what the rc files print.
    const { stdout } = await promisify(execFile)(shell, ['-ilc', `echo ${MARK}; command env; echo ${MARK}`], { encoding: 'utf8', timeout: 15_000 })
    const env = stdout.split(MARK)[1] ?? ''
    return env.split('\n').find((l) => l.startsWith('PATH='))?.slice(5) || undefined
  } catch {
    return undefined
  }
}

let resolved: Promise<string | undefined> | undefined
/** shellPath, asked once per host: an interactive shell can take seconds to start. */
export const loginPath = () => (resolved ??= shellPath())

const NPX = /^npx\s+(?:-y|--yes)\s+(\S+)(.*)$/s

/**
 * `npx -y <package> …` with the package's own bin in its place. Plain npx spends about two seconds of every start
 * checking the package; `npx -c` only installs it when it is missing. Anything else, or a failure, is left as is.
 */
export async function directCommand(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const m = NPX.exec(command.trim())
  if (!m) return command
  const [, spec = '', rest = ''] = m
  const name = spec.replace(/(?<=.)@[^@/]*$/, '')
  const short = name.split('/').pop()!
  try {
    const { stdout } = await promisify(exec)(`npx -y -p ${spec} -c 'echo "$PATH"'`, { env, encoding: 'utf8', timeout: 120_000 })
    const binDir = stdout.trim().split(':')[0]!
    const pkg = JSON.parse(await readFile(join(binDir, '..', name, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
    const bins = Object.keys(typeof pkg.bin === 'string' ? { [short]: pkg.bin } : (pkg.bin ?? {}))
    // npx's own pick: the only bin, else the one named like the package.
    const bin = bins.length === 1 ? bins[0] : bins.includes(short) ? short : undefined
    return bin ? `'${join(binDir, bin)}'${rest}` : command
  } catch {
    return command
  }
}
