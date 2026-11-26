// resolvePluginRoot をテストの間だけ差し替える。テストの vi.mock の factory が pluginRootMock を返す。
import type * as PluginRoot from '../../src/infra/_shared/plugin-root.js'

const override: { value?: string } = {}

export async function pluginRootMock(importOriginal: () => Promise<typeof PluginRoot>): Promise<typeof PluginRoot> {
  const actual = await importOriginal()
  return { resolvePluginRoot: () => override.value ?? actual.resolvePluginRoot() }
}

export function stubPluginRoot(root: string): void {
  override.value = root
}

export function resetPluginRoot(): void {
  delete override.value
}
