import { Schema } from 'effect'
import { Evidence } from './opinion.ts'

const { Struct, String, Number, Array, Literals, NullOr, Record, optionalKey, TaggedStruct, Union } = Schema

export const ArchNodeKind = Literals(['module', 'table', 'endpoint', 'shared-layer', 'external', 'class'])
export type ArchNodeKind = typeof ArchNodeKind.Type

export const ArchStatus = Literals(['new', 'changed', 'removed', 'untouched'])
export type ArchStatus = typeof ArchStatus.Type

/** How one component reaches another: over the wire, in process, through an event or a queue, or into a store. */
export const ArchEdgeKind = Literals(['http', 'xhr', 'invoke', 'event', 'job', 'read', 'write', 'render', 'extends', 'depends'])
export type ArchEdgeKind = typeof ArchEdgeKind.Type

export const HttpMethod = Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
export type HttpMethod = typeof HttpMethod.Type

export const ArchNode = Struct({
  id: String.annotate({ description: 'short kebab-case slug, unique in this map' }),
  kind: ArchNodeKind.annotate({
    description: 'module: a module or feature area. table: a database table or entity. endpoint: an API endpoint or page. shared-layer: shared code many features use. external: another service. class: only when the class itself is the decision.',
  }),
  name: String.annotate({ description: 'the name the codebase uses, a few words at most' }),
  status: ArchStatus.annotate({ description: 'what the change does to it. untouched: not changed, shown because a changed component connects to it.' }),
  what: String.annotate({ description: 'one sentence: what it is and, unless untouched, what changed' }),
  paths: Array(String).annotate({ description: 'the files or directories it lives in; empty only for external' }),
  prs: Array(Number).annotate({ description: 'the PRs that add, change or remove it; empty when untouched' }),
})
export type ArchNode = typeof ArchNode.Type

const edgeFields = {
  from: String.annotate({ description: 'id of the component that calls, reads, writes, extends or depends' }),
  to: String.annotate({ description: 'id of the component it does that to' }),
  kind: ArchEdgeKind.annotate({
    description:
      'http: a server sends an HTTP request to another service. xhr: browser code requests an API endpoint. invoke: an in-process call. event: dispatches or listens to an event, observer or hook. job: a queued job, message or scheduled command. read / write: a table or store. render: a page or component renders a component or uses a hook. extends: inherits from or implements. depends: none of the others.',
  }),
  method: NullOr(HttpMethod).annotate({ description: 'the HTTP method, for http and xhr; null for every other kind' }),
  status: ArchStatus.annotate({ description: 'new, changed or removed by the change; untouched for a relation that was already there' }),
  prs: Array(Number).annotate({ description: 'the PRs that add, change or remove the relation; empty when untouched' }),
}

export const AgentArchEdge = Struct({
  ...edgeFields,
  evidence: Evidence.annotate({ description: 'the one line that shows the relation: ref head (or base for a removed one), path, line, exact quote' }),
})
export type AgentArchEdge = typeof AgentArchEdge.Type

export const ArchEdge = Struct({ ...edgeFields, evidence: Evidence })
export type ArchEdge = typeof ArchEdge.Type

/** What the mapping agent returns; the companion checks it into an ArchitectureMap. */
export const AgentArchitecture = Struct({
  summary: String.annotate({ description: 'three sentences at most: what the change does to the structure' }),
  nodes: Array(ArchNode),
  edges: Array(AgentArchEdge),
})
export type AgentArchitecture = typeof AgentArchitecture.Type

export const ArchitectureMap = Struct({
  /** PR number to the head it was mapped on, bottom of the stack first. */
  heads: Record(String, String),
  summary: String,
  nodes: Array(ArchNode),
  edges: Array(ArchEdge),
  /** What the agent returned and the checks threw out. */
  dropped: Struct({ nodes: Number, edges: Number }),
})
export type ArchitectureMap = typeof ArchitectureMap.Type

export const ArchitectureEvent = Union([
  TaggedStruct('Idle', {}),
  TaggedStruct('Running', { startedAt: String, step: optionalKey(String) }),
  TaggedStruct('Done', { map: ArchitectureMap }),
])
export type ArchitectureEvent = typeof ArchitectureEvent.Type

/** Whether `path` is one of `paths` or lies under one of them. */
export const underAny = (path: string, paths: ReadonlyArray<string>) =>
  paths.some((p) => {
    const dir = p.replace(/\/+$/, '')
    return dir !== '' && (path === dir || path.startsWith(`${dir}/`))
  })

const containers = new Set(['apps', 'packages', 'services', 'libs', 'modules'])

/** The part of the repo a path is in: `apps/claus/app/X.php` is in `claus`, `src/billing/Bill.ts` in `src`. A file at the root is in none. */
const areaOfPath = (path: string): string | undefined => {
  const segments = path.split('/').filter(Boolean)
  const inContainer = containers.has(segments[0] ?? '') && segments.length > 1
  if (inContainer) return segments[1]
  return segments.length > 1 || path.endsWith('/') ? segments[0] : undefined
}

/** Where a component lives: the part of the repo most of its paths are in, the first on a tie. */
export const areaOf = (paths: ReadonlyArray<string>): string | undefined => {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const a = areaOfPath(p)
    if (a !== undefined) counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

type Relation = { readonly from: string; readonly to: string; readonly kind: ArchEdgeKind; readonly method: HttpMethod | null }

const relationWords: Record<ArchEdgeKind, string> = {
  http: 'http',
  xhr: 'xhr',
  invoke: 'code invoke',
  event: 'event',
  job: 'job',
  read: 'db read',
  write: 'db write',
  render: 'renders',
  extends: 'extends',
  depends: 'depends on',
}

/** How a relation reads on the map: "http post", "xhr get", "code invoke", "event", "db write". */
export const relationLabel = (e: Pick<Relation, 'kind' | 'method'>) =>
  (e.kind === 'http' || e.kind === 'xhr') && e.method ? `${relationWords[e.kind]} ${e.method.toLowerCase()}` : relationWords[e.kind]

/** Names a relation in a map: two components can be tied in several ways, a GET and a POST among them. */
export const relationKey = (e: Relation) => `${e.from}>${e.to}:${e.kind}${e.method ? `:${e.method}` : ''}`
