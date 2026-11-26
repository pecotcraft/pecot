// vendor/text-rules は、assets/slidev の build が読む libs/text-rules へのリンク。git にはリンクとして 1 件だけ入る。
import { execFileSync } from 'node:child_process'
import { readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..')
const LINK = path.join(PLUGIN_ROOT, 'vendor/text-rules')

describe('vendor/text-rules', () => {
  it('git の index ではリンク（mode 120000）の 1 件だけで、実ディレクトリのファイルが入らない', () => {
    const entries = execFileSync('git', ['ls-files', '--stage', '--', 'vendor/text-rules'], { cwd: PLUGIN_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(line => line !== '')

    expect(entries.map(line => line.split(' ', 1)[0])).toEqual(['120000'])
  })

  it('リンク先は ../../../libs/text-rules で、repo 共通のライブラリの実体を指す', () => {
    expect(readlinkSync(LINK)).toBe('../../../libs/text-rules')
    expect(realpathSync(LINK)).toBe(realpathSync(path.join(REPO_ROOT, 'libs/text-rules')))
  })
})
