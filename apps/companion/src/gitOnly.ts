const SAFE_GIT = new Set(['show', 'grep', 'log', 'diff', 'ls-tree', 'cat-file'])
// Outside quotes: anything that lets a shell run a second command, redirect, expand or escape.
const SHELL_META = /[;&|<>`$\\]/
// Agents reach for `| head` constantly; refusing it costs a whole round trip.
const PAGER = /^\s*(head|tail)(\s+-n\s*\d+|\s+-\d+)?\s*$/

/**
 * The words bash would pass, or undefined when the command is anything but words and quotes, one trailing
 * `| head`/`| tail` aside. Quoted text is literal (`"a\|b"`, `'$x'`, `"->x("`), except `$` and backquotes in double quotes.
 */
const words = (command: string): ReadonlyArray<string> | undefined => {
  if (/[\n\r]/.test(command)) return undefined
  const out: string[] = []
  // `started`: an empty quoted word ('') is still a word.
  let word = ''
  let started = false
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") {
      if (c === "'") quote = undefined
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === '$' || c === '`') return undefined
      else if (c === '\\' && '$`"\\'.includes(command[i + 1] ?? '')) word += command[++i]!
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === ' ' || c === '\t') {
      if (started) out.push(word)
      word = ''
      started = false
    } else if (c === '|' && PAGER.test(command.slice(i + 1))) break
    else if (SHELL_META.test(c)) return undefined
    else {
      word += c
      started = true
    }
  }
  if (quote) return undefined
  if (started) out.push(word)
  return out
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

export const gitOnlyMessage =
  'Only read-only git commands (show, grep, log, diff, ls-tree, cat-file) are allowed, optionally piped into head or tail; no other shell syntax, --output, --no-index or -O. Do not cd; you are already in the repo.'
