/**
 * Node resolves CSS imports inside prebuilt Harness bundles before Vite can
 * transform them. Claim those loads here so Vitest can import the bundles.
 */
import { registerHooks } from 'node:module'

const EMPTY = 'export default new Proxy({}, { get: (_target, key) => String(key) })\n'

registerHooks({
  load(url, context, next) {
    if (String(url).endsWith('.css')) {
      return { format: 'module', shortCircuit: true, source: EMPTY }
    }
    return next(url, context)
  },
})
