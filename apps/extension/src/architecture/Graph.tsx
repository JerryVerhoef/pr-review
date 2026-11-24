import { type ArchEdge, type ArchNode, type ArchNodeKind, type ArchStatus, areaOf, relationLabel } from '@pr-review/domain'
import { type KeyboardEvent, useId, useMemo } from 'react'
import { cn } from '../lib/utils.ts'
import { AreaIcon, AreaMark } from './AreaIcon.tsx'
import { fit, layout, MARK, pathOf } from './layout.ts'

export type Picked = { readonly kind: 'node'; readonly id: string } | { readonly kind: 'edge'; readonly key: string }
export type ColorBy = 'status' | 'pr' | 'area'

export const kindLabel: Record<ArchNodeKind, string> = { module: 'module', table: 'table', endpoint: 'endpoint', 'shared-layer': 'shared layer', external: 'external', class: 'class' }
export const statusLabel: Record<ArchStatus, string> = { new: 'new', changed: 'changed', removed: 'removed', untouched: 'untouched' }
/** Read without colour: what the change does to the component. */
export const statusGlyph: Record<ArchStatus, string> = { new: '+', changed: '~', removed: '−', untouched: '·' }

const statusColor: Record<ArchStatus, string> = { new: 'var(--color-ok)', changed: 'var(--color-warn)', removed: 'var(--color-destructive)', untouched: 'var(--color-dim)' }
const prColors = ['#5e6ad2', '#2ab7a9', '#f2994a', '#bb6bd9', '#4ea7fc', '#c9a227', '#eb5757', '#4cb782']

/** The colour a PR keeps across the graph and its legend, by its place in the stack. */
export const prColor = (pr: number, order: ReadonlyArray<number>) => prColors[Math.max(0, order.indexOf(pr)) % prColors.length]!

/** The parts of the repo the components live in, in the order the map first names them. */
export const areasOf = (nodes: ReadonlyArray<ArchNode>) => [...new Set(nodes.flatMap((n) => areaOf(n.paths) ?? []))]

/** The colour a part of the repo keeps across the graph and its legend. */
export const areaColor = (area: string, areas: ReadonlyArray<string>) => prColors[Math.max(0, areas.indexOf(area)) % prColors.length]!

/** `area` is where the component lives; for a relation, where its caller does. */
export const colorOf = (x: { status: ArchStatus; prs: ReadonlyArray<number> }, by: ColorBy, order: ReadonlyArray<number>, area?: string, areas: ReadonlyArray<string> = []) =>
  by === 'area'
    ? area === undefined
      ? statusColor.untouched
      : areaColor(area, areas)
    : by === 'pr' && x.status !== 'untouched' && x.prs[0] !== undefined
      ? prColor(x.prs[0], order)
      : statusColor[x.status]

/** A box's corners say what it is: a pill for an endpoint, square for a table, in between for the rest. */
const radius = (kind: ArchNodeKind, height: number) => (kind === 'endpoint' ? height / 2 : kind === 'table' ? 1 : 7)

const onKey = (act: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  act()
}

