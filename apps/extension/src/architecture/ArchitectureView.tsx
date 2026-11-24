import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { type ArchEdge, type ArchitectureMap, type ArchNode, type ArchNodeKind, type ArchStatus, areaOf, type Finding, type PrRef, relationLabel, type StackOverview } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useState } from 'react'
import { useAtoms } from '../atoms.ts'
import { useRemembered } from '../remembered.ts'
import { cn } from '../lib/utils.ts'
import { failureOf } from '../result.ts'
import { SeverityPill } from '../review/Findings.tsx'
import { worstSeverity } from '../review/items.ts'
import { Button, Dot, Pill, Working } from '../ui/index.tsx'
import { AreaIcon } from './AreaIcon.tsx'
import { Flows } from './Formats.tsx'
import { areasOf, type ColorBy, Graph, kindLabel, Legend, type Picked, statusGlyph, statusLabel } from './Graph.tsx'
import { edgeKey } from './layout.ts'
import { hasLists, OverviewLists } from './OverviewLists.tsx'
import { architectureDecisions, type RelatedDecision, relatedTo, type Source } from './related.ts'

const kinds: ReadonlyArray<readonly [ArchNodeKind, string]> = [
  ['module', 'Modules'],
  ['table', 'Tables'],
  ['endpoint', 'Endpoints'],
  ['shared-layer', 'Shared layers'],
  ['external', 'External services'],
  ['class', 'Classes'],
]

const statusTone: Record<ArchStatus, string> = { new: 'border-ok/40 text-ok', changed: 'border-warn/40 text-warn', removed: 'border-destructive/40 text-destructive', untouched: '' }
const statusText: Record<ArchStatus, string> = { new: 'text-ok', changed: 'text-warn', removed: 'text-destructive', untouched: 'text-dim' }
/** Two readings of one map. */
const formats = [
  ['graph', 'Graph', 'Everything in one drawing, callers on the left.'],
  ['flows', 'Flows', 'From each entry point down through what it reaches.'],
] as const
type Format = (typeof formats)[number][0]

const pickKey = (p: Picked) => (p.kind === 'node' ? `n:${p.id}` : `e:${p.key}`)

/**
 * Only the architecture of a change: until it is mapped, the architecture decisions the sort found (and the stack
 * summary's lists); once mapped, the components, how they connect and what the change does to each.
 */
export function ArchitectureView(props: {
  prRef: PrRef
  /** Map the stack `prRef` is in, not the PR alone. */
  stack: boolean
  /** The heads in view; a push makes it a new map. */
  version: string
  /** One per PR, bottom of the stack first. */
  sources: ReadonlyArray<Source>
  overview?: StackOverview | null | undefined
  onOpenDecision: (pr: number, decisionId: string) => void
  onOpenPr?: ((pr: number) => void) | undefined
}) {
  const { architectureAtom } = useAtoms()
  const cached = useAtomValue(architectureAtom(props.prRef, props.stack, props.version, false))
  const [running, setRunning] = useState(false)
  const map = AsyncResult.isSuccess(cached) && cached.value._tag === 'Done' ? cached.value.map : undefined
  const known = AsyncResult.isSuccess(cached) || AsyncResult.isFailure(cached)
  const decisions = architectureDecisions(props.sources)
  const several = props.sources.length > 1

  return (
    <article className="mx-auto max-w-[72rem] px-5 py-4">
      <h2 className="mb-1 text-lg font-medium">Architecture</h2>
      {map ? (
        <Mapped map={map} sources={props.sources} onOpenDecision={props.onOpenDecision} onOpenPr={props.onOpenPr} />
      ) : (
        <>
          <p className="mb-3 max-w-[70ch] text-muted-foreground">
            What {props.stack ? 'this stack' : 'this PR'} does to the structure. The map draws the components it touches and how they connect; every relation cites the line that shows it.
          </p>
          <div className="mb-6 flex min-h-7 items-center gap-3">
            {running ? (
              <Mapping {...props} />
            ) : (
              known && (
                <Button size="sm" onClick={() => setRunning(true)}>
                  Map the architecture
                </Button>
              )
            )}
            {!running && known && <span className="text-sm text-dim">One agent run, on demand.</span>}
          </div>
        </>
      )}
      <Decisions decisions={decisions} sources={props.sources} several={several} onOpenDecision={props.onOpenDecision} />
      {!map && props.overview && hasLists(props.overview) && (
        <>
          <h3 className="mb-2 font-medium">What the stack changes</h3>
          <OverviewLists overview={props.overview} />
        </>
      )}
    </article>
  )
}

