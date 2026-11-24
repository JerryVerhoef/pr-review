# Architecture tab

A view in the PR review and in the stack view that shows only what a change does to the architecture: which components exist, how they connect, what is new, changed or removed, and (in a stack) which PR does it.

## Decisions

| Question | Decision |
| --- | --- |
| Where | Both. A sidebar entry under "PR" in the single-PR review, and a nav entry next to "Overview" in the stack view. One component, one schema. |
| What is missing today | How parts connect, which PR does what, before vs after. |
| When it runs | On demand only: a "Map the architecture" button. Nothing is spent until it is pressed. |
| Stack run | One turn for the whole stack, like the stack opinion. Cached on the list of head SHAs. |
| Diagram | The agent returns a structured graph; the extension lays it out and draws SVG itself. No Mermaid. |
| Before vs after | One graph with status colors: new, changed, removed, untouched-but-connected. In a stack, a toggle recolors by PR. |
| Before mapping | The tab shows what is already free: architecture-lens decisions with verdicts and findings, and in the stack the overview lists. |
| Stack Overview | "What the stack changes" (tables, modules, endpoints, shared layers) moves out of Overview into this tab. Overview keeps the PR list, the summary and the findings. |
| Evidence | Every node lists paths, every edge carries one citation checked by the existing citation check. What fails is dropped. |
| Granularity | Modules or feature areas, tables/entities, endpoints or pages, shared layers, external services. A class only when it is itself the decision. Untouched nodes only when directly connected to a changed one. About 25 nodes at most; beyond that the agent groups. |
| Click | A detail panel: what the component is, what changed, its files, the cited line for an edge, links to the decisions and findings whose files overlap. |
| Effort | The agent's default reasoning effort (same class as Dig deeper), not low. |

Choices I made without asking, say so if you disagree:

- A single PR is mapped by the same service as a stack: the key is a list of heads, and a PR tab passes a list of one. One prompt, one cache store.
- Layout library: `@dagrejs/dagre`. Small, synchronous, good enough for 25 nodes. elk is better at ports and much larger.
- After a new push the map is gone (the key has a new head) and the tab is back at its baseline with the button. No "carried from an earlier push" in the first version.
- Links from a node to decisions are computed in the extension by path overlap, never asked of the agent.
- `[` and `]` in the stack view step Overview, Architecture, then the PRs.
- The map is not fed into PR or stack opinions yet.
- In a PR, `j` and `k` pass through the Architecture item, but a PR never opens on it: it opens on the description or its first decision as before.
- The item is there for every sorted PR, quick passes included.

## Schema (`packages/domain/src/architecture.ts`)

```ts
ArchNodeKind = 'module' | 'table' | 'endpoint' | 'shared-layer' | 'external' | 'class'
ArchStatus   = 'new' | 'changed' | 'removed' | 'untouched'
ArchEdgeKind = 'calls' | 'reads' | 'writes' | 'extends' | 'depends'

AgentArchNode = { id, kind, name, status, what, paths: string[], prs: number[] }
AgentArchEdge = { from, to, kind, status, prs: number[], evidence: Evidence }
AgentArchitecture = { summary, nodes: AgentArchNode[], edges: AgentArchEdge[] }

ArchitectureMap = {
  heads: Record<string, string>          // PR number -> head it was mapped on
  summary: string
  nodes: ArchNode[]
  edges: ArchEdge[]                      // evidence verified, line corrected
  dropped: { nodes: number; edges: number }
}

ArchitectureEvent = Idle | Running { startedAt, step? } | Done { map }
```

`Evidence` is the one from `opinion.ts`, with `pr` naming whose head or merge base it is. A removed edge cites `ref: base`.

RPC, next to `StackOpinion`:

```ts
Rpc.make('Architecture', {
  payload: { ref: PrRef, stack: Schema.Boolean, run: Schema.Boolean },
  success: ArchitectureEvent, error: …same as StackOpinion…, stream: true,
})
```

`stack: false` maps `ref` alone; `stack: true` maps the stack `ref` belongs to. `run: false` only reads the cache.

## Companion

