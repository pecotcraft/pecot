// ルートのグローバルオプションの解析。Python の CLI（click）が root で行っていた解析を写す。
//
// 解析はコマンド名の手前で止まる。コマンド名より後ろの引数は、そのコマンドの解析に渡す。
// ここでは値の検証はしない。--repo の形式と PECOT_GITHUB_API_URL は、呼び出す側が決まった順で検証する。
import { closeMatches } from './fuzzy.js'
import type { UsageContext } from './usage-error.js'
import {
  COMMAND_SYNOPSIS,
  invalidValueMessage,
  noSuchOptionMessage,
  optionRequiresArgumentMessage,
  optionTakesNoValueMessage,
  UsageError,
} from './usage-error.js'

/**
--repo の値が不正なときの文。detail は owner/repo の解析が投げた例外の文
*/
export function invalidRepositoryMessage(detail: string): string {
  return invalidValueMessage('--repo', `must be in 'owner/repo' form: ${detail}`)
}

export const ROOT_USAGE: UsageContext = { commandPath: [], synopsis: COMMAND_SYNOPSIS }

/**
eager なオプション。click と同じく、先に指定された方だけを実行する
*/
export type EagerOption = 'help' | 'version'

export interface GlobalOptions {
  readonly eager: EagerOption | undefined
  readonly repo: string | undefined
  readonly showRepo: boolean
  /**
  コマンド名から後ろの引数
  */
  readonly rest: readonly string[]
}

/**
未知のオプションの候補に使う名前。--install-completion と --show-completion は Python の CLI にあり、Node の CLI は実装しない
*/
const LONG_OPTION_NAMES: readonly string[] = ['--version', '--repo', '--show-repo', '--install-completion', '--show-completion', '--help']

const LONG_FLAGS: ReadonlyMap<string, EagerOption | 'show-repo'> = new Map([
  ['--version', 'version'],
  ['--help', 'help'],
  ['--show-repo', 'show-repo'],
])

/**
root の引数を解析する。誤りは UsageError にする。
--repo の値が欠けた誤りと値を取らないオプションに値を付けた誤りは、click と同じく Usage 行を付けない
*/
export function parseGlobalOptions(argv: readonly string[]): GlobalOptions {
  let eager: EagerOption | undefined
  let repository: string | undefined
  let isShowRepository = false
  let rest: readonly string[] = []

  // next は、いま見ている引数の次の位置
  let next = 0
  while (next < argv.length) {
    const argument = argv.at(next) ?? ''
    const current = next
    next += 1
    if (argument === '--') {
      rest = argv.slice(next)
      // click は、-- の後ろの先頭がオプションの形でコマンド名でもないとき、その引数をオプションとして解析し直す
      if (rest.at(0)?.startsWith('-') === true) {
        const again = parseGlobalOptions(rest)
        return { eager: eager ?? again.eager, repo: again.repo ?? repository, showRepo: isShowRepository || again.showRepo, rest: again.rest }
      }
      break
    }
    if (argument === '-' || !argument.startsWith('-')) {
      rest = argv.slice(current)
      break
    }
    if (!argument.startsWith('--')) {
      for (const letter of argument.slice(1)) {
        if (letter !== 'v') throw new UsageError(noSuchOptionMessage(`-${letter}`), ROOT_USAGE)
        eager ??= 'version'
      }
      continue
    }
    const separator = argument.indexOf('=')
    const name = separator === -1 ? argument : argument.slice(0, separator)
    const value = separator === -1 ? undefined : argument.slice(separator + 1)
    if (name === '--repo') {
      const taken = value ?? argv.at(next)
      if (taken === undefined) throw new UsageError(optionRequiresArgumentMessage(name))
      repository = taken
      if (value === undefined) next += 1
      continue
    }
    const flag = LONG_FLAGS.get(name)
    if (flag === undefined) throw new UsageError(noSuchOptionMessage(name, closeMatches(name, LONG_OPTION_NAMES)), ROOT_USAGE)
    if (value !== undefined) throw new UsageError(optionTakesNoValueMessage(name))
    if (flag === 'show-repo') isShowRepository = true
    else eager ??= flag
  }
  return { eager, repo: repository, showRepo: isShowRepository, rest }
}
