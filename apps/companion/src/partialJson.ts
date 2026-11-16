/**
 * The complete elements so far of the array under `key` in the JSON object that `text` is the start of.
 * Rescans from the top on every call.
 */
// ponytail: O(n²) over a streamed answer; fine for the few KB a sort writes, keep the scan state if answers grow large
export const completeItems = (text: string, key: string): unknown[] => {
  const out: unknown[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let stringStart = 0
  let lastString = ''
  let expect = false
  let inArray = false
  let itemStart = -1
  for (let i = text.indexOf('{'); i >= 0 && i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        lastString = text.slice(stringStart, i)
      }
      continue
    }
    if (ch === '"') {
      inString = true
      stringStart = i + 1
    } else if (ch === ':') expect = depth === 1 && lastString === key
    else if (ch === '{' || ch === '[') {
      if (inArray && depth === 2) itemStart = i
      if (expect && ch === '[') inArray = true
      expect = false
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (inArray && depth === 2 && itemStart >= 0) {
        try {
          out.push(JSON.parse(text.slice(itemStart, i + 1)))
        } catch {}
        itemStart = -1
      }
      if (inArray && depth === 1) break
    }
  }
  return out
}