- `prompts/architecture.md`: the role, the same bare-clone and untrusted-input rules as `stack-opinion.md`, the node and edge definitions, the granularity limits, the evidence rules. Input sections: Refs, Review guidance, PRs bottom first (`describePr`), Stack overview when cached.
- `src/Mapper.ts`: modelled on `StackOpiner`. `cached(ref, stack)`, `map(ref, stack)`, `steps(ref, stack)`. Key `ArchitectureKey { host, owner, repo, heads }` in `Store.ts`, store id `architecture`.
- Normalizing the answer (`src/architecture.ts`, pure, unit tested):
  - drop nodes with a duplicate id, an unknown PR number, or no path that exists at a head or merge base (an `external` node needs no path);
  - drop edges whose endpoints are gone, then check each edge's citation;
  - drop `untouched` nodes left without an edge to a changed node;
  - count what was dropped.
- `citations.ts`: pull the per-citation check out of `checkFinding` as `checkEvidence(e, read)` and use it from both.
- `Agent.ts`: a new `RunLog` kind `architecture`, not in `LOW_EFFORT`. `Perf.ts` and `PERFORMANCE.md` list the kind.
- `handlers.ts`: `Architecture` wired like `StackOpinion` (`progress` with the mapper's steps).

## Extension

- `src/architecture/layout.ts`: nodes and edges in, positions out (dagre). Pure, unit tested.
- `src/architecture/Graph.tsx`: SVG. Node shape by kind, color by status or by PR, removed drawn dashed and struck, a legend. Nodes and edges are buttons, so the graph works by keyboard.
- `src/architecture/related.ts`: decisions and findings whose files overlap a node's paths.
- `src/architecture/ArchitectureView.tsx`: baseline, button, running state, then graph, detail panel and a component table grouped by kind (the table is what the lists become once mapped).
- `atoms.ts`: `architectureAtom(ref, stack, run)`, as `stackOpinionAtom`.
- PR review: a new `Item` kind `architecture` (key `arch`) in the "PR" sidebar group, after the description. It has no verdict and does not count toward progress.
- Stack view: `Selection` gets `{ kind: 'architecture' }`, a nav button under Overview. `Overview.tsx` loses the `panels` block; the summary stays there.

## Slices

1. Domain and companion: schema, RPC, prompt, `Mapper`, normalizing, `checkEvidence`, handler. Tests: `architecture.test.ts` (normalizing), `Mapper.test.ts` (key, cache, prompt sections, dropped edges) with the existing fakes, schema round trip. Checked by hand with `probe-host.ts`.
2. PR tab: layout, graph, view, atom, sidebar item. Tests: `layout.test.ts`, `ReviewPage.test.tsx` (item present, baseline lists architecture decisions, button runs, graph and panel render, node links open the decision).
3. Stack tab: nav entry, by-PR coloring, lists moved out of Overview. Tests: `StackPage.test.tsx` updated for the move, stepping with `[` `]`, a node link opens the PR at the decision.

Each slice passes `pnpm test` and `pnpm typecheck` on its own. Work happens on a branch `feat/architecture-tab`; nothing is pushed.

## Not in this version

- Carrying a map across a push.
- A stepper that grows the graph PR by PR.
- Asking Claude about a node, or feeding the map to the opinions.
- Mapping automatically.

## Added after the first real map

- Where a component lives is derived from its paths in code (`areaOf`): the folder under `apps/`, `packages/`, `services/`, `libs/` or `modules/`, else the top folder. No agent run, so cached maps get it too. It shows as a badge on each box, in the table and the detail panel, and as a third way to colour the graph.
- Two formats as tabs over the same map and the same selection: Graph and Flows. Lanes and By PR were tried and removed. The chosen format is remembered across PRs.
- Relations say how one component reaches the other: `http` and `xhr` with a method, `invoke`, `event`, `job`, `read`, `write`, `render`, `extends`, and `depends` as the last resort. Maps are stored under `architecture-2`; maps in the first shape are left behind and need a new run.
- Where the code lives shows as a mark on a dark tile (`AreaIcon.tsx`): React for `web`, the Sollit mark for `core`, a key for `claus`, a spark for `ai-service`, two letters for anything else. The table from name to mark is hardcoded.
