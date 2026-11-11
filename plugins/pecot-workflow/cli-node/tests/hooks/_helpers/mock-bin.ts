/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// モックコマンドの配置。conftest.py の mock_bin・pecot_bin_mock に当たる。
//
// 使い方は次のとおり。
// - mockBin(hookCase).install('gh', 'echo mocked') は、PATH の先頭の mock-bin にコマンドを置く。
//   同じケースでは同じ mock-bin を返す。
// - pecotBinMock(hookCase).install(pluginRoot) は、${CLAUDE_PLUGIN_ROOT}/bin/pecot の実体を置く。
//   PECOT_MOCK_EXIT と PECOT_MOCK_STDERR で振る舞いを変える。
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { HookCase } from './environment.js'

export interface MockBin {
  readonly binDirectory: string
  install(name: string, scriptBody: string): string
}

const mockBins = new WeakMap<HookCase, MockBin>()

export function mockBin(hookCase: HookCase): MockBin {
  const existing = mockBins.get(hookCase)
  if (existing) return existing
  const binDirectory = path.join(hookCase.temporaryPath, 'mock-bin')
  mkdirSync(binDirectory, { recursive: true })
  hookCase.setEnv('PATH', `${binDirectory}${path.delimiter}${hookCase.getEnv('PATH') ?? ''}`)
  const created: MockBin = {
    binDirectory,
    install(name, scriptBody) {
      const target = path.join(binDirectory, name)
      writeFileSync(target, scriptBody.startsWith('#!') ? scriptBody : `#!/bin/bash\n${scriptBody}`)
      chmodSync(target, 0o755)
      return target
    },
  }
  mockBins.set(hookCase, created)
  return created
}

// 呼び出しは marker への追記で判定する。最後の引数が既存ファイルなら、内容を <marker>.body に写す。
const PECOT_BIN_MOCK_BODY = [
  '#!/bin/bash',
  'echo "$@" >> "$PECOT_MOCK_MARKER"',
  'last_arg="${!#}"',
  'if [ "$#" -gt 0 ] && [ -f "$last_arg" ]; then',
  '    cp "$last_arg" "${PECOT_MOCK_MARKER}.body"',
  'fi',
  'if [ -n "${PECOT_MOCK_STDERR:-}" ]; then',
  '    echo "$PECOT_MOCK_STDERR" >&2',
  'else',
  '    echo "https://example.test/issue/comment/1"',
  'fi',
  'exit "${PECOT_MOCK_EXIT:-0}"',
  '',
].join('\n')

export interface PecotBinMock {
  readonly marker: string
  readonly body: string
  install(pluginRoot: string): string
}

// PECOT_MOCK_MARKER を tmp に向ける。
export function pecotBinMock(hookCase: HookCase): PecotBinMock {
  const marker = path.join(hookCase.temporaryPath, 'pecot-mock-marker')
  hookCase.setEnv('PECOT_MOCK_MARKER', marker)
  return {
    marker,
    body: `${marker}.body`,
    install(pluginRoot) {
      const binDirectory = path.join(pluginRoot, 'bin')
      mkdirSync(binDirectory, { recursive: true })
      const target = path.join(binDirectory, 'pecot')
      writeFileSync(target, PECOT_BIN_MOCK_BODY)
      chmodSync(target, 0o755)
      return marker
    },
  }
}
