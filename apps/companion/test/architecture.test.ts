import { describe, expect, it } from 'vitest'
import type { AgentArchEdge, AgentArchitecture, ArchNode, Evidence } from '@pr-review/domain'
import { checkMap } from '../src/architecture.ts'

const node = (id: string, o: Partial<ArchNode> = {}): ArchNode => ({ id, kind: 'module', name: id, status: 'changed', what: 'w', paths: [`src/${id}`], prs: [7], ...o })
const cite: Evidence = { ref: 'head', path: 'src/a/x.ts', line: 3, quote: 'call()' }
const edge = (from: string, to: string, o: Partial<AgentArchEdge> = {}): AgentArchEdge => ({ from, to, kind: 'invoke', method: null, status: 'new', prs: [7], evidence: cite, ...o })
const map = (nodes: ArchNode[], edges: AgentArchEdge[] = []): AgentArchitecture => ({ summary: 's', nodes, edges })
const check = (a: AgentArchitecture, o: { prs?: number[]; missing?: string[]; unverified?: number[] } = {}) =>
  checkMap(a, { prs: o.prs ?? [7], exists: (p) => !o.missing?.includes(p), evidence: a.edges.map((e, i) => (o.unverified?.includes(i) ? undefined : e.evidence)) })

describe('checkMap', () => {
  it('keeps a checked map as it is', () => {
    const a = map([node('a'), node('b', { status: 'new' })], [edge('a', 'b')])
    expect(check(a)).toEqual({ summary: 's', nodes: a.nodes, edges: a.edges, dropped: { nodes: 0, edges: 0 } })
  })

  it('drops a node whose paths do not exist, and the edges to it', () => {
    const r = check(map([node('a'), node('b')], [edge('a', 'b')]), { missing: ['src/b'] })
    expect(r.nodes.map((n) => n.id)).toEqual(['a'])
    expect(r.edges).toEqual([])
    expect(r.dropped).toEqual({ nodes: 1, edges: 1 })
  })

  it('keeps only the paths that exist, and an external node without any', () => {
    const r = check(map([node('a', { paths: ['src/a', 'src/gone'] }), node('stripe', { kind: 'external', paths: [] })], [edge('a', 'stripe')]), { missing: ['src/gone'] })
    expect(r.nodes.map((n) => n.paths)).toEqual([['src/a'], []])
  })

  it('drops an edge whose citation was not found', () => {
    const r = check(map([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]), { unverified: [0] })
    expect(r.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['b>a'])
    expect(r.dropped.edges).toBe(1)
  })

  it('drops repeated nodes, repeated edges and an edge to itself', () => {
    const r = check(map([node('a'), node('a', { name: 'again' }), node('b')], [edge('a', 'b'), edge('a', 'b'), edge('a', 'a'), edge('a', 'b', { kind: 'read' })]))
    expect(r.nodes.map((n) => n.name)).toEqual(['a', 'b'])
    expect(r.edges.map((e) => e.kind)).toEqual(['invoke', 'read'])
  })

  it('shows an untouched node only when a changed one connects to it', () => {
    const a = map(
      [node('a'), node('near', { status: 'untouched', prs: [7] }), node('far', { status: 'untouched' }), node('alone', { status: 'untouched' })],
      [edge('a', 'near', { status: 'untouched' }), edge('near', 'far', { status: 'untouched' })],
    )
    const r = check(a)
    expect(r.nodes.map((n) => n.id)).toEqual(['a', 'near'])
    expect(r.nodes[1]!.prs).toEqual([])
    expect(r.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['a>near'])
    expect(r.dropped).toEqual({ nodes: 2, edges: 1 })
  })

  it('in a stack, drops unknown PR numbers and a change no PR owns, and orders PRs bottom first', () => {
    const r = check(map([node('a', { prs: [8, 99, 6] }), node('b', { prs: [99] }), node('c', { prs: [] })], [edge('a', 'b', { prs: [6] })]), { prs: [6, 7, 8] })
    expect(r.nodes.map((n) => [n.id, n.prs])).toEqual([['a', [6, 8]]])
  })

  it('with one PR, a change without a PR number is that PR’s', () => {
    const r = check(map([node('a', { prs: [] }), node('b', { prs: [99] })], [edge('a', 'b', { prs: [] })]))
    expect(r.nodes.map((n) => n.prs)).toEqual([[7], [7]])
    expect(r.edges[0]!.prs).toEqual([7])
  })

  it('keeps a GET and a POST between the same pair apart, and a method only on a request', () => {
    const r = check(map([node('a'), node('b')], [edge('a', 'b', { kind: 'http', method: 'GET' }), edge('a', 'b', { kind: 'http', method: 'POST' }), edge('a', 'b', { kind: 'http', method: 'POST' }), edge('a', 'b', { kind: 'invoke', method: 'GET' })]))
    expect(r.edges.map((e) => [e.kind, e.method])).toEqual([['http', 'GET'], ['http', 'POST'], ['invoke', null]])
  })
})
