import type { StackOverview } from '@pr-review/domain'

const panels = [
  ['tables', 'Tables'],
  ['modules', 'Modules'],
  ['endpoints', 'Endpoints'],
  ['sharedLayers', 'Shared layers'],
] as const

/** "company_group: new entity…" splits into the thing and what changed; a line without a short lead-in stays whole. */
const split = (line: string) => {
  const at = line.indexOf(': ')
  return at > 0 && at <= 60 ? { name: line.slice(0, at), what: line.slice(at + 2) } : undefined
}

/** What the stack summary lists: tables, modules, endpoints and shared layers, each as the thing and what changed. */
export function OverviewLists({ overview }: { overview: StackOverview }) {
  return (
    <>
      {panels.map(([key, label]) =>
        overview[key].length === 0 ? null : (
          <section key={key} aria-label={label} className="mb-5">
            <h3 className="mb-1 text-sm text-dim">
              {label} <span className="tabular-nums">{overview[key].length}</span>
            </h3>
            <dl className="grid grid-cols-1 border-t border-border sm:grid-cols-[minmax(0,16rem)_1fr]">
              {overview[key].flatMap((v) => {
                const parts = split(v)
                return parts
                  ? [
                      <div key={v} className="contents">
                        <dt className="border-b border-border pt-2 font-mono text-sm break-words sm:py-2 sm:pr-4">{parts.name}</dt>
                        <dd className="border-b border-border pb-2 text-muted-foreground sm:py-2">{parts.what}</dd>
                      </div>,
                    ]
                  : []
              })}
            </dl>
            {overview[key]
              .filter((v) => !split(v))
              .map((v) => (
                <p key={v} className="border-b border-border py-2 text-muted-foreground">
                  {v}
                </p>
              ))}
          </section>
        ),
      )}
    </>
  )
}

export const hasLists = (o: StackOverview) => panels.some(([key]) => o[key].length > 0)