/** The run: what the agent is doing, or why it failed with a way to try again. */
function Mapping(props: { prRef: PrRef; stack: boolean; version: string }) {
  const atom = useAtoms().architectureAtom(props.prRef, props.stack, props.version, true)
  const result = useAtomValue(atom)
  const retry = useAtomRefresh(atom)
  if (AsyncResult.isFailure(result))
    return (
      <span className="flex items-center gap-2 text-destructive">
        The map failed: {String((failureOf(result) as { message?: string } | undefined)?.message ?? 'unknown error')}
        <Button size="xs" variant="outline" onClick={retry}>
          Try again
        </Button>
      </span>
    )
  const e = AsyncResult.isSuccess(result) ? result.value : undefined
  return e?._tag === 'Running' ? <Working step={`Mapping: ${e.step ?? 'starting'}`} startedAt={e.startedAt} /> : <Working step="Mapping" />
}

function Mapped(props: { map: ArchitectureMap; sources: ReadonlyArray<Source>; onOpenDecision: (pr: number, decisionId: string) => void; onOpenPr?: ((pr: number) => void) | undefined }) {
  const { map } = props
  const prs = Object.keys(map.heads).map(Number)
  const order = props.sources.map((s) => s.pr).filter((n) => prs.includes(n))
  const stacked = order.length > 1
  const areas = areasOf(map.nodes)
  // Only the ways that tell components apart: by PR in a stack, by where the code lives when it lives in several places.
  const ways: ReadonlyArray<readonly [ColorBy, string]> = [['status', 'Change'], ...(stacked ? [['pr', 'PR'] as const] : []), ...(areas.length > 1 ? [['area', 'Where'] as const] : [])]
  const [colorBy, setColorBy] = useState<ColorBy>('status')
  // The reading a reviewer prefers is theirs, not this PR's.
  const [stored, setFormat] = useRemembered<Format>('architecture:format', 'graph')
  const format = formats.some(([id]) => id === stored) ? stored : 'graph'
  const [picked, setPicked] = useState<Picked>()
  // Picking what is open closes it.
  const pick = (p: Picked) => setPicked((now) => (now && pickKey(now) === pickKey(p) ? undefined : p))
  const node = picked?.kind === 'node' ? map.nodes.find((n) => n.id === picked.id) : undefined
  const edge = picked?.kind === 'edge' ? map.edges.find((e) => edgeKey(e) === picked.key) : undefined
  const dropped = [map.dropped.nodes && `${map.dropped.nodes} ${map.dropped.nodes === 1 ? 'component' : 'components'}`, map.dropped.edges && `${map.dropped.edges} ${map.dropped.edges === 1 ? 'relation' : 'relations'}`].filter(Boolean)

  if (map.nodes.length === 0)
    return <p className="mb-6 text-muted-foreground">{map.summary || 'Claude found no change to the architecture.'}</p>

  return (
    <>
      <p className="mb-3 max-w-[70ch] leading-relaxed">{map.summary}</p>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border">
        <div role="tablist" aria-label="Format" className="flex gap-1">
          {formats.map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={format === id}
              title={hint}
              onClick={() => setFormat(id)}
              className={cn('-mb-px border-b-2 border-transparent px-2.5 py-1.5 text-muted-foreground hover:text-foreground', format === id && 'border-primary text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-dim">{formats.find(([id]) => id === format)![2]}</span>
      </div>
      {format === 'graph' && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Legend colorBy={colorBy} prs={order} areas={areas} />
          {ways.length > 1 && (
            <span role="group" aria-label="Colour by" className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              Colour by
              {ways.map(([by, label]) => (
                <button key={by} type="button" aria-pressed={colorBy === by} onClick={() => setColorBy(by)} className={cn('rounded-md px-1.5 py-0.5 hover:bg-accent/60', colorBy === by && 'bg-accent text-foreground')}>
                  {label}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      <div className="mb-2 flex items-start gap-3">
        <div role="tabpanel" aria-label={formats.find(([id]) => id === format)![1]} className="min-w-0 flex-1">
          {format === 'graph' && <Graph nodes={map.nodes} edges={map.edges} colorBy={colorBy} prs={order} picked={picked} onPick={pick} />}
          {format === 'flows' && <Flows map={map} picked={picked} onPick={pick} />}
        </div>
        {(node || edge) && (
          <aside aria-label="Details" className="sticky top-3 w-72 shrink-0 rounded-lg border border-border bg-card px-3 py-2.5">
            {node && <NodeDetail node={node} map={map} stacked={stacked} sources={props.sources} onOpenDecision={props.onOpenDecision} onOpenPr={props.onOpenPr} onPick={pick} />}
            {edge && <EdgeDetail edge={edge} map={map} stacked={stacked} onOpenPr={props.onOpenPr} />}
          </aside>
        )}
      </div>
      {dropped.length > 0 && (
        <p className="mb-2 text-xs text-dim">
          Left out: {dropped.join(' and ')} Claude named but could not show in the code.
        </p>
      )}
      {/* The index of components belongs to the drawing; the other formats are lists already. */}
      <div className={cn('mt-4 mb-6', format !== 'graph' && 'hidden')}>
        {kinds.map(([kind, label]) => {
          const rows = map.nodes.filter((n) => n.kind === kind)
          if (rows.length === 0) return null
          return (
            <section key={kind} aria-label={label} className="mb-4">
              <h3 className="mb-1 text-sm text-dim">
                {label} <span className="tabular-nums">{rows.length}</span>
              </h3>
              <ul className="border-t border-border">
                {rows.map((n) => (
                  <li key={n.id} className="border-b border-border">
                    <button
                      type="button"
                      aria-pressed={picked?.kind === 'node' && picked.id === n.id}
                      onClick={() => pick({ kind: 'node', id: n.id })}
                      className={cn('grid w-full grid-cols-[minmax(0,16rem)_5.5rem_5.5rem_1fr_auto] items-baseline gap-3 py-2 text-left hover:bg-accent/40', picked?.kind === 'node' && picked.id === n.id && 'bg-accent/60')}
                    >
                      <span className={cn('truncate font-mono text-sm', n.status === 'removed' && 'line-through')}>{n.name}</span>
                      <span className={cn('text-xs', statusText[n.status])}>
                        {statusGlyph[n.status]} {statusLabel[n.status]}
                      </span>
                      <span className="flex items-center gap-1.5 truncate text-xs text-dim">
                        {areaOf(n.paths) && <AreaIcon area={areaOf(n.paths)!} size={14} />}
                        {areaOf(n.paths) ?? ''}
                      </span>
                      <span className="text-muted-foreground">{n.what}</span>
                      {stacked && <span className="text-xs text-dim tabular-nums">{n.prs.map((p) => `#${p}`).join(' ')}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </>
  )
}

const PrLinks = ({ prs, onOpenPr }: { prs: ReadonlyArray<number>; onOpenPr?: ((pr: number) => void) | undefined }) => (
  <span className="flex flex-wrap gap-1">
    {prs.map((p) =>
      onOpenPr ? (
        <button key={p} type="button" onClick={() => onOpenPr(p)} className="text-sm text-primary tabular-nums hover:underline">
          #{p}
        </button>
      ) : (
        <span key={p} className="text-sm text-muted-foreground tabular-nums">
          #{p}
        </span>
      ),
    )}
  </span>
)

function NodeDetail(props: {
  node: ArchNode
  map: ArchitectureMap
  stacked: boolean
  sources: ReadonlyArray<Source>
  onOpenDecision: (pr: number, decisionId: string) => void
  onOpenPr?: ((pr: number) => void) | undefined
  onPick: (p: Picked) => void
}) {
  const { node, map } = props
  const related = relatedTo(node, props.sources)
  const name = (id: string) => map.nodes.find((n) => n.id === id)?.name ?? id
  const relations = map.edges.filter((e) => e.from === node.id || e.to === node.id)
  return (
    <>
      <h3 className={cn('font-medium break-words', node.status === 'removed' && 'line-through')}>{node.name}</h3>
      <p className="mt-1 mb-2 flex flex-wrap items-center gap-1.5">
        {areaOf(node.paths) && (
          <Pill className="text-foreground">
            <AreaIcon area={areaOf(node.paths)!} size={12} />
            {areaOf(node.paths)}
          </Pill>
        )}
        <Pill>{kindLabel[node.kind]}</Pill>
        <Pill className={statusTone[node.status]}>{statusLabel[node.status]}</Pill>
        {props.stacked && <PrLinks prs={node.prs} onOpenPr={props.onOpenPr} />}
      </p>
      <p className="text-muted-foreground">{node.what}</p>
      {node.paths.length > 0 && (
        <ul aria-label="Files" className="mt-2 flex flex-col gap-0.5">
          {node.paths.map((p) => (
            <li key={p} className="font-mono text-sm break-all text-muted-foreground">
              {p}
            </li>
          ))}
        </ul>
      )}
      {relations.length > 0 && (
        <ul aria-label="Relations" className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
          {relations.map((e) => (
            <li key={edgeKey(e)}>
              <button type="button" onClick={() => props.onPick({ kind: 'edge', key: edgeKey(e) })} className="text-left text-sm hover:underline">
                {e.from === node.id ? (
                  <>
                    <span className="text-dim">{relationLabel(e)}</span> {name(e.to)}
                  </>
                ) : (
                  <>
                    {name(e.from)} <span className="text-dim">{relationLabel(e)}</span> this
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {related.decisions.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <h4 className="mb-1 text-xs text-dim">Decisions in these files</h4>
          <ul aria-label="Related decisions" className="flex flex-col gap-0.5">
            {related.decisions.map((d) => (
              <li key={`${d.pr}:${d.decision.id}`}>
                <DecisionLink d={d} several={props.stacked} findings={related.findings} onOpen={props.onOpenDecision} compact />
              </li>
            ))}
          </ul>
        </div>
      )}
      {related.findings.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <h4 className="mb-1 text-xs text-dim">Claude's findings here</h4>
          <ul aria-label="Related findings" className="flex flex-col gap-1">
            {related.findings.map((f) => (
              <li key={`${f.pr}:${f.id}`}>
                <button type="button" onClick={() => (f.decisionId === null ? props.onOpenPr?.(f.pr) : props.onOpenDecision(f.pr, f.decisionId))} className="flex w-full flex-col items-start gap-0.5 text-left hover:underline">
                  <SeverityPill severity={f.severity} short />
                  <span className="text-sm">{f.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function EdgeDetail({ edge, map, stacked, onOpenPr }: { edge: ArchEdge; map: ArchitectureMap; stacked: boolean; onOpenPr?: ((pr: number) => void) | undefined }) {
  const name = (id: string) => map.nodes.find((n) => n.id === id)?.name ?? id
  const e = edge.evidence
  return (
    <>
      <h3 className="font-medium break-words">
        {name(edge.from)} <span className="font-normal text-muted-foreground">{relationLabel(edge)}</span> {name(edge.to)}
      </h3>
      <p className="mt-1 mb-2 flex flex-wrap items-center gap-1.5">
        <Pill className={statusTone[edge.status]}>{statusLabel[edge.status]}</Pill>
        {stacked && <PrLinks prs={edge.prs} onOpenPr={onOpenPr} />}
      </p>
      <p className="font-mono text-sm break-all text-muted-foreground">
        {e.path}:{e.line}
        {e.ref === 'base' && ' (before the change)'}
      </p>
      <pre aria-label="Cited line" className="mt-1 overflow-x-auto rounded-md bg-background px-2 py-1.5 font-mono text-sm">
        {e.quote}
      </pre>
    </>
  )
}

function DecisionLink(props: { d: RelatedDecision; several: boolean; findings: ReadonlyArray<Finding>; onOpen: (pr: number, id: string) => void; compact?: boolean }) {
  const { d } = props
  const worst = worstSeverity(props.findings.filter((f) => f.pr === d.pr && f.decisionId === d.decision.id))
  return (
    <button type="button" onClick={() => props.onOpen(d.pr, d.decision.id)} className={cn('flex w-full flex-col gap-0.5 rounded-md text-left', props.compact ? 'hover:underline' : 'px-3 py-2 hover:bg-accent/60')}>
      <span className="flex min-w-0 items-center gap-1.5">
        <Dot tone={d.state ?? 'open-arch'} />
        {props.several && <span className="text-dim tabular-nums">#{d.pr}</span>}
        <span className={cn('min-w-0 truncate', !props.compact && 'font-medium')}>{d.decision.title}</span>
        {worst && <SeverityPill severity={worst} short />}
      </span>
      {!props.compact && <span className="text-muted-foreground">{d.decision.note}</span>}
    </button>
  )
}

/** Free, from the sort: the decisions it filed under architecture, with the reviewer's verdict and Claude's worst finding. */
function Decisions(props: { decisions: ReadonlyArray<RelatedDecision>; sources: ReadonlyArray<Source>; several: boolean; onOpenDecision: (pr: number, decisionId: string) => void }) {
  const findings = props.sources.flatMap((s) => s.findings)
  return (
    <section aria-label="Architecture decisions" className="mb-6">
      <h3 className="mb-2 font-medium">
        Architecture decisions <span className="font-normal text-dim tabular-nums">{props.decisions.length}</span>
      </h3>
      {props.decisions.length === 0 ? (
        <p className="text-muted-foreground">The sort filed no decision under architecture.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {props.decisions.map((d) => (
            <li key={`${d.pr}:${d.decision.id}`}>
              <DecisionLink d={d} several={props.several} findings={findings} onOpen={props.onOpenDecision} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