/** The map as a drawing: callers left, what they call right. Every box and line is a button. */
export function Graph(props: {
  nodes: ReadonlyArray<ArchNode>
  edges: ReadonlyArray<ArchEdge>
  colorBy: ColorBy
  /** The mapped PRs, bottom first. More than one shows which PR touches each box. */
  prs: ReadonlyArray<number>
  picked: Picked | undefined
  onPick: (p: Picked) => void
}) {
  const l = useMemo(() => layout(props.nodes, props.edges), [props.nodes, props.edges])
  const uid = useId().replace(/\W/g, '')
  const names = new Map(props.nodes.map((n) => [n.id, n.name]))
  const areas = areasOf(props.nodes)
  const area = new Map(props.nodes.map((n) => [n.id, areaOf(n.paths)]))
  const edgeColor = (e: ArchEdge) => colorOf(e, props.colorBy, props.prs, area.get(e.from), areas)
  const colors = [...new Set(l.edges.map((e) => edgeColor(e.edge)))]
  const stacked = props.prs.length > 1
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
      <svg role="group" aria-label="Architecture map" width={l.width} height={l.height} viewBox={`0 0 ${l.width} ${l.height}`} className="block">
        <defs>
          {colors.map((c, i) => (
            <marker key={c} id={`${uid}-${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={c} />
            </marker>
          ))}
        </defs>
        {l.edges.map(({ edge, key, points }) => {
          const color = edgeColor(edge)
          const on = props.picked?.kind === 'edge' && props.picked.key === key
          const mid = points[Math.floor(points.length / 2)]
          const pick = () => props.onPick({ kind: 'edge', key })
          return (
            <g
              key={key}
              role="button"
              tabIndex={0}
              aria-pressed={on}
              aria-label={`${names.get(edge.from)} ${relationLabel(edge)} ${names.get(edge.to)}, ${statusLabel[edge.status]}`}
              onClick={pick}
              onKeyDown={onKey(pick)}
              className="cursor-pointer outline-none [&:focus-visible>path:last-of-type]:stroke-[3px]"
            >
              <path d={pathOf(points)} fill="none" stroke="transparent" strokeWidth={14} />
              <path
                d={pathOf(points)}
                fill="none"
                stroke={color}
                strokeWidth={on ? 2.5 : 1.25}
                strokeOpacity={edge.status === 'untouched' && !on ? 0.6 : 1}
                strokeDasharray={edge.status === 'removed' ? '5 4' : undefined}
                markerEnd={`url(#${uid}-${colors.indexOf(color)})`}
              />
              {mid && (
                <text x={mid.x} y={mid.y + 3} textAnchor="middle" className={cn('fill-muted-foreground text-[10px]', on && 'fill-foreground')} style={{ paintOrder: 'stroke', stroke: 'var(--color-background)', strokeWidth: 4, strokeLinejoin: 'round' }}>
                  {relationLabel(edge)}
                </text>
              )}
            </g>
          )
        })}
        {l.nodes.map(({ node, x, y, width, height }) => {
          const where = area.get(node.id)
          const color = colorOf(node, props.colorBy, props.prs, where, areas)
          const on = props.picked?.kind === 'node' && props.picked.id === node.id
          const quiet = node.status === 'untouched'
          const pick = () => props.onPick({ kind: 'node', id: node.id })
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-pressed={on}
              aria-label={`${node.name}, ${kindLabel[node.kind]}${where ? ` in ${where}` : ''}, ${statusLabel[node.status]}`}
              transform={`translate(${x},${y})`}
              onClick={pick}
              onKeyDown={onKey(pick)}
              className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[3px]"
            >
              <title>{node.what}</title>
              <rect width={width} height={height} rx={radius(node.kind, height)} fill="var(--color-background)" />
              <rect
                width={width}
                height={height}
                rx={radius(node.kind, height)}
                fill={color}
                fillOpacity={quiet ? 0 : 0.1}
                stroke={color}
                strokeOpacity={quiet ? 0.7 : 1}
                strokeWidth={on ? 2.5 : 1.5}
                strokeDasharray={node.status === 'removed' ? '5 4' : undefined}
              />
              <text x={14 + MARK} y={18} className="fill-muted-foreground text-[10px]">
                {statusGlyph[node.status]} {kindLabel[node.kind]}
              </text>
              {stacked && node.prs[0] !== undefined && (
                <text x={width - 14} y={18} textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                  #{node.prs[0]}
                  {node.prs.length > 1 ? ` +${node.prs.length - 1}` : ''}
                </text>
              )}
              <text x={14 + MARK} y={35} className={cn('text-[12px] font-medium', quiet ? 'fill-muted-foreground' : 'fill-foreground')} textDecoration={node.status === 'removed' ? 'line-through' : undefined}>
                {fit(node.name)}
              </text>
              {where && (
                <svg x={10} y={(height - 18) / 2} width={18} height={18} viewBox="0 0 18 18">
                  <AreaMark area={where} />
                </svg>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** What the colours mean, beside the graph. */
export function Legend({ colorBy, prs, areas }: { colorBy: ColorBy; prs: ReadonlyArray<number>; areas: ReadonlyArray<string> }) {
  const swatch = (color: string, label: string, dashed = false) => (
    <span key={label} className="flex items-center gap-1.5">
      <i aria-hidden className="block size-2.5 rounded-sm border-[1.5px]" style={{ borderColor: color, borderStyle: dashed ? 'dashed' : 'solid' }} />
      {label}
    </span>
  )
  return (
    <p aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {colorBy === 'area'
        ? areas.map((a) => (
            <span key={a} className="flex items-center gap-1.5">
              <AreaIcon area={a} size={14} />
              <i aria-hidden className="block size-2.5 rounded-sm border-[1.5px]" style={{ borderColor: areaColor(a, areas) }} />
              {a}
            </span>
          ))
        : colorBy === 'pr'
        ? [...prs.map((n) => swatch(prColor(n, prs), `#${n}`)), swatch(statusColor.untouched, 'untouched')]
        : (['new', 'changed', 'removed', 'untouched'] as const).map((s) => swatch(statusColor[s], `${statusGlyph[s]} ${statusLabel[s]}`, s === 'removed'))}
    </p>
  )
}
