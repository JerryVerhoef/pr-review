import { injectButton } from '../src/button.ts'
import { prepareOncePerLoad } from '../src/prepare.ts'
import { reviewUrlFor } from '../src/reviewUrl.ts'

export default defineContentScript({
  // Other hosts from the settings are registered at runtime (src/hosts.ts).
  matches: ['https://github.com/*/*/pull/*'],
  runAt: 'document_start',
  main() {
    let seen = ''
    const nextPrepare = prepareOncePerLoad()
    const open = () => {
      const target = reviewUrlFor(location.href, browser.runtime.getURL('/'))
      if (target) void browser.runtime.sendMessage({ open: target })
    }
    const tick = () => {
      injectButton(document, open)
      if (location.href === seen) return
      seen = location.href
      const ref = nextPrepare(location.href)
      if (ref) void browser.runtime.sendMessage({ prepare: ref })
    }
    tick()
    // GitHub switches PR tabs client-side and its events vary by version, so watch the URL instead.
    // ponytail: 300 ms poll; the Navigation API replaces it once Firefox ships it everywhere
    setInterval(tick, 300)
  },
})
