/**
 * Test stand-in for LocaleRuntime. The published client bundle boots through
 * the host module loader, which jsdom does not provide.
 */
import type { Context } from '@deepseek-ai/cordis'

type Dict = Record<string, string>

export class LocaleRuntime {
  private readonly dicts = new Map<string, Map<string, Dict>>()
  private locale = 'en'

  constructor(_ctx: Context) {}

  register(ns: string, dicts: Record<string, Dict>): () => void
  register(ns: string, locale: string, dict: Dict): () => void
  register(ns: string, localeOrDicts: string | Record<string, Dict>, dict?: Dict): () => void {
    const entries = typeof localeOrDicts === 'string'
      ? [[localeOrDicts, dict ?? {}] as const]
      : Object.entries(localeOrDicts)
    let table = this.dicts.get(ns)
    if (table === undefined) {
      table = new Map()
      this.dicts.set(ns, table)
    }
    for (const [locale, value] of entries) table.set(locale, value)
    return () => {
      for (const [locale] of entries) table?.delete(locale)
    }
  }

  bind(ns: string): (key: string) => string {
    return (key: string) => this.dicts.get(ns)?.get(this.locale)?.[key] ?? key
  }

  setLocale(id: string): void {
    this.locale = id
  }
}
