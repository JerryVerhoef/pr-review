import { type ArchNode, type Decision, type DecisionStates, type Finding, underAny } from '@pr-review/domain'

/** What one PR's review knows: its decisions with their verdicts, and Claude's findings still standing. */
export type Source = {
  readonly pr: number
  readonly decisions: ReadonlyArray<Decision>
  readonly states: DecisionStates
  readonly findings: ReadonlyArray<Finding>
}

export type RelatedDecision = { readonly pr: number; readonly decision: Decision; readonly state: DecisionStates[string] | undefined }

/** The decisions that change a file of the component, and the findings on those decisions or anchored in its files. */
export function relatedTo(node: Pick<ArchNode, 'paths'>, sources: ReadonlyArray<Source>): { decisions: ReadonlyArray<RelatedDecision>; findings: ReadonlyArray<Finding> } {
  const decisions = sources.flatMap((s) =>
    s.decisions.filter((d) => d.files.some((f) => underAny(f.path, node.paths))).map((decision): RelatedDecision => ({ pr: s.pr, decision, state: s.states[decision.id] })),
  )
  const hit = new Set(decisions.map((d) => `${d.pr}:${d.decision.id}`))
  const findings = sources.flatMap((s) => s.findings.filter((f) => hit.has(`${f.pr}:${f.decisionId}`) || (f.anchor !== null && underAny(f.anchor.path, node.paths))))
  return { decisions, findings }
}

/** The decisions a reviewer reads for the structure, bottom of the stack first. */
export const architectureDecisions = (sources: ReadonlyArray<Source>): ReadonlyArray<RelatedDecision> =>
  sources.flatMap((s) => s.decisions.filter((d) => d.lens === 'architecture').map((decision): RelatedDecision => ({ pr: s.pr, decision, state: s.states[decision.id] })))
