import type { ArchEdge, ArchNode, Decision, Finding } from '@pr-review/domain'
import { fit, layout, pathOf } from '../src/architecture/layout.ts'
import { architectureDecisions, relatedTo, type Source } from '../src/architecture/related.ts'

const node = (id: string, o: Partial<ArchNode> = {}): ArchNode => ({ id, kind: 'module', name: id, status: 'changed', what: 'w', paths: [`src/${id}`], prs: [7], ...o })
const edge = (from: string, to: string, kind: ArchEdge['kind'] = 'invoke', method: ArchEdge['method'] = null): ArchEdge => ({ from, to, kind, method, status: 'new', prs: [7], evidence: { ref: 'head', path: 'a.ts', line: 1, quote: 'q' } })

describe('layout', () => {
  it('places callers left of what they call, without overlap', () => {
    const l = layout([node('api'), node('billing'), node('usage')], [edge('api', 'billing'), edge('billing', 'usage', 'write')])
    const at = (id: string) => l.nodes.find((n) => n.node.id === id)!
    expect(at('api').x + at('api').width).toBeLessThan(at('billing').x)
    expect(at('billing').x + at('billing').width).toBeLessThan(at('usage').x)
    expect(l.width).toBeGreaterThan(at('usage').x + at('usage').width - 1)
    expect(l.height).toBeGreaterThan(0)
    expect(l.edges.map((e) => e.key)).toEqual(['api>billing:invoke', 'billing>usage:write'])
    expect(l.edges.every((e) => e.points.length >= 2)).toBe(true)
  })

  it('keeps two relations between the same pair apart', () => {
    const l = layout([node('a'), node('b')], [edge('a', 'b', 'http', 'GET'), edge('a', 'b', 'http', 'POST')])
    expect(l.edges.map((e) => e.key)).toEqual(['a>b:http:GET', 'a>b:http:POST'])
    expect(pathOf(l.edges[0]!.points)).not.toBe(pathOf(l.edges[1]!.points))
  })

  it('leaves out an edge to a node that is not there, and handles an empty map', () => {
    expect(layout([node('a')], [edge('a', 'gone')]).edges).toEqual([])
    expect(layout([], [])).toMatchObject({ nodes: [], edges: [] })
  })

  it('widens a box for a long name up to a cut', () => {
    const l = layout([node('a'), node('b', { name: 'A very long component name that will not fit' })], [])
    expect(l.nodes[1]!.width).toBeGreaterThan(l.nodes[0]!.width)
    expect(fit('A very long component name that will not fit')).toBe('A very long component nam…')
  })

  it('draws a path through its points', () => {
    expect(pathOf([])).toBe('')
    expect(pathOf([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M0,0 L10,0')
    expect(pathOf([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }])).toBe('M0,0 Q5,5 10,0')
  })
})

const decision = (id: string, lens: Decision['lens'], path: string): Decision => ({ id, title: id, lens, reason: 'data-model', theme: 't', note: 'n', existing: null, authorWhy: null, files: [{ path, ranges: [] }] })
const finding = (id: string, pr: number, o: Partial<Finding> = {}): Finding => ({
  id, pr, decisionId: null, verified: true, severity: 'should', axis: 'standards', kind: 'design', title: id, take: 't', evidence: [], alternative: null, comment: null, anchor: null, handledIn: null, ...o,
})

describe('related', () => {
  const sources: Source[] = [
    { pr: 6, decisions: [decision('model', 'architecture', 'src/billing/Model.ts'), decision('fmt', 'quality', 'src/ui/fmt.ts')], states: { model: 'accepted' }, findings: [finding('on-model', 6, { decisionId: 'model' }), finding('elsewhere', 6, { decisionId: 'fmt' })] },
    { pr: 7, decisions: [decision('model', 'quality', 'src/billing-old/x.ts')], states: {}, findings: [finding('anchored', 7, { anchor: { path: 'src/billing/Bill.ts', line: 3 } })] },
  ]

  it('finds the decisions that change a file of the component, and their findings', () => {
    const r = relatedTo({ paths: ['src/billing/'] }, sources)
    expect(r.decisions.map((d) => [d.pr, d.decision.id, d.state])).toEqual([[6, 'model', 'accepted']])
    expect(r.findings.map((f) => f.id)).toEqual(['on-model', 'anchored'])
  })

  it('an external component has nothing related', () => {
    expect(relatedTo({ paths: [] }, sources)).toEqual({ decisions: [], findings: [] })
  })

  it('lists the architecture decisions bottom first', () => {
    expect(architectureDecisions(sources).map((d) => [d.pr, d.decision.id])).toEqual([[6, 'model']])
  })
})
