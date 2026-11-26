// w-release の release-nx.md が、nx の起動コマンドを pnpm-lock.yaml の有無で切り替える書き方を守ることを確かめる。
import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { readPluginFile } from './_helpers/documents.js'

const RELEASE_NX = 'skills/w-release/references/release-nx.md'
const SINGLE_BRANCH_HEADING = '## 単一ブランチモード（develop == release）'
const NX_SWITCH = 'if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi'

/**
heading で始まる行から、次の nextPrefix で始まる行の手前までを返す
*/
function section(text: string, heading: string, nextPrefix: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith(heading))
  expect(start).toBeGreaterThanOrEqual(0)
  const next = lines.findIndex((line, index) => index > start && line.startsWith(nextPrefix))
  return lines.slice(start, next === -1 ? lines.length : next).join('\n')
}

function codeBlockLines(text: string): readonly string[] {
  let isInBlock = false
  const lines: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) isInBlock = !isInBlock
    else if (isInBlock) lines.push(line)
  }
  return lines
}

describe('release-nx.md', () => {
  const text = readPluginFile(RELEASE_NX)

  it('単一ブランチモードの手順 1 は、git pull の後に、ロックファイルを固定した install を実行する', async () => {
    await explains('`release-nx.md` の単一ブランチモードの手順 1 のテストです。`git pull --ff-only` の後に、`pnpm install --frozen-lockfile` を実行する行があり、`npm ci` への切り替えもあることを確認します。')
    const single = section(text, SINGLE_BRANCH_HEADING, '## ')
    const code = codeBlockLines(section(single, '### 1.', '### '))
    const pull = code.findIndex(line => line.includes('git pull --ff-only'))
    expect(pull).toBeGreaterThanOrEqual(0)
    const install = code.slice(pull + 1).filter(line => line.includes('pnpm install --frozen-lockfile'))
    expect(install.length).toBeGreaterThan(0)
    expect(install.every(line => line.includes('pnpm-lock.yaml') && line.includes('npm ci'))).toBe(true)
  })

  it('nx の起動は pnpm-lock.yaml の有無で切り替え、直接の npx nx は書かない', async () => {
    await explains('`release-nx.md` の nx の起動方法のテストです。`pnpm-lock.yaml` の有無で `pnpm exec nx` と `npx nx` を切り替える行があり、それ以外に `npx nx` を直接書いた行が存在しないことを確認します。')
    expect(text).toContain(NX_SWITCH)
    const rest = text.replace(NX_SWITCH, '')
    const direct = rest.split('\n').filter(line => line.includes('npx nx') && !line.includes('pnpm exec nx'))
    expect(direct).toEqual([])
    expect(text).toContain('$NX release')
  })

  it('NX を使う行は、cd の後・NX の前で起動コマンドを決める', async () => {
    await explains('`release-nx.md` のコード例のテストです。`$NX` を使う行が 5 行以上あり、どの行も `cd` の後、`$NX` を使う前に起動コマンドを決めていることを確認します。')
    const lines = codeBlockLines(text).filter(line => line.includes('$NX ') && !(line.split('&&', 1)[0] ?? '').includes(NX_SWITCH))
    expect(lines.length).toBeGreaterThanOrEqual(5)
    const misordered = lines.filter((line) => {
      const cd = line.indexOf('cd <project-root>/base/<repo>')
      const switchAt = line.indexOf(NX_SWITCH)
      const use = line.indexOf('$NX ', switchAt + NX_SWITCH.length)
      return !(cd !== -1 && cd < switchAt && switchAt < use)
    })
    expect(misordered).toEqual([])
  })

  it('merge-strategy.md は、起動コマンドの $NX を使う', async () => {
    await explains('w-help の参照 `merge-strategy.md` のテストです。起動コマンドの変数を使った `$NX release` の書き方になっていることを確認します。')
    expect(readPluginFile('skills/w-help/references/merge-strategy.md')).toContain('`$NX release`')
  })
})
