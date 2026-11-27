import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { attachOutput } from '../../tests/_helpers/attach.js'
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
    'Node.js のバージョンが %s の場合は、起動を許可する',
    async (version) => {
      await explains('Node.js の最低版を確認する `checkNodeRuntime` のテストです。脆弱性の修正を含む版を渡した場合に、`checkNodeRuntime` と `nodeRuntimeGuidance` が `undefined` を返し、起動を許可することを確認します。')
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
    'Node.js のバージョンが %s の場合は、起動を止める',
    async (version) => {
      await explains('Node.js の最低版を確認する `checkNodeRuntime` のテストです。脆弱性の修正を含まない版を渡した場合に、必要な版と `nvm install` の案内を含む、起動を止める文言を返すことを確認します。')
      const message = checkNodeRuntime(version)
      expect(message).toContain(`Node.js ${version} does not include fixes for known vulnerabilities`)
      expect(message).toContain('24.x: 24.22.1 or later, 26.x: 26.12.1 or later')
      expect(message).toContain(`nvm install ${suggestedNodeVersion()}`)
    },
  )

  it.each(['23.11.0', '24.20.0', '25.9.0', '26.12.0', 'unknown'])(
    'Node.js のバージョンが %s の場合、nodeRuntimeGuidance は字下げのない案内を返し、checkNodeRuntime は続きの行に空白 2 つを付ける',
    async (version) => {
      await explains('起動を止める案内の字下げのテストです。`nodeRuntimeGuidance` の案内の各行が字下げを持たず、`checkNodeRuntime` は 2 行目以降に空白 2 つを付けた同じ内容を返すことを確認します。')
      const guidance = nodeRuntimeGuidance(version) ?? ''
      expect(guidance).not.toBe('')
      for (const line of guidance.split('\n')) expect(line).not.toMatch(/^\s/)
      expect(checkNodeRuntime(version)).toBe(guidance.replaceAll('\n', '\n  '))
    },
  )

  it('24.20.0 の案内は 3 行で、launcher と hook が書く形のまま変わらない', async () => {
    await explains('起動を止める案内の文言のテストです。Node.js 24.20.0 を渡した場合に、起動用のスクリプトとフックが出力する 3 行の文言と一致することを確認します。')
    expect(checkNodeRuntime('24.20.0')).toBe(
      [
        'Node.js 24.20.0 does not include fixes for known vulnerabilities; not starting',
        '  required: 24.x: 24.22.1 or later, 26.x: 26.12.1 or later',
        '  (fix: update Node.js and run again; with nvm: nvm install 24.22.1)',
      ].join('\n'),
    )
  })

  it('案内用の版は表の最小 major の最低版で、その版は許可される', async () => {
    await explains('案内に使う版の `suggestedNodeVersion` のテストです。最小の major の最低版である 24.22.1 を返し、その版は起動を許可されることを確認します。')
    expect(suggestedNodeVersion()).toBe('24.22.1')
    expect(checkNodeRuntime(suggestedNodeVersion())).toBeUndefined()
  })
})

describe('最低版の記述の整合', () => {
  it.each(['../../package.json', '../../../package.json'])(
    '%s の engines.node が最低版の表と同じ境界を宣言する',
    async (relativePath) => {
      await explains('最低版の記述の整合のテストです。2 つの `package.json` の `engines.node` が、最低版の表から組み立てた範囲と同じ境界を宣言していることを確認します。')
      const manifest: unknown = JSON.parse(readRelative(relativePath))
      expect(manifest).toMatchObject({ engines: { node: expectedEngines() } })
    },
  )

  it('pre-commit フックの EXPECTED_ENGINES_NODE が表と一致する', async () => {
    await explains('最低版の記述の整合のテストです。pre-commit のフックの `EXPECTED_ENGINES_NODE` が、最低版の表から組み立てた範囲と一致することを確認します。')
    const hook = readRelative('../../../../../.githooks/pre-commit/check-engines-node-drift.sh')
    const match = /^EXPECTED_ENGINES_NODE="([^"]*)"$/m.exec(hook)
    expect(match?.[1]).toBe(expectedEngines())
  })

  it('pecotv と pecot-tools の node-runtime.ts が完全一致する', async () => {
    await explains('最低版の記述の整合のテストです。pecotv と pecot-tools の `node-runtime.ts` の内容が同一であることを確認します。')
    expect(readRelative('../../../../pecot-tools/cli/src/node-runtime.ts')).toBe(readRelative('../node-runtime.ts'))
  })

  it('pecot-tools 配下の git 管理下の package.json の engines.node がすべて表と一致する', async () => {
    await explains('最低版の記述の整合のテストです。pecot-tools の配下で git が管理するすべての `package.json` の `engines.node` が、最低版の表から組み立てた範囲と一致することを確認します。')
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
