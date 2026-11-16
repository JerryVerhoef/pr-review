import type { LineRange } from '@pr-review/domain'
import { Effect, Option } from 'effect'
import type { Git } from './Git.ts'
import { sameChange } from './interdiff.ts'
import type { Store } from './Store.ts'

/** What carries from an earlier head of a PR to a later one: decisions whose files change the same way at both. */
type Head = { headSha: string; mergeBase?: string | undefined }

/** A patch per file, keyed by its path at the new side (the old side for a deleted file). */
export const patchesByPath = (patch: string) =>
  new Map(
    patch
      .split(/^(?=diff --git )/m)
      .filter((s) => s.startsWith('diff --git '))
      .map((s) => [/^\+\+\+ b\/(.+)$/m.exec(s)?.[1] ?? /^rename to (.+)$/m.exec(s)?.[1] ?? /^--- a\/(.+)$/m.exec(s)?.[1] ?? /^diff --git a\/(.+?) b\//.exec(s)?.[1] ?? '', s] as const),
  )

/**
 * The files among `paths` whose change differs between the heads, each head diffed from its own merge base, with each
 * file's patch at both. Without both merge bases, the files the heads differ in.
 */
export const changedBetween = (git: Git['Service'], repoKey: string, before: Head, after: Head, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (!before.mergeBase || !after.mergeBase) {
      const diff = yield* git.diff(repoKey, before.headSha, after.headSha, paths)
      return { changed: new Set(patchesByPath(diff).keys()), was: new Map<string, string>(), now: new Map<string, string>() }
    }
    const [was, now] = (yield* Effect.all([git.diff(repoKey, before.mergeBase, before.headSha, paths), git.diff(repoKey, after.mergeBase, after.headSha, paths)], { concurrency: 2 })).map(
      patchesByPath,
    ) as [Map<string, string>, Map<string, string>]
    const changed = new Set([...was.keys(), ...now.keys()].filter((p) => !was.has(p) || !now.has(p) || !sameChange(was.get(p)!, now.get(p)!)))
    return { changed, was, now }
  })

const samePaths = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((p) => b.includes(p))

/** The earlier decision a decision continues: the one with its id, else the one with its files. */
export const continues = <D extends { id: string }>(d: { id: string }, paths: ReadonlyArray<string>, earlier: ReadonlyArray<D>, pathsOf: (e: D) => ReadonlyArray<string>) =>
  earlier.find((e) => e.id === d.id || samePaths(pathsOf(e), paths))

/** Copies what the reviewer did with findings `ids` (posted, dismissed) from one head to another, once: a finding restored on the new head stays restored. */
export const carryFindingStates = (store: Store['Service'], from: string, to: string, ids: ReadonlySet<string>) =>
  Effect.gen(function* () {
    if (!ids.size || Option.isSome(yield* store.findings.get(to))) return
    const before = Option.getOrElse(yield* store.findings.get(from), () => ({}))
    yield* store.findings.set(to, Object.fromEntries(Object.entries(before).filter(([id]) => ids.has(id))))
  }).pipe(Effect.orDie)

const HUNK_START = /^@@ -\d+(?:,\d+)? \+(\d+)/gm

/** New-side `ranges` of a file at the earlier head, moved with their hunk to where the same change (`was` → `now`) sits at the later one. */
export const shiftRanges = (was: string, now: string, ranges: ReadonlyArray<LineRange>): ReadonlyArray<LineRange> => {
  const [a, b] = [was, now].map((p) => [...p.matchAll(HUNK_START)].map((m) => Number(m[1]))) as [number[], number[]]
  const at = (line: number) => {
    const i = Math.max(0, a.findLastIndex((s) => s <= line))
    return line + (b[i] ?? 0) - (a[i] ?? 0)
  }
  return ranges.map((r) => ({ start: at(r.start), end: at(r.end) }))
}
