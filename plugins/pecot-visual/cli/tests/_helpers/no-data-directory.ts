import { vi } from 'vitest'

/**
データ置き場を決められない環境にする。
クライアントの値、PLUGIN_DATA、XDG_DATA_HOME、HOME がいずれも無い状態。
呼び出し側の afterEach で `vi.unstubAllEnvs()` して戻す。
*/
export function stubNoDataDirectory(): void {
  vi.stubEnv('CLAUDE_PLUGIN_DATA', '')
  vi.stubEnv('PLUGIN_DATA', '')
  vi.stubEnv('XDG_DATA_HOME', '')
  vi.stubEnv('HOME', '')
}
