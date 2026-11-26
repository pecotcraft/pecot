import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { attachOutput } from '../../../../../libs/interface-spec/src/vitest/attach.js'
import { checkNodeRuntime, MINIMUM_NODE_VERSIONS, nodeRuntimeGuidance, suggestedNodeVersion } from '../node-runtime.js'
import { explains } from '../../tests/_helpers/explains.js'

function readRelative(relativePath: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- import.meta.url 相対で組んだパス
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

// 表から engines.node の範囲指定を組み立てる（最後の major だけ >=、他は ^）。
function expectedEngines(): string {
  const minimums = Object.values(MINIMUM_NODE_VERSIONS)
  return minimums
    .map((minimum, index) => (index === minimums.length - 1 ? `>=${minimum}` : `^${minimum}`))
    .join(' || ')
}

describe('checkNodeRuntime', () => {
  it.each(['24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.13.0', '27.0.0', 'v24.22.1', '26.12.2-rc.1', '27.0.0-rc.1'])(
    'Node.js の版 %s では、起動を許可する',
    async (version) => {
      await explains('実行する Node.js の版を確認する `checkNodeRuntime` のテストです。`24.22.1` 以上の `24.x` など、修正を含む版を渡した場合は、`nodeRuntimeGuidance` も含めて `undefined` を返すことを確認します。')
      expect(checkNodeRuntime(version)).toBeUndefined()
      expect(nodeRuntimeGuidance(version)).toBeUndefined()
    },
  )

  it.each([
    '23.11.0',
    '24.20.0',
    '24.22.0',
    '25.9.0',
    '26.11.1',
    '26.12.0',
    '26.0.0',
    '26.12.1-rc.1',
    '24.22.1-nightly20261020abcdef',
    'unknown',
  ])(
    'Node.js の版 %s では、起動を止める',
    async (version) => {
      await explains('実行する Node.js の版を確認する `checkNodeRuntime` のテストです。修正を含まない版、プレリリース版、解釈できない `unknown` を渡した場合に、メッセージに版、必要な版の範囲、`nvm install` の案内が含まれることを確認します。')
      const message = checkNodeRuntime(version)
      expect(message).toContain(`Node.js ${version} does not include fixes for known vulnerabilities`)
      expect(message).toContain('24.x: 24.22.1 or later, 26.x: 26.12.1 or later')
      expect(message).toContain(`nvm install ${suggestedNodeVersion()}`)
    },
  )

  it.each(['23.11.0', '24.20.0', '25.9.0', '26.12.0', 'unknown'])(
    'Node.js の版 %s の案内は字下げがなく、checkNodeRuntime の結果は続きの行に空白 2 つを付ける',
    async (version) => {
      await explains('実行する Node.js の版を確認する `checkNodeRuntime` のテストです。`nodeRuntimeGuidance` の案内の各行が空白で始まらず、`checkNodeRuntime` の結果が、案内の改行の後に空白 2 つを加えたものと一致することを確認します。')
      const guidance = nodeRuntimeGuidance(version) ?? ''
      expect(guidance).not.toBe('')
      for (const line of guidance.split('\n')) expect(line).not.toMatch(/^\s/)
      expect(checkNodeRuntime(version)).toBe(guidance.replaceAll('\n', '\n  '))
    },
  )

  it('Node.js 24.20.0 の案内は 3 行で、launcher と hook が書く形のまま変わらない', async () => {
    await explains('実行する Node.js の版を確認する `checkNodeRuntime` のテストです。版 `24.20.0` を渡した場合に、メッセージが、起動しない旨、必要な版、対処の方法の 3 行からなる決まった文字列と一致することを確認します。')
    expect(checkNodeRuntime('24.20.0')).toBe(
      [
        'Node.js 24.20.0 does not include fixes for known vulnerabilities; not starting',
        '  required: 24.x: 24.22.1 or later, 26.x: 26.12.1 or later',
        '  (fix: update Node.js and run again; with nvm: nvm install 24.22.1)',
      ].join('\n'),
    )
  })

  it('案内用の版は、表の最小の major の最低版で、その版は許可される', async () => {
    await explains('実行する Node.js の版を確認する `checkNodeRuntime` のテストです。`suggestedNodeVersion` が返す `24.22.1` を `checkNodeRuntime` へ渡した場合は、起動が許可されることを確認します。')
    expect(suggestedNodeVersion()).toBe('24.22.1')
    expect(checkNodeRuntime(suggestedNodeVersion())).toBeUndefined()
  })
})

describe('最低版の記述の整合', () => {
  it.each(['../../package.json', '../../../package.json'])(
    '%s の engines.node は、最低版の表と同じ境界を宣言する',
    async (relativePath) => {
      await explains('Node.js の最低版を記載した複数の箇所が、一致していることのテストです。2 つの `package.json` の `engines.node` が、`MINIMUM_NODE_VERSIONS` の表から組み立てた範囲指定と一致することを確認します。')
      const manifest: unknown = JSON.parse(readRelative(relativePath))
      expect(manifest).toMatchObject({ engines: { node: expectedEngines() } })
    },
  )

  it('pre-commit の hook の EXPECTED_ENGINES_NODE は、最低版の表と一致する', async () => {
    await explains('Node.js の最低版を記載した複数の箇所が、一致していることのテストです。`check-engines-node-drift.sh` の `EXPECTED_ENGINES_NODE` が、最低版の表から組み立てた範囲指定と一致することを確認します。')
    const hook = readRelative('../../../../../.githooks/pre-commit/check-engines-node-drift.sh')
    const match = /^EXPECTED_ENGINES_NODE="([^"]*)"$/m.exec(hook)
    expect(match?.[1]).toBe(expectedEngines())
  })

  it('node-runtime.ts は、pecot-tools の同名のファイルと内容が一致する', async () => {
    await explains('Node.js の最低版を記載した複数の箇所が、一致していることのテストです。`src/node-runtime.ts` の内容が、`pecot-tools/cli/src/node-runtime.ts` として読み込んだファイルの内容と、1 文字も違わないことを確認します。')
    expect(readRelative('../../../../pecot-tools/cli/src/node-runtime.ts')).toBe(readRelative('../node-runtime.ts'))
  })

  it('pecot-tools 配下で git が管理するすべての package.json の engines.node は、最低版の表と一致する', async () => {
    await explains('Node.js の最低版を記載した複数の箇所が、一致していることのテストです。`pecot-tools` 配下で git が追跡するすべての `package.json` の `engines.node` が、最低版の表から組み立てた範囲指定と一致することを確認します。')
    // pecot-tools は pre-commit フックの対象外のため、ここで確かめる。
    const root = fileURLToPath(new URL('../../../../pecot-tools/', import.meta.url))
    // git のフック（pre-push）から実行されると GIT_DIR 等が設定され、cwd がリポジトリの
    // ルート扱いになって列挙の基準がずれる。GIT_* を外して cwd から解決させる。
    // interface-env: none
    const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    const listed = execFileSync('git', ['ls-files', '--', '*package.json'], { cwd: root, encoding: 'utf8', env: gitEnvironment })
    attachOutput('git ls-files -- *package.json', 0, listed, '')
    const files = listed
      .split('\n')
      .filter(file => file !== '' && !file.includes('node_modules/'))
    expect(files).toContain('package.json')
    expect(files).toContain('cli/package.json')
    for (const file of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- git ls-files の出力を root 相対で組んだパス
      const manifest: unknown = JSON.parse(readFileSync(path.join(root, file), 'utf8'))
      expect({ file, manifest }).toMatchObject({ manifest: { engines: { node: expectedEngines() } } })
    }
  })
})
