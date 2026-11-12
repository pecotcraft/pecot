import { describe, expect, it } from 'vitest'

import { parseGlobalOptions } from '../global-options.js'
import { UsageError } from '../usage-error.js'

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
  it('引数が無ければ空の結果', () => {
    expect(parseGlobalOptions([])).toEqual({ eager: undefined, repo: undefined, showRepo: false, rest: [] })
  })

  it('-v・--version は version', () => {
    expect(parseGlobalOptions(['-v']).eager).toBe('version')
    expect(parseGlobalOptions(['--version']).eager).toBe('version')
    expect(parseGlobalOptions(['-vv']).eager).toBe('version')
  })

  it('--help は help。先に来た方が勝つ', () => {
    expect(parseGlobalOptions(['--help']).eager).toBe('help')
    expect(parseGlobalOptions(['--help', '-v']).eager).toBe('help')
    expect(parseGlobalOptions(['-v', '--help']).eager).toBe('version')
  })

  it('--repo は次の引数か = の右を取る。空文字も値', () => {
    expect(parseGlobalOptions(['--repo', 'a/b']).repo).toBe('a/b')
    expect(parseGlobalOptions(['--repo=a/b']).repo).toBe('a/b')
    expect(parseGlobalOptions(['--repo=']).repo).toBe('')
    expect(parseGlobalOptions(['--repo', '-v']).repo).toBe('-v')
  })

  it('--show-repo は真偽値', () => {
    expect(parseGlobalOptions(['--show-repo']).showRepo).toBe(true)
  })

  it('最初の位置引数から後ろは rest にする', () => {
    expect(parseGlobalOptions(['--repo', 'a/b', 'issue', 'read', '-v']).rest).toEqual(['issue', 'read', '-v'])
    expect(parseGlobalOptions(['-v', 'issue']).eager).toBe('version')
  })

  it('-- の後ろは rest。-- 自体は落とす', () => {
    expect(parseGlobalOptions(['--repo', 'a/b', '--', 'issue']).rest).toEqual(['issue'])
    expect(parseGlobalOptions(['--', 'issue', '-v']).rest).toEqual(['issue', '-v'])
  })

  it('- だけは位置引数として扱う', () => {
    expect(parseGlobalOptions(['-']).rest).toEqual(['-'])
  })

  it('--repo の値が無ければ context なしの誤り', () => {
    const error = usageErrorOf(['--show-repo', '--repo'])
    expect(error.message).toBe('Option \'--repo\' requires an argument.')
    expect(error.context).toBeUndefined()
  })

  it('値を取らないオプションに値を付けると context なしの誤り', () => {
    expect(usageErrorOf(['--version=1']).message).toBe('Option \'--version\' does not take a value.')
    expect(usageErrorOf(['--show-repo=1']).message).toBe('Option \'--show-repo\' does not take a value.')
    expect(usageErrorOf(['--help=1']).context).toBeUndefined()
  })

  it('未知のオプションは root の context 付き。-v が先にあっても誤りが勝つ', () => {
    for (const argv of [['--bogus'], ['-v', '--bogus'], ['--bogus=1']]) {
      const error = usageErrorOf(argv)
      expect(error.message).toBe('No such option: --bogus')
      expect(error.context).toEqual({ commandPath: [], synopsis: '[OPTIONS] COMMAND [ARGS]...' })
    }
    expect(usageErrorOf(['-vx']).message).toBe('No such option: -x')
  })

  it('--repo の値が不正でも、解析の段では誤りにしない', () => {
    expect(parseGlobalOptions(['--repo', 'bad', '-v'])).toEqual({ eager: 'version', repo: 'bad', showRepo: false, rest: [] })
  })

  it('未知のオプションには、近いオプションを辞書順で案内する', () => {
    expect(usageErrorOf(['--show-rep']).message).toBe('No such option: --show-rep (Possible options: --help, --repo, --show-repo)')
    expect(usageErrorOf(['--shw-repo']).message).toBe('No such option: --shw-repo (Possible options: --help, --repo, --show-repo)')
  })

  it('-- の後ろの先頭がオプションの形なら、オプションとして解析し直す', () => {
    expect(parseGlobalOptions(['--', '--version']).eager).toBe('version')
    expect(parseGlobalOptions(['--', '--help']).eager).toBe('help')
    expect(parseGlobalOptions(['--', '--show-repo', 'issue'])).toEqual({ eager: undefined, repo: undefined, showRepo: true, rest: ['issue'] })
    expect(usageErrorOf(['--', '--bogus']).message).toBe('No such option: --bogus')
  })

  it('解析し直しは、前に指定した値を引き継ぐ', () => {
    expect(parseGlobalOptions(['-v', '--', '--help']).eager).toBe('version')
    expect(parseGlobalOptions(['--repo', 'a/b', '--show-repo', '--', '--repo', 'c/d'])).toEqual({ eager: undefined, repo: 'c/d', showRepo: true, rest: [] })
    expect(parseGlobalOptions(['--repo', 'a/b', '--', '--show-repo'])).toEqual({ eager: undefined, repo: 'a/b', showRepo: true, rest: [] })
  })
})
