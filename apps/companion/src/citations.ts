import { Effect } from 'effect'
import { lowerSeverity, type AgentFinding, type Evidence } from '@pr-review/domain'

const WINDOW = 2

const needleOf = (quote: string) => quote.trim().replace(/…$/, '').trim().slice(0, 60)

const locate = (e: Evidence, text: string): number | undefined => {
  const needle = needleOf(e.quote)
  if (!needle) return undefined
  const lines = text.split('\n')
  const hits = lines.flatMap((l, i) => (l.includes(needle) ? [i + 1] : []))
  return hits.find((n) => Math.abs(n - e.line) <= WINDOW) === undefined ? hits[0] : e.line
}

/** The citation with its line corrected when the quote is in the file it names; undefined when it is not. */
export const checkEvidence = (e: Evidence, read: (e: Evidence) => Effect.Effect<string | undefined>): Effect.Effect<Evidence | undefined> =>
  Effect.map(read(e), (text) => {
    const line = text === undefined ? undefined : locate(e, text)
    return line === undefined ? undefined : { ...e, line }
  })

export const checkFinding = (
  f: AgentFinding,
  read: (e: Evidence) => Effect.Effect<string | undefined>,
): Effect.Effect<AgentFinding & { verified: boolean }> =>
  Effect.gen(function* () {
    const kept: Evidence[] = []
    for (const e of f.evidence) {
      if (e.ref === 'docs') {
        kept.push(e)
        continue
      }
      const checked = yield* checkEvidence(e, read)
      if (checked) kept.push(checked)
    }
    const verified = kept.some((e) => e.ref !== 'docs')
    const unsupported = !verified && !kept.some((e) => e.ref === 'docs')
    const severity = unsupported && f.kind !== 'upstream' ? lowerSeverity(f.severity) : f.severity
    return { ...f, evidence: kept, severity, verified }
  })
