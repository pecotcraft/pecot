/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// モックコマンドの配置。mockBin は同じケースなら同じ mock-bin を返し、pecotBinMock は bin/pecot の代役を置く。
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, accessSync, constants } from 'node:fs'
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

function isExecutable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

// PATH 上の実行ファイルを name だけ除いて symlink した bin ディレクトリを作り、そのパスを返す。
export function pathWithoutCommand(hookCase: HookCase, name: string): string {
  const binDirectory = path.join(hookCase.temporaryPath, `bin-no-${name}`)
  mkdirSync(binDirectory)
  const entries = (hookCase.getEnv('PATH') ?? '').split(path.delimiter)
  for (const entry of entries) {
    if (!existsSync(entry)) continue
    for (const file of readdirSync(entry)) {
      const target = path.join(entry, file)
      if (file !== name && isExecutable(target) && !existsSync(path.join(binDirectory, file))) symlinkSync(target, path.join(binDirectory, file))
    }
  }
  return binDirectory
}
