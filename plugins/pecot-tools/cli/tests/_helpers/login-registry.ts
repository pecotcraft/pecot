import { afterEach } from 'vitest'

import { createLoginRegistry, type LoginRegistry, type LoginRegistryOptions } from '../../src/infra/sso/login-registry.js'

/**
テスト内で作った login registry を `afterEach` でまとめて shutdown する関数。
`describe` / ファイルの直下で 1 度だけ呼び、テスト内では返した関数で registry を作る。
*/
export function useLoginRegistry(): (options?: Readonly<LoginRegistryOptions>) => LoginRegistry {
  const created: LoginRegistry[] = []
  afterEach(() => {
    for (const registry of created.splice(0).toReversed()) registry.shutdown()
  })
  return (options) => {
    const registry = createLoginRegistry(options)
    created.push(registry)
    return registry
  }
}
