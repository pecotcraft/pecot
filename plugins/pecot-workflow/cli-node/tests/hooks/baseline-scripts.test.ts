// hooks 配下のファイルを読むテストは、test-hooks だけが実行する（vitest の project hooks）。
// test-cli の入力に hooks/ を含めないため、cli 側のテストからは hooks/ を読まない。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { readBaseline } from '../parity/baseline.js'

const pluginRoot = path.resolve(import.meta.dirname, '../../..')

describe('baseline.json の hooks.scripts', () => {
  it('列挙したスクリプトがすべて実在する', () => {
    const missing = readBaseline().hooks.scripts.filter(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- plugin ルート配下の固定の相対パス
      script => !existsSync(path.join(pluginRoot, script)),
    )
    expect(missing).toEqual([])
  })
})
