import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import configs from '../tsdown.config.ts'

const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { name: string }
const client = configs.find(config => config.platform === 'browser')!
const output = client.outputOptions as { banner: string; intro: string; footer: string }

describe('client bundle registration', () => {
  it('registers under the manifest package name so graph arrival does not replay the bundle', () => {
    const factories = new Map<string, () => unknown>()
    const load = (registration: { id: string; factory: () => unknown }): void => {
      if (factories.has(registration.id)) throw new Error('duplicate factory registration')
      factories.set(registration.id, registration.factory)
    }
    const bundle = `${output.banner}\n${output.intro}\nmodule.exports = { apply() {} };\n${output.footer}`
    const arrive = (): void => {
      if (!factories.has(manifest.name)) {
        runInNewContext(bundle, { window: { __ModuleLoader__: { load } } })
      }
    }

    arrive()
    expect(factories.has(manifest.name)).toBe(true)
    expect(() => arrive()).not.toThrow()
    expect(factories.size).toBe(1)
    expect(factories.get(manifest.name)!()).toHaveProperty('apply')
  })
})
