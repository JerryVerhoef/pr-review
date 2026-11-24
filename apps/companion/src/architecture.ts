import { type AgentArchitecture, type ArchEdge, type ArchitectureMap, type ArchNode, type Evidence, relationKey } from '@pr-review/domain'

/**
 * The agent's map with everything unchecked thrown out.
 * `exists` says whether a path is a file or directory at one of the mapped commits; `evidence[i]` is edge i's citation
 * after the check, undefined when its quote was not found.
 */
export function checkMap(
  answer: AgentArchitecture,
  o: { prs: ReadonlyArray<number>; exists: (path: string) => boolean; evidence: ReadonlyArray<Evidence | undefined> },
): Pick<ArchitectureMap, 'summary' | 'nodes' | 'edges' | 'dropped'> {
  // With one PR every change is that PR's; in a stack a change no PR owns can't be placed.
  const prsOf = (x: { status: string; prs: ReadonlyArray<number> }) => {
    if (x.status === 'untouched') return []
    const known = [...new Set(x.prs.filter((n) => o.prs.includes(n)))].sort((a, b) => o.prs.indexOf(a) - o.prs.indexOf(b))
    return known.length === 0 && o.prs.length === 1 ? [...o.prs] : known
  }

  const nodes = new Map<string, ArchNode>()
  for (const n of answer.nodes) {
    if (nodes.has(n.id)) continue
    const paths = n.paths.filter(o.exists)
    const prs = prsOf(n)
    if (n.kind !== 'external' && paths.length === 0) continue
    if (n.status !== 'untouched' && prs.length === 0) continue
    nodes.set(n.id, { ...n, paths, prs })
  }

  const touched = (id: string) => nodes.get(id)!.status !== 'untouched'
  const seen = new Set<string>()
  const edges: ArchEdge[] = []
  answer.edges.forEach((e, i) => {
    const evidence = o.evidence[i]
    // A method only means something on a request.
    const method = e.kind === 'http' || e.kind === 'xhr' ? e.method : null
    const key = relationKey({ ...e, method })
    if (!evidence || e.from === e.to || !nodes.has(e.from) || !nodes.has(e.to) || seen.has(key)) return
    const prs = prsOf(e)
    if (e.status !== 'untouched' && prs.length === 0) return
    // A relation nothing touched, between components nothing touched, says nothing about the change.
    if (e.status === 'untouched' && !touched(e.from) && !touched(e.to)) return
    seen.add(key)
    edges.push({ ...e, method, prs, evidence })
  })

  const connected = new Set(edges.flatMap((e) => [e.from, e.to]))
  const kept = [...nodes.values()].filter((n) => n.status !== 'untouched' || connected.has(n.id))
  return {
    summary: answer.summary,
    nodes: kept,
    edges,
    dropped: { nodes: answer.nodes.length - kept.length, edges: answer.edges.length - edges.length },
  }
}
