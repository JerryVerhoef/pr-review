import { reviewUrlFor } from '../src/reviewUrl.ts'

const ext = 'chrome-extension://abc/'

test('any page of a PR maps to its review page', () => {
  for (const url of ['https://github.com/acme/core/pull/2926', 'https://github.com/acme/core/pull/2926/files', 'https://github.com/acme/core/pull/2926/changes#diff-abc'])
    expect(reviewUrlFor(url, ext)).toBe('chrome-extension://abc/review.html#/open/github.com/acme/core/2926')
})

test('non-PR pages map to nothing', () => {
  expect(reviewUrlFor('https://github.com/acme/core/pulls', ext)).toBeNull()
  expect(reviewUrlFor('https://github.com/acme/core', ext)).toBeNull()
})
