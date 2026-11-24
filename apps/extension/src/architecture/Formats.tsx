import { type ArchEdge, type ArchitectureMap, type ArchNode, type ArchStatus, areaOf, relationLabel } from '@pr-review/domain'
import type { ReactNode } from 'react'
import { cn } from '../lib/utils.ts'
import { AreaIcon } from './AreaIcon.tsx'
import { kindLabel, type Picked, statusGlyph, statusLabel } from './Graph.tsx'
import { edgeKey } from './layout.ts'

/** The same map read another way than the drawing, with the same selection. */
type View = { map: ArchitectureMap; picked: Picked | undefined; onPick: (p: Picked) => void }

const statusText: Record<ArchStatus, string> = { new: 'text-ok', changed: 'text-warn', removed: 'text-destructive', untouched: 'text-dim' }
const statusEdge: Record<ArchStatus, string> = { new: 'border-ok/50', changed: 'border-warn/50', removed: 'border-destructive/50 border-dashed', untouched: 'border-border' }

/** A component as one line: what the change does to it, its name, what it is. */
function Chip({ node, picked, onPick, area, className }: { node: ArchNode; picked: Picked | undefined; onPick: (p: Picked) => void; area?: boolean; className?: string }) {
  const on = picked?.kind === 'node' && picked.id === node.id
  return (
    <button
      type="button"
      aria-pressed={on}
      title={node.what}
      onClick={() => onPick({ kind: 'node', id: node.id })}
      className={cn('inline-flex max-w-full items-baseline gap-1.5 rounded-md border bg-background px-2 py-1 text-left hover:bg-accent/60', statusEdge[node.status], on && 'bg-accent ring-1 ring-ring', className)}
    >
      {area && areaOf(node.paths) && <AreaIcon area={areaOf(node.paths)!} size={15} className="self-center" />}
      <span aria-hidden className={cn('shrink-0 font-mono', statusText[node.status])}>
        {statusGlyph[node.status]}
      </span>
      <span className={cn('min-w-0 truncate', node.status === 'removed' && 'line-through', node.status === 'untouched' && 'text-muted-foreground')}>{node.name}</span>
      <span className="shrink-0 text-xs text-dim">{kindLabel[node.kind]}</span>
      <span className="sr-only">, {statusLabel[node.status]}</span>
    </button>
  )
}

/** A relation as a line to press: the verb, then whatever the caller passes (the other end). */
function Verb({ edge, picked, onPick, children }: { edge: ArchEdge; picked: Picked | undefined; onPick: (p: Picked) => void; children?: ReactNode }) {
  const on = picked?.kind === 'edge' && picked.key === edgeKey(edge)
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onPick({ kind: 'edge', key: edgeKey(edge) })}
      className={cn('rounded px-1 text-xs hover:bg-accent/60 hover:underline', statusText[edge.status], edge.status === 'removed' && 'line-through', on && 'bg-accent')}
    >
      {relationLabel(edge)}
      {children}
    </button>
  )
}

/**
 * The map read as flows: from every component nothing on the map reaches (a page, an endpoint, a listener), down
 * through what it calls. A component already shown on the way down is named again without its own branch.
 */
export function Flows({ map, picked, onPick }: View) {
  const byId = new Map(map.nodes.map((n) => [n.id, n]))
  const out = Map.groupBy(map.edges, (e) => e.from)
  const reached = new Set(map.edges.map((e) => e.to))
  /** How much of the map a component leads to. */
  const reach = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return seen.size
    seen.add(id)
    for (const e of out.get(id) ?? []) reach(e.to, seen)
    return seen.size
  }
  // The longest flow first: it is drawn in full, and the shorter ones point back into it.
  const starts = map.nodes
    .filter((n) => !reached.has(n.id) && out.has(n.id))
    .map((n) => ({ n, size: reach(n.id) }))
    .sort((x, y) => y.size - x.size)
    .map((x) => x.n)
  const loose = map.nodes.filter((n) => !reached.has(n.id) && !out.has(n.id))
  const shown = new Set<string>()

  const branch = (node: ArchNode, via: ArchEdge | undefined, trail: ReadonlySet<string>): ReactNode => {
    const again = shown.has(node.id)
    shown.add(node.id)
    const next = again || trail.has(node.id) ? [] : (out.get(node.id) ?? [])
    return (
      <li key={via ? edgeKey(via) : node.id} className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-1 py-0.5">
          {via && <Verb edge={via} picked={picked} onPick={onPick} />}
          <Chip node={node} picked={picked} onPick={onPick} area />
          {again && (out.get(node.id)?.length ?? 0) > 0 && <span className="shrink-0 text-xs text-dim">shown above</span>}
        </span>
        {next.length > 0 && <ul className="ml-3 border-l border-border pl-3">{next.map((e) => branch(byId.get(e.to)!, e, new Set([...trail, node.id])))}</ul>}
      </li>
    )
  }

  // Every component on a cycle is reached by another, so nothing starts it: begin at the first not yet shown.
  const trees = starts.map((n) => branch(n, undefined, new Set()))
  for (const n of map.nodes) if (!shown.has(n.id) && out.has(n.id)) trees.push(branch(n, undefined, new Set()))

  return (
    <div>
      <ul aria-label="Flows" className="flex flex-col gap-3">
        {trees}
      </ul>
      {loose.length > 0 && (
        <p aria-label="Not connected" className="mt-4 flex flex-wrap items-baseline gap-1.5 border-t border-border pt-3 text-sm text-muted-foreground">
          Not connected to anything on the map
          {loose.map((n) => (
            <Chip key={n.id} node={n} picked={picked} onPick={onPick} area />
          ))}
        </p>
      )}
    </div>
  )
}
