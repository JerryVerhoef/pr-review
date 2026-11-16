import { type Command, parse, type Word } from 'unbash'

const SAFE_GIT = new Set(['show', 'grep', 'log', 'diff', 'ls-tree', 'cat-file'])
// Agents reach for `| head` constantly; refusing it costs a whole round trip.
const PAGER_ARGS = /^(?:|-\d+|-n ?\d+)$/

/**
 * A word's text as bash passes it, or undefined when bash would expand it (variables, commands, globs, braces) or it
 * has an escape outside quotes.
 */
const literal = (w: Word): string | undefined => {
  if (!w.parts) return w.text === w.value ? w.value : undefined
  let out = ''
  for (const p of w.parts) {
    if ((p.type === 'Literal' && p.text === p.value) || p.type === 'SingleQuoted') out += p.value
    else if (p.type === 'DoubleQuoted' && p.parts.every((c) => c.type === 'Literal')) out += p.parts.map((c) => c.value).join('')
    else return undefined
  }
  return out
}

/** A plain command's words, or undefined when it assigns, redirects or expands anything. */
const commandWords = (c: Command) => {
  if (c.prefix.length || !c.name) return undefined
  const out: string[] = []
  for (const w of [c.name, ...c.suffix]) {
    const text = w.type === 'Word' ? literal(w) : undefined
    if (text === undefined) return undefined
    out.push(text)
  }
  return out
}

/** The words of a single plain command, one trailing `| head`/`| tail` aside; undefined for any other shell. */
const words = (command: string): ReadonlyArray<string> | undefined => {
  // Bash reads a CR as part of a word; refused anyway, since no read needs one.
  if (/[\0-\x08\n-\x1f]/.test(command)) return undefined
  const script = parse(command)
  const node = script.commands.length === 1 && !script.errors?.length && !script.commands[0]!.background ? script.commands[0]!.command : undefined
  if (node?.type === 'Command') return commandWords(node)
  if (node?.type !== 'Pipeline' || node.prefixes.length || node.operators.join() !== '|') return undefined
  const [first, pager] = node.commands
  const tail = pager?.type === 'Command' ? commandWords(pager) : undefined
  if (first?.type !== 'Command' || !tail || !['head', 'tail'].includes(tail[0]!) || !PAGER_ARGS.test(tail.slice(1).join(' '))) return undefined
  return commandWords(first)
}

// Git accepts any unambiguous prefix of a long option, so `--outp` means `--output`.
const UNSAFE_LONG = ['output', 'open-files-in-pager', 'no-index', 'ext-diff', 'textconv']

const unsafeArg = (arg: string) => {
  if (arg.startsWith('--')) {
    const name = arg.slice(2).split('=')[0]!
    return name !== '' && UNSAFE_LONG.some((o) => o.startsWith(name))
  }
  return arg.startsWith('-') && arg.includes('O') // grep -O runs a pager command; bundles like -nO too
}

/** The agent reads the repo through read-only git and nothing else; PR content is untrusted. */
export const safeGitCommand = (raw: string) => {
  const w = words(raw.trim())
  return w !== undefined && w[0] === 'git' && SAFE_GIT.has(w[1] ?? '') && !w.slice(2).some(unsafeArg)
}

const NAME = '[\\w.-]+'
const FILE = '[\\w.\\/-]+'
// Default branch only (no ?ref=, trees at HEAD); search terms can't carry encoded or extra qualifiers.
const GH_PATHS = [
  new RegExp(`^repos/(${NAME}/${NAME})/contents/${FILE}$`),
  new RegExp(`^repos/(${NAME}/${NAME})/git/trees/HEAD(?:\\?recursive=1)?$`),
  new RegExp(`^search/code\\?q=[\\w.+-]+?\\+repo:(${NAME}/${NAME})$`),
]
const RAW = 'Accept: application/vnd.github.raw'

/** Read-only `gh api` GETs of files, trees and code search in the related repos (`host/owner/repo`) and nowhere else. */
export const safeGhCommand = (raw: string, related: ReadonlyArray<string>) => {
  const tokens = words(raw.trim())
  if (tokens?.[0] !== 'gh' || tokens[1] !== 'api') return false
  // Required: without it gh picks its own default host, which may not be the one checked here.
  let host: string | undefined
  let path: string | undefined
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--hostname' && i + 1 < tokens.length) host = tokens[++i]!
    else if (t === '-H' && tokens[i + 1] === RAW) i++
    else if (t.startsWith('-') || path !== undefined) return false
    else path = t
  }
  if (host === undefined || path === undefined || path.split(/[/?]/).includes('..')) return false
  const repo = GH_PATHS.map((r) => r.exec(path!)?.[1]).find(Boolean)
  return repo !== undefined && related.some((r) => r.toLowerCase() === `${host}/${repo}`.toLowerCase())
}
