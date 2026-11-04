import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { TextlintKernel } from '@textlint/kernel'
import type { TextlintKernelDescriptor } from '@textlint/kernel'
import { BYTE_ORDER_MARK } from './byte-order-mark.js'
import { buildDescriptor } from './descriptor.js'
import { oneLine, withoutSummary } from './findings.js'

export interface MainDependencies {
  readonly descriptor: () => TextlintKernelDescriptor
  readonly readFile: (file: string) => Promise<string>
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export const REAL_DEPS: MainDependencies = {
  descriptor: buildDescriptor,
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 引数で渡されたパスを読むのがコマンドの役割
  readFile: async file => readFile(file, 'utf8'),
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}

export interface Arguments {
  readonly commitMsg: boolean
  readonly files: readonly string[]
}

export function parseArgv(argv: readonly string[]): Arguments {
  return { commitMsg: argv.includes('--commit-msg'), files: argv.filter(argument => argument !== '--commit-msg') }
}

// `git commit -v` はこの行の下に diff を置く。
const SCISSORS = '# ------------------------ >8 ------------------------'

// Conventional Commits の `type(scope)` と破壊的変更の印と `:`。type と scope は文章ではなく、
// このリポジトリでは scope に変更した nx project を `,` 区切りで並べる書式を求めるため、チェックの入力から外す。
// 取り除くので、件名の行の列は取り除いた長さを足してファイル上の位置に戻す（空白で埋めると 4 個以上でコードブロックになる）。
const TYPE = /^[a-z]+/
const SCOPE = /^\([^)]*\)/
const BREAKING_AND_COLON = /^!?:[ \t]*/

function withoutConventionalPrefix(line: string): string {
  const type = TYPE.exec(line)?.[0] ?? ''
  const afterType = line.slice(type.length)
  const afterScope = afterType.replace(SCOPE, '')
  const suffix = BREAKING_AND_COLON.exec(afterScope)
  return type === '' || suffix === null ? line : afterScope.slice(suffix[0].length)
}

// コメント行（`#` 始まり）を空行に置き換えて行番号を保ち、scissors 行以降は捨てる。
// `git commit -m` では git が `#` 行を落とさないので見逃しになるが、契約は `#` 固定とする（エディタで書くのが主な使い方のため）。
export interface CommitMessage {
  readonly text: string
  // 件名の行（1 始まり）と、その行の先頭から取り除いた長さ。件名が無ければ 0 と 0。
  readonly subjectLine: number
  readonly removed: number
}

export function prepareCommitMessage(text: string): CommitMessage {
  const lines = text.split('\n')
  const scissors = lines.findIndex(line => line.replace(/\r$/, '') === SCISSORS)
  const kept = scissors === -1 ? lines : lines.slice(0, scissors)
  const stripped = kept.map(line => (line.startsWith('#') ? '' : line))
  const subject = stripped.findIndex(line => line !== '')
  const original = stripped.find(line => line !== '') ?? ''
  const body = withoutConventionalPrefix(original)
  const prepared = stripped.map((line, index) => (index === subject ? body : line)).join('\n')
  return { text: prepared, subjectLine: subject + 1, removed: original.length - body.length }
}

export function stripCommitComments(text: string): string {
  return prepareCommitMessage(text).text
}

// kernel の message のうち、出力に使う項目だけを読む。
export interface Finding {
  readonly ruleId: string
  readonly message: string
  readonly loc: { readonly start: { readonly line: number, readonly column: number } }
}

export function formatMessage(file: string, message: Finding): string {
  return `${file}:${String(message.loc.start.line)}:${String(message.loc.start.column)} ${message.ruleId} ${oneLine(message.message)}`
}

const PLUGIN_ERROR = 'plugin-error'

// 違反があれば 1、無ければ 0、読み込みや解析の失敗は 2 を返す。
export async function main(argv: readonly string[], dependencies: MainDependencies): Promise<number> {
  let violations = 0
  let current = ''
  try {
    const { commitMsg, files } = parseArgv(argv)
    const descriptor = dependencies.descriptor()
    const kernel = new TextlintKernel()
    for (const file of files) {
      current = file
      const extension = commitMsg ? '.md' : path.extname(file)
      if (descriptor.findPluginDescriptorWithExt(extension) === undefined) {
        continue
      }
      // kernel は本文の BOM を落として数えるので、plugin にも同じ本文を渡して位置をそろえる。
      const original = await dependencies.readFile(file)
      const text = original.replace(BYTE_ORDER_MARK, '')
      const prepared = commitMsg ? prepareCommitMessage(text) : { text, subjectLine: 0, removed: 0 }
      const result = await kernel.lintText(prepared.text, {
        ext: extension,
        filePath: file,
        ...descriptor.toKernelOptions(),
      })
      // kernel は plugin の例外を message に変えて正常終了するので、違反ではなく実行失敗として扱う。
      const failure = result.messages.find(found => found.ruleId === PLUGIN_ERROR)
      if (failure !== undefined) {
        throw new Error(oneLine(failure.message))
      }
      for (const message of withoutSummary(result.messages)) {
        const shift = message.loc.start.line === prepared.subjectLine ? prepared.removed : 0
        const located = { ...message, loc: { start: { line: message.loc.start.line, column: message.loc.start.column + shift } } }
        dependencies.stdout(`${formatMessage(file, located)}\n`)
        violations += 1
      }
    }
    return violations === 0 ? 0 : 1
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    dependencies.stderr(current === '' ? `pecot-text-lint: ${reason}\n` : `pecot-text-lint: ${current}: ${reason}\n`)
    return 2
  }
}
