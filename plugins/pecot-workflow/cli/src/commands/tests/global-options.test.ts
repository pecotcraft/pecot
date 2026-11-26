import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { parseGlobalOptions } from '../global-options.js'
import { UsageError } from '@pecot/workflow-core/commands-shared/usage-error.js'

function usageErrorOf(argv: readonly string[]): UsageError {
  try {
    parseGlobalOptions(argv)
  }
  catch (error: unknown) {
    if (error instanceof UsageError) return error
    throw error
  }
  throw new Error('UsageError が投げられませんでした')
}

describe('parseGlobalOptions', () => {
  it('引数が存在しない場合は、何も指定されていない結果を返す', async () => {
    await explains('グローバルオプションを解析する `parseGlobalOptions` のテストです。引数が空の場合に、`eager` と `repo` が `undefined`、`showRepo` が `false`、`rest` が空の配列になることを確認します。')
    expect(parseGlobalOptions([])).toEqual({ eager: undefined, repo: undefined, showRepo: false, rest: [] })
  })

  it('-v・-vv・--version は、バージョンの表示を求める指定として解釈する', async () => {
    await explains('`parseGlobalOptions` のバージョン表示のテストです。`-v`・`--version`・`-vv` のどれを渡した場合も、`eager` が `version` になることを確認します。')
    expect(parseGlobalOptions(['-v']).eager).toBe('version')
    expect(parseGlobalOptions(['--version']).eager).toBe('version')
    expect(parseGlobalOptions(['-vv']).eager).toBe('version')
  })

  it('--help はヘルプの表示を求める指定として解釈し、-v と同時に指定した場合は先に指定した方を採用する', async () => {
    await explains('`--help` と `-v` の優先順位のテストです。`--help` だけなら `help`、`--help -v` なら `help`、`-v --help` なら `version` と、先に指定した方が `eager` になることを確認します。')
    expect(parseGlobalOptions(['--help']).eager).toBe('help')
    expect(parseGlobalOptions(['--help', '-v']).eager).toBe('help')
    expect(parseGlobalOptions(['-v', '--help']).eager).toBe('version')
  })

  it('--repo は、次の引数か = の右側を値として受け取り、空文字も値として扱う', async () => {
    await explains('`--repo` の値の渡し方のテストです。`--repo a/b` と `--repo=a/b` のどちらでも `a/b` を受け取り、`--repo=` では空文字、`--repo -v` では `-v` を値として受け取ることを確認します。')
    expect(parseGlobalOptions(['--repo', 'a/b']).repo).toBe('a/b')
    expect(parseGlobalOptions(['--repo=a/b']).repo).toBe('a/b')
    expect(parseGlobalOptions(['--repo=']).repo).toBe('')
    expect(parseGlobalOptions(['--repo', '-v']).repo).toBe('-v')
  })

  it('--show-repo を指定すると、showRepo が true になる', async () => {
    await explains('`parseGlobalOptions` のテストです。`--show-repo` を渡した場合に、`showRepo` が `true` になることを確認します。')
    expect(parseGlobalOptions(['--show-repo']).showRepo).toBe(true)
  })

  it('最初の位置引数以降は、解析せず rest にまとめる', async () => {
    await explains('グローバルオプションの解析範囲のテストです。最初の位置引数 `issue` 以降は、`-v` を含めて解析せず `rest` にまとめ、位置引数より前の `-v` は `version` として解釈することを確認します。')
    expect(parseGlobalOptions(['--repo', 'a/b', 'issue', 'read', '-v']).rest).toEqual(['issue', 'read', '-v'])
    expect(parseGlobalOptions(['-v', 'issue']).eager).toBe('version')
  })

  it('-- の後ろは rest にまとめ、-- 自体は含めない', async () => {
    await explains('`--` を渡した場合のテストです。`--` の後ろの引数を `rest` にまとめ、`--` 自体は `rest` に含めないことを確認します。')
    expect(parseGlobalOptions(['--repo', 'a/b', '--', 'issue']).rest).toEqual(['issue'])
    expect(parseGlobalOptions(['--', 'issue', '-v']).rest).toEqual(['issue', '-v'])
  })

  it('-（ハイフン 1 つ）だけの引数は、位置引数として扱う', async () => {
    await explains('ハイフン 1 つだけの引数のテストです。`-` を渡した場合に、オプションとして解釈せず、位置引数として `rest` に含めることを確認します。')
    expect(parseGlobalOptions(['-']).rest).toEqual(['-'])
  })

  it('--repo の値が存在しない場合は、使い方の情報を持たない使い方の誤りにする', async () => {
    await explains('`--repo` の値を省略した場合のテストです。`Option \'--repo\' requires an argument.` のメッセージで、使い方の情報（`context`）を持たない `UsageError` が発生することを確認します。')
    const error = usageErrorOf(['--show-repo', '--repo'])
    expect(error.message).toBe('Option \'--repo\' requires an argument.')
    expect(error.context).toBeUndefined()
  })

  it('値を取らないオプションに値を付けると、使い方の情報を持たない使い方の誤りにする', async () => {
    await explains('`--version=1` や `--show-repo=1` のように、値を取らないオプションへ値を付けた場合のテストです。`does not take a value.` のメッセージで、使い方の情報を持たない `UsageError` が発生することを確認します。')
    expect(usageErrorOf(['--version=1']).message).toBe('Option \'--version\' does not take a value.')
    expect(usageErrorOf(['--show-repo=1']).message).toBe('Option \'--show-repo\' does not take a value.')
    expect(usageErrorOf(['--help=1']).context).toBeUndefined()
  })

  it('定義されていないオプションは、ルートの使い方の情報を付けた使い方の誤りにし、-v が先にあっても誤りを優先する', async () => {
    await explains('定義されていないオプション `--bogus` を渡した場合のテストです。`-v` が先にあっても、`No such option: --bogus` の `UsageError` が発生し、ルートの使い方の情報が付くことを確認します。')
    for (const argv of [['--bogus'], ['-v', '--bogus'], ['--bogus=1']]) {
      const error = usageErrorOf(argv)
      expect(error.message).toBe('No such option: --bogus')
      expect(error.context).toEqual({ commandPath: [], synopsis: '[OPTIONS] COMMAND [ARGS]...' })
    }
    expect(usageErrorOf(['-vx']).message).toBe('No such option: -x')
  })

  it('--repo の値が不正でも、グローバルオプションの解析では誤りにしない', async () => {
    await explains('`--repo` に不正な値 `bad` を渡した場合のテストです。解析の時点では誤りにせず、値をそのまま `repo` に入れて結果を返すことを確認します。')
    expect(parseGlobalOptions(['--repo', 'bad', '-v'])).toEqual({ eager: 'version', repo: 'bad', showRepo: false, rest: [] })
  })

  it('定義されていないオプションには、近いオプションを辞書順に並べて案内する', async () => {
    await explains('綴りを誤ったオプションのテストです。綴りの誤りを渡した場合に、近いオプションを辞書順に並べた `Possible options: --help, --repo, --show-repo` を表示することを確認します。')
    expect(usageErrorOf(['--show-rep']).message).toBe('No such option: --show-rep (Possible options: --help, --repo, --show-repo)')
    expect(usageErrorOf(['--shw-repo']).message).toBe('No such option: --shw-repo (Possible options: --help, --repo, --show-repo)')
  })

  it('-- の後ろの先頭がオプションの形の場合は、オプションとして解析し直す', async () => {
    await explains('`--` の後ろの先頭がオプションの形の場合のテストです。`--version`・`--help`・`--show-repo` はオプションとして解析し直し、`--bogus` は `No such option` の誤りになることを確認します。')
    expect(parseGlobalOptions(['--', '--version']).eager).toBe('version')
    expect(parseGlobalOptions(['--', '--help']).eager).toBe('help')
    expect(parseGlobalOptions(['--', '--show-repo', 'issue'])).toEqual({ eager: undefined, repo: undefined, showRepo: true, rest: ['issue'] })
    expect(usageErrorOf(['--', '--bogus']).message).toBe('No such option: --bogus')
  })

  it('解析し直す場合は、前に指定した値を引き継ぐ', async () => {
    await explains('`--` の後ろを解析し直す場合のテストです。前に指定した `-v` や `--repo`、`--show-repo` の値を引き継ぎ、同じオプションを後ろで指定したときは、後ろの値で上書きすることを確認します。')
    expect(parseGlobalOptions(['-v', '--', '--help']).eager).toBe('version')
    expect(parseGlobalOptions(['--repo', 'a/b', '--show-repo', '--', '--repo', 'c/d'])).toEqual({ eager: undefined, repo: 'c/d', showRepo: true, rest: [] })
    expect(parseGlobalOptions(['--repo', 'a/b', '--', '--show-repo'])).toEqual({ eager: undefined, repo: 'a/b', showRepo: true, rest: [] })
  })
})
