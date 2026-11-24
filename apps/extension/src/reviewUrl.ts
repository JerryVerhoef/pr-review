import { prRefFor } from './prepare.ts'

/** The extension review page for any page of a PR, or null when the URL isn't one. */
export function reviewUrlFor(url: string, extBase: string): string | null {
  const ref = prRefFor(url)
  return ref && `${extBase}review.html#/open/${ref.host}/${ref.owner}/${ref.repo}/${ref.number}`
}
