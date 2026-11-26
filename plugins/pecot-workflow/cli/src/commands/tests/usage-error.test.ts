import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { readGolden, scenarioIds } from '../../../tests/parity/scenario.js'
import { InvalidValueError } from '@pecot/workflow-core/domain/errors.js'
import { parseOwnerRepository } from '@pecot/workflow-core/domain/repository-resolver.js'
import { invalidRepositoryMessage } from '../global-options.js'
import { formatUsageError, UsageError } from '@pecot/workflow-core/commands-shared/usage-error.js'

const ROOT = { commandPath: [], synopsis: '[OPTIONS] COMMAND [ARGS]...' }

describe('golden の usage エラー', () => {
  // グローバルオプションの誤り（global-）は文が複数行になるので、下の個別のケースで確かめる
  const ids = scenarioIds().filter(id => !id.startsWith('global-') && readGolden(id).stderr.startsWith('Usage: '))

  it('golden の usage エラーを 26 件読み込む', async () => {
    await explains('usage エラーの期待値（golden）の件数のテストです。`global-` で始まるものを除いた golden のうち、標準エラー出力が `Usage: ` で始まるものが 26 件あることを確認します。')
    expect(ids).toHaveLength(26)
  })

  it.for(ids)('golden の %s と同じ標準エラー出力を、1 文字ずつ同じ内容で作成する', async (id) => {
    await explains('golden から読み込んだ usage エラーのテストです。golden の文から `UsageError` を組み立てた場合に、`formatUsageError` の戻り値は、golden の標準エラー出力と文字単位で一致することを確認します。')
    const { stderr } = readGolden(id)
    const lines = stderr.split('\n')
    const program = (lines.at(0) ?? '').replace(/^Usage: /u, '').split(' ')
    const optionsAt = program.indexOf('[OPTIONS]')
    // 枠の中で折り返した文は、空白でつなぎ直す
    const message = lines.slice(3).filter(line => line.startsWith('│ ')).map(line => line.replace(/^│ /u, '').replace(/ *│$/u, '')).join(' ')
    const error = new UsageError(message, {
      commandPath: program.slice(1, optionsAt),
      synopsis: program.slice(optionsAt).join(' '),
    })
    expect(program.at(0)).toBe('pecot')
    expect(formatUsageError(error)).toBe(stderr)
  })
})

// 括弧の中の文は、domain の解析が投げた例外の文をそのまま使う。期待値は Python の実出力（golden）
function repositoryError(value: string): string {
  try {
    parseOwnerRepository(value)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) return formatUsageError(new UsageError(invalidRepositoryMessage(error.message), ROOT))
    throw error
  }
  throw new Error('例外が投げられませんでした')
}

describe('formatUsageError', () => {
  it.for([
    ['global-usage-bad-repo', 'bad'],
    ['global-usage-bad-repo-segment', '日本語/b'],
    ['global-usage-bad-repo-folded', `${Array.from({ length: 45 }, (_, index) => String.fromCodePoint(0x1_F6_00 + (index % 40))).join('')}/b`],
  ])('--repo の不正な値は枠の中で折り返す: %s', async ([id = '', value = '']) => {
    await explains('`--repo` に不正な値を渡した場合の、usage エラーのテストです。日本語や長い絵文字の並びを含む値でも、枠の中で折り返した標準エラー出力が、golden と一致することを確認します。')
    expect(repositoryError(value)).toBe(readGolden(id).stderr)
  })
})
