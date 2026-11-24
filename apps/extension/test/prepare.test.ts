import { prepareDebounce, prepareOncePerLoad } from '../src/prepare.ts'

const ref = { host: 'github.com', owner: 'acme', repo: 'core', number: 2926 }

test('conversation page sends one prepare per PR', () => {
  const next = prepareOncePerLoad()
  expect(next('https://github.com/acme/core/pull/2926')).toEqual(ref)
  expect(next('https://github.com/acme/core/pull/2926/commits')).toBeNull()
  expect(next('https://github.com/acme/core/pull/2927')).toEqual({ ...ref, number: 2927 })
})

test('files page prepares too; non-PR pages do not', () => {
  const next = prepareOncePerLoad()
  expect(next('https://github.com/acme/core/pull/2926/changes#diff-a')).toEqual(ref)
  expect(next('https://github.com/acme/core/pulls')).toBeNull()
})

test('background lets a PR through once within 10 minutes', () => {
  let t = 0
  const allow = prepareDebounce(() => t)
  expect(allow(ref)).toBe(true)
  t = 9 * 60_000
  expect(allow(ref)).toBe(false)
  expect(allow({ ...ref, number: 1 })).toBe(true)
  t = 10 * 60_000
  expect(allow(ref)).toBe(true)
})
