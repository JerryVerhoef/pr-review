import type { PrRef } from '@pr-review/domain'

const PR = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(\/|$)/
export const PREPARE_EVERY_MS = 10 * 60_000

/** The PR a page belongs to, or null when it isn't a PR page. */
export function prRefFor(url: string): PrRef | null {
  const u = new URL(url)
  const m = PR.exec(u.pathname)
  if (!m) return null
  return { host: u.host, owner: m[1]!, repo: m[2]!, number: Number(m[3]) }
}

/** Lets a PR through once per `PREPARE_EVERY_MS`. */
export function prepareDebounce(now: () => number = Date.now) {
  const last = new Map<string, number>()
  return (ref: PrRef) => {
    const key = `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`
    const t = now()
    const prev = last.get(key)
    if (prev !== undefined && t - prev < PREPARE_EVERY_MS) return false
    last.set(key, t)
    return true
  }
}

/** Per page load: the PR to announce for a URL, once per PR. */
export function prepareOncePerLoad() {
  const sent = new Set<string>()
  return (url: string) => {
    const ref = prRefFor(url)
    const key = ref && `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`
    if (!ref || !key || sent.has(key)) return null
    sent.add(key)
    return ref
  }
}
