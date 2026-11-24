const ID = 'pr-review-open'
const CHANGES = /^\/[^/]+\/[^/]+\/pull\/\d+\/(files|changes)\/?$/

/**
 * Adds "Open in PR Reviewer" after the PR's Changes tab, styled like its neighbours.
 * GitHub re-renders the tabs on navigation, so this is called repeatedly and is a no-op while the button is there.
 */
export function injectButton(doc: Document, onOpen: () => void) {
  if (doc.getElementById(ID)) return
  const tab = [...doc.querySelectorAll<HTMLAnchorElement>('nav a[href]')].find((a) => CHANGES.test(new URL(a.href, doc.baseURI).pathname))
  if (!tab) return
  const button = doc.createElement('a')
  button.id = ID
  button.href = '#'
  button.className = tab.className.replace(/\bselected\b/, '')
  button.textContent = 'Open in PR Reviewer'
  button.addEventListener('click', (e) => {
    e.preventDefault()
    onOpen()
  })
  const li = tab.closest('li')
  if (!li) return void tab.after(button)
  const item = doc.createElement('li')
  item.className = li.className
  item.append(button)
  li.after(item)
}
