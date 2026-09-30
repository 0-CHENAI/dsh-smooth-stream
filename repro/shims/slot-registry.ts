/**
 * Test stand-in for the browser SlotRegistry. The published runtime bundle
 * registers through `window.__ModuleLoader__` and cannot be imported under
 * Vitest; this covers the registration surface the plugin and its tests use.
 */
import { Context, Service } from '@deepseek-ai/cordis'

export interface SlotOptions {
  name?: string
  key?: string
  id?: string
  priority?: number
  order?: number
  locale?: string
  registrant?: string
  children?: Record<string, unknown>
  inject?: () => unknown
  [key: string]: unknown
}

export interface StoredEntry {
  options: SlotOptions
  component: unknown
  inject?: () => unknown
}

interface SlotRecord {
  entries: StoredEntry[]
}

export class SlotRegistry extends Service {
  static provide = 'slots'

  private readonly records = new Map<string, SlotRecord>()
  private readonly waits = new Map<string, Set<() => void>>()

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  register(options: SlotOptions, component?: unknown): () => void {
    const key = options.name ?? 'root'
    let record = this.records.get(key)
    if (record === undefined) {
      record = { entries: [] }
      this.records.set(key, record)
    }
    const entry: StoredEntry = { options, component, inject: options.inject }
    record.entries.push(entry)
    this.wake(key)
    // A children table declares those slots, which is what `inject` waits on.
    for (const child of Object.keys(options.children ?? {})) {
      if (!this.records.has(child)) this.records.set(child, { entries: [] })
      this.wake(child)
    }
    this.ctx.emit('slots/changed', key)
    let released = false
    return () => {
      if (released || record === undefined) return
      released = true
      record.entries = record.entries.filter(item => item !== entry)
      this.ctx.emit('slots/changed', key)
    }
  }

  private wake(key: string): void {
    const pending = this.waits.get(key)
    if (pending === undefined) return
    this.waits.delete(key)
    for (const resume of pending) resume()
  }

  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void {
    let disposers: Array<() => void> = []
    let installed = false
    const install = (): void => {
      if (installed) return
      installed = true
      const effect = callback()
      disposers = typeof effect === 'function' ? [effect] : [...effect]
    }
    if (this.records.has(key)) install()
    else {
      let pending = this.waits.get(key)
      if (pending === undefined) {
        pending = new Set()
        this.waits.set(key, pending)
      }
      pending.add(install)
    }
    return () => {
      this.waits.get(key)?.delete(install)
      for (const dispose of disposers.reverse()) dispose()
      disposers = []
      installed = false
    }
  }

  entries(key: string): readonly StoredEntry[] {
    return this.records.get(key)?.entries ?? []
  }
}
