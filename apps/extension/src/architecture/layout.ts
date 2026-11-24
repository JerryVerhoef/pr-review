import { Graph, layout as dagre } from '@dagrejs/dagre'
import { type ArchEdge, type ArchNode, relationKey, relationLabel } from '@pr-review/domain'

export type Placed = { readonly node: ArchNode; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export type Routed = { readonly edge: ArchEdge; readonly key: string; readonly points: ReadonlyArray<{ x: number; y: number }> }
export type Layout = { readonly width: number; readonly height: number; readonly nodes: ReadonlyArray<Placed>; readonly edges: ReadonlyArray<Routed> }

const HEIGHT = 46
const CHAR = 7.2

export const edgeKey = relationKey

/** Room on the left of a box for the mark of where its code lives. */
export const MARK = 24

/** A name too long for its box, cut with an ellipsis. */
export const fit = (name: string, max = 26) => (name.length > max ? `${name.slice(0, max - 1)}…` : name)

/** Left to right, callers before what they call. `x` and `y` are a node's top left corner. */
export function layout(nodes: ReadonlyArray<ArchNode>, edges: ReadonlyArray<ArchEdge>): Layout {
  const g = new Graph({ multigraph: true })
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 64, marginx: 12, marginy: 12 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: Math.max(150, Math.round(fit(n.name).length * CHAR) + 28 + MARK), height: HEIGHT })
  const known = new Set(nodes.map((n) => n.id))
  const drawn = edges.filter((e) => known.has(e.from) && known.has(e.to))
  // The label's box keeps room on the line for the relation's name.
  for (const e of drawn) g.setEdge(e.from, e.to, { width: relationLabel(e).length * 5.6 + 8, height: 14, labelpos: 'c' }, edgeKey(e))
  dagre(g)
  const size = g.graph()
  return {
    width: Math.ceil(size.width ?? 0),
    height: Math.ceil(size.height ?? 0),
    nodes: nodes.map((node) => {
      const p = g.node(node.id)
      return { node, x: p.x - p.width / 2, y: p.y - p.height / 2, width: p.width, height: p.height }
    }),
    edges: drawn.map((edge) => ({ edge, key: edgeKey(edge), points: g.edge({ v: edge.from, w: edge.to, name: edgeKey(edge) }).points ?? [] })),
  }
}

/** A smooth line through dagre's points. */
export const pathOf = (points: ReadonlyArray<{ x: number; y: number }>) => {
  const [first, ...rest] = points
  if (!first) return ''
  if (rest.length < 2) return `M${first.x},${first.y}${rest.map((p) => ` L${p.x},${p.y}`).join('')}`
  let d = `M${first.x},${first.y}`
  for (let i = 0; i < rest.length - 1; i++) {
    const p = rest[i]!
    const next = rest[i + 1]!
    const last = i === rest.length - 2
    d += ` Q${p.x},${p.y} ${last ? next.x : (p.x + next.x) / 2},${last ? next.y : (p.y + next.y) / 2}`
  }
  return d
}
