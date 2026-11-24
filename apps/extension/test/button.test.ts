import { injectButton } from '../src/button.ts'

test('adds one button after the Changes tab, styled like an unselected tab', () => {
  document.body.innerHTML = `<nav><a class="tabnav-tab" href="/acme/core/pull/7">Conversation</a><a class="tabnav-tab selected" href="/acme/core/pull/7/files">Files changed</a></nav>`
  const onOpen = vi.fn()
  injectButton(document, onOpen)
  injectButton(document, onOpen)
  const buttons = document.querySelectorAll('#pr-review-open')
  expect(buttons).toHaveLength(1)
  const button = buttons[0] as HTMLAnchorElement
  expect(button.previousElementSibling?.textContent).toBe('Files changed')
  expect(button.className.trim()).toBe('tabnav-tab')
  button.click()
  expect(onOpen).toHaveBeenCalledOnce()
})

test('in a list of tabs it gets its own item', () => {
  document.body.innerHTML = `<nav><ul><li class="t"><a href="/acme/core/pull/7/changes">Changes</a></li></ul></nav>`
  injectButton(document, () => {})
  expect(document.querySelectorAll('li')).toHaveLength(2)
  expect(document.querySelector('li:last-child #pr-review-open')).not.toBeNull()
})

test('waits while the tabs are not rendered yet', () => {
  document.body.innerHTML = `<a href="/acme/core/pull/7/files">not in a nav</a>`
  injectButton(document, () => {})
  expect(document.getElementById('pr-review-open')).toBeNull()
})
