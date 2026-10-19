import { afterEach, beforeEach, vi } from 'vitest'
import { FrameCoordinator } from '../src/client/FrameCoordinator.ts'

/**
 * Node.js 25+ declares a `localStorage` global that yields `undefined` unless
 * the process was started with `--localstorage-file`, and that accessor shadows
 * the jsdom Storage for these suites. Supply an in-memory Storage when the
 * environment did not provide a usable one; plain jsdom (Node 22/24) is left
 * untouched.
 */
function usableLocalStorage(): boolean {
  try {
    return typeof globalThis.localStorage?.getItem === 'function'
  } catch {
    return false
  }
}

if (!usableLocalStorage()) {
  const store = new Map<string, string>()
  const storage = {
    get length(): number { return store.size },
    clear(): void { store.clear() },
    getItem(key: string): string | null { return store.get(String(key)) ?? null },
    key(index: number): string | null { return [...store.keys()][index] ?? null },
    removeItem(key: string): void { store.delete(String(key)) },
    setItem(key: string, value: string): void { store.set(String(key), String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: false,
    get: () => storage,
  })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})
afterEach(() => {
  FrameCoordinator.forDocument(document).shutdown()
})
