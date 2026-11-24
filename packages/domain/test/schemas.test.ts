import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { AgentSort, AskTarget, defaultSettings, opinionsMode, PrRef, repoSettings, ReviewEvent, ReviewRpcs, smallPrLines, Settings, SortEvent, SortResult, areaOf, relationKey, relationLabel, underAny } from '../src/index.ts'

const decision = {
  id: 'api-client',
  title: 'Planning API client patches the spec',
  lens: 'architecture',
  reason: 'departs',
  theme: 'API client',
  note: 'Core has no custom transforms.',
  existing: { path: 'packages/api-client-core/openapi-ts.config.ts', why: 'default setup' },
  authorWhy: null,
  files: [{ path: 'packages/api-client-planning/openapi-ts.config.ts', ranges: [{ start: 3, end: 36 }] }],
}

describe('domain schemas', () => {
  it('decodes a sort result from the agent JSON', () => {
    const decoded = Schema.decodeUnknownSync(AgentSort)({ decisions: [decision], skim: [], claims: [] })
    expect(decoded.decisions[0]?.lens).toBe('architecture')
  })

  it('rejects an unknown lens', () => {
    expect(() => Schema.decodeUnknownSync(AgentSort)({ decisions: [{ ...decision, lens: 'vibes' }], skim: [], claims: [] })).toThrow()
  })

  it('AskTarget decodes both tags', () => {
    const lines = Schema.decodeUnknownSync(AskTarget)({ _tag: 'Lines', path: 'a.ts', start: 1, end: 2, side: 'RIGHT', commit: 'h' })
    const dec = Schema.decodeUnknownSync(AskTarget)({ _tag: 'Decision', decision })
    expect([lines._tag, dec._tag]).toEqual(['Lines', 'Decision'])
  })

  it('PrRef round-trips through encode and decode', () => {
    const ref = { host: 'github.com', owner: 'acme', repo: 'core', number: 2926 }
    expect(Schema.decodeUnknownSync(PrRef)(Schema.encodeSync(PrRef)(ref))).toEqual(ref)
  })

  it('SortEvent is Running or Done', () => {
    expect(Schema.decodeUnknownSync(SortEvent)({ _tag: 'Running', startedAt: 'now' })._tag).toBe('Running')
  })

  it('ReviewRpcs lists its procedures', () => {
    expect([...ReviewRpcs.requests.keys()].sort()).toEqual(
      ['Architecture', 'Ask', 'Configure', 'DigDeeper', 'DraftRule', 'GetChats', 'GetDescription', 'GetDrafts', 'GetFilePatch', 'GetPr', 'GetSettings', 'Health', 'Opinion', 'PoolStatus', 'Prepare', 'Recall', 'Remember', 'Review', 'SetDrafts', 'SetFindingState', 'SetState', 'Sort', 'Stack', 'StackOpinion', 'SubmitReview'],
    )
  })
})

it('a cached SortResult without a summary still decodes', () => {
  const old = { headSha: 'h', decisions: [], skim: [], trusted: [], claims: [], unclaimedDecisionIds: [], lines: { decision: 0, skim: 0, trusted: 0 } }
  expect(Schema.decodeUnknownSync(SortResult)(old)).toEqual(old)
})

it('settings saved before phase 2 still decode', () => {
  const old = JSON.parse(JSON.stringify(defaultSettings))
  const s = Schema.decodeUnknownSync(Settings)(old)
  expect(s).toEqual(defaultSettings)
  expect(repoSettings(s, 'h/o/r')).toEqual({ related: [] })
})

it('settings without the 2b fields decode with automatic and 200', () => {
  const s = Schema.decodeUnknownSync(Settings)(JSON.parse(JSON.stringify(defaultSettings)))
  expect(opinionsMode(s)).toBe('automatic')
  expect(smallPrLines(s)).toBe(200)
})

it('ReviewEvent round-trips', () => {
  const preparing = { _tag: 'Preparing', phases: [{ id: 'sort', label: 'Sorting 42 files', state: 'running', workers: [{ account: 'claude', recent: ['a'] }] }] }
  const sort = { headSha: 'h', decisions: [], skim: [], trusted: [], claims: [], unclaimedDecisionIds: [], lines: { decision: 0, skim: 0, trusted: 0 }, quick: true }
  const done = { _tag: 'Done', sort, state: {}, opinion: null, opinionError: 'boom', findingStates: {} }
  for (const e of [preparing, done]) {
    const enc = Schema.encodeSync(ReviewEvent)(Schema.decodeUnknownSync(ReviewEvent)(e))
    expect(enc).toEqual(e)
  }
})

it('underAny matches a path and what lies under it, not a sibling with the same prefix', () => {
  expect(underAny('src/billing/Bill.ts', ['src/billing/'])).toBe(true)
  expect(underAny('src/billing', ['src/billing'])).toBe(true)
  expect(underAny('src/billing-old/Bill.ts', ['src/billing'])).toBe(false)
  expect(underAny('src/a.ts', [''])).toBe(false)
})

it('areaOf names the part of the repo a component lives in', () => {
  expect(areaOf(['apps/claus/app/Actions/X.php', 'apps/claus/app/Models/Y.php'])).toBe('claus')
  expect(areaOf(['packages/ui/src/button.tsx'])).toBe('ui')
  expect(areaOf(['src/billing/Bill.ts'])).toBe('src')
  expect(areaOf(['security/'])).toBe('security')
  // Most of its paths win; the first on a tie.
  expect(areaOf(['apps/core/a.php', 'apps/web/b.tsx', 'apps/web/c.tsx'])).toBe('web')
  expect(areaOf(['apps/core/a.php', 'apps/web/b.tsx'])).toBe('core')
  expect(areaOf(['README.md'])).toBeUndefined()
  expect(areaOf([])).toBeUndefined()
})

it('a relation reads as how it gets there, with the method on a request', () => {
  expect(relationLabel({ kind: 'http', method: 'POST' })).toBe('http post')
  expect(relationLabel({ kind: 'xhr', method: 'GET' })).toBe('xhr get')
  expect(relationLabel({ kind: 'xhr', method: null })).toBe('xhr')
  expect(relationLabel({ kind: 'invoke', method: null })).toBe('code invoke')
  expect(relationLabel({ kind: 'write', method: null })).toBe('db write')
  expect(relationKey({ from: 'a', to: 'b', kind: 'http', method: 'GET' })).not.toBe(relationKey({ from: 'a', to: 'b', kind: 'http', method: 'POST' }))
})
