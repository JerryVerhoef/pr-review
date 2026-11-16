import { expect, test } from 'vitest'
import { completeItems } from '../src/partialJson.ts'

test('yields each finished element of the array as the JSON streams in', () => {
  const full = 'Here it is:\n{"summary": "a {b} \\"c\\" [d]:", "decisions": [{"id": "d1", "files": [{"path": "a"}]}, {"id": "d2", "note": "x}]"}], "skim": [{"id": "s"}]}'
  const seen = [...full].map((_, i) => completeItems(full.slice(0, i + 1), 'decisions').length)
  expect(completeItems(full, 'decisions')).toEqual([{ id: 'd1', files: [{ path: 'a' }] }, { id: 'd2', note: 'x}]' }])
  expect(seen.indexOf(1)).toBe(full.indexOf('}]}') + 2)
  expect(seen.indexOf(2)).toBe(full.indexOf('"x}]"}') + 5)
  expect(completeItems('{"files": [{"id": 1}]}', 'decisions')).toEqual([])
  expect(completeItems('no json', 'decisions')).toEqual([])
})
