// `pecotv evidence create --input <spec.json> [--out <path.xlsx>] [--json]` の実装。
// drawio/url.ts と同形の DI / configureOutput の writeErr フックを採用する。
//
// exit code 規約は contracts/evidence-cli.md §1 に従う。
//   0 = 生成成功。除外警告があっても、有効画像が 1 件以上あれば成功とする。
//   1 = spec の読込・parse・検証エラー、文面の違反、有効画像 0 件、xlsx の書き出し失敗。
//       入力不正・文面の違反・有効画像 0 件では、出力に触れない。
//       output-write-failed では、部分生成物が残り得る。
//   2 = commander の usage エラー。required option 未指定などが当たり、cli.ts の main が変換する。
//       ただし --help / --version は commander の想定内終了なので exit 0 とする。

/* eslint-disable security/detect-non-literal-fs-filename -- --input / --out は CLI 引数として受理する仕様 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { Command } from 'commander'

import { createDiagnostics, passthrough, writeData } from '../../diagnostics.js'
import { collectTextViolations, formatTextViolations } from '../../domain/_shared/text-check.js'
import type { LintText, TextViolation } from '../../domain/_shared/text-check.js'
import type { EvidenceSpec, NormalizedEvidenceSpec, SpecValidationError } from '../../domain/evidence-xlsx/spec-schema.js'
import { parseEvidenceSpec } from '../../domain/evidence-xlsx/spec-schema.js'
import { specTexts } from '../../domain/evidence-xlsx/spec-text.js'
import type { EvidenceSkippedImage, EvidenceWriteResult } from '../../infra/evidence-xlsx/workbook-writer.js'
import { EvidenceWorkbookError, writeEvidenceWorkbook } from '../../infra/evidence-xlsx/workbook-writer.js'
import { defaultLintText } from '../../infra/text-lint.js'

const DEFAULT_OUT = './evidence.xlsx'

/**
--json のエラーイベント名。契約に定義が無いため drawio 同形の `<command>.error` に揃える。
*/
const ERROR_EVENT = 'evidence.create.error'

/**
実行失敗時の exit code。usage エラー (exit 2) は commander が cli.ts の main へ委譲するため、
本コマンド自身が設定するのは 1 のみ。
*/
export const EVIDENCE_CREATE_FAILURE_EXIT_CODE = 1

/**
spec の読込・parse・検証・文面確認の失敗理由。
*/
export type EvidenceCreateErrorReason
  = | 'input-not-found'
    | 'invalid-json'
    | 'invalid-spec'
    | 'text-violation'
    | 'text-lint-failed'

export class EvidenceCreateError extends Error {
  /**
  reason が text-violation のときの違反の全件。
  */
  constructor(
    message: string,
    readonly reason: EvidenceCreateErrorReason,
    readonly violations?: readonly TextViolation[],
  ) {
    super(message)
    this.name = 'EvidenceCreateError'
  }
}

export interface EvidenceCreateDependencies {
  readonly stdout: NodeJS.WritableStream
  readonly stderr: NodeJS.WritableStream
  readonly readFile: (filePath: string) => Promise<string>
  readonly lintText: LintText
  // spec は parseEvidenceSpec で正規化済みのものを渡す (省略可能フィールドが埋まった形)。
  readonly writeWorkbook: (
    spec: Readonly<NormalizedEvidenceSpec>,
    outPath: string,
  ) => Promise<EvidenceWriteResult>
}

/**
spec JSON を読んで検証し、xlsx を書き出す。パスはいずれも絶対パス化済みで渡す
(FR-007 の報告義務があるため、result に載る outPath も絶対パスになる)。
*/
export async function runEvidenceCreate(
  inputPath: string,
  outPath: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write は可変。DI 経由の write は mutate メソッド
  dependencies: EvidenceCreateDependencies,
): Promise<EvidenceWriteResult> {
  let text: string
  try {
    text = await dependencies.readFile(inputPath)
  }
  catch (error: unknown) {
    throw new EvidenceCreateError(
      `spec JSON が読めません: ${inputPath} (${formatError(error)})`,
      'input-not-found',
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch (error: unknown) {
    throw new EvidenceCreateError(
      `spec JSON の parse に失敗しました: ${inputPath} (${formatError(error)})`,
      'invalid-json',
    )
  }

  const parsed = parseEvidenceSpec(raw)
  if (!parsed.ok) {
    throw new EvidenceCreateError(
      `spec の検証に失敗しました (${parsed.errors.length.toString()} 件)\n${formatSpecErrors(parsed.errors)}`,
      'invalid-spec',
    )
  }
  // 文面は、caption を補う前の spec から取る。xlsx を書く前に全件を確認する
  await assertTextsClean(parsed.written, dependencies.lintText)
  return dependencies.writeWorkbook(parsed.spec, outPath)
}

/**
spec の文言を文章規則で確認し、違反があれば全件を載せて投げる。
判定器の失敗は text-lint-failed にする。
*/
async function assertTextsClean(spec: Readonly<EvidenceSpec>, lintText: LintText): Promise<void> {
  let violations: readonly TextViolation[]
  try {
    violations = await collectTextViolations(specTexts(spec), lintText)
  }
  catch (error: unknown) {
    throw new EvidenceCreateError(
      `文章規則を確認できませんでした: ${formatError(error)}`,
      'text-lint-failed',
    )
  }
  if (violations.length > 0) {
    throw new EvidenceCreateError(formatTextViolations(violations), 'text-violation', violations)
  }
}

export interface EvidenceCreateOptions {
  /**
  EvidenceSpec JSON のパス。相対パスは cwd 基準で解決する。
  */
  readonly input: string
  /**
  出力 xlsx パス。
  */
  readonly out: string
}

/**
`--json` の成功イベント。

event 名が `evidence.create.done` ではなく `result` なのは、既存 CLI の外形に合わせたため。
他コマンドの `<command>.done` 規約からは外れるが、互換のため追認している。
*/
export interface EvidenceCreateResultData {
  readonly event: 'result'
  readonly outPath: string
  readonly items: number
  readonly annotations: number
  readonly skipped: readonly EvidenceSkippedImage[]
}

/**
xlsx を生成し、`--json` と同形の結果オブジェクトを返す。
CLI の action と MCP ツールはどちらもこの関数を呼ぶ (実行と結果組み立ての単一実装)。
*/
export async function executeEvidenceCreate(
  options: Readonly<EvidenceCreateOptions>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write は可変。DI 経由の write は mutate メソッド
  dependencies: EvidenceCreateDependencies,
): Promise<EvidenceCreateResultData> {
  const result = await runEvidenceCreate(
    path.resolve(options.input),
    path.resolve(options.out),
    dependencies,
  )
  return {
    event: 'result',
    outPath: result.outPath,
    items: result.items,
    annotations: result.annotations,
    skipped: result.skipped,
  }
}

export function createEvidenceCreateCommand(buildDependencies: () => EvidenceCreateDependencies): Command {
  return new Command('create')
    .description('EvidenceSpec JSON から作業エビデンスの xlsx を生成する')
    .requiredOption('--input <path>', 'EvidenceSpec JSON のパス')
    .option('--out <path>', '出力 xlsx パス (既存ファイルは上書き)', DEFAULT_OUT)
    .option('--json', 'machine-readable な JSON を stdout に出す', false)
    .exitOverride()
    .configureOutput({
      writeErr: (string_: string) => {
        const dependencies = buildDependencies()
        if (doesArgvWantJson(process.argv)) {
          writeData(dependencies.stdout, JSON.stringify({
            event: ERROR_EVENT,
            reason: 'invalid-option',
            detail: string_.replace(/^error:[ \t]*/i, '').trim(),
          }))
        }
        else {
          passthrough(dependencies.stderr, string_)
        }
      },
    })
    .action(async (raw: Readonly<Record<string, unknown>>) => {
      const dependencies = buildDependencies()
      const isJson = raw['json'] === true

      try {
        const data = await executeEvidenceCreate({
          input: optionString(raw['input'], ''),
          out: optionString(raw['out'], DEFAULT_OUT),
        }, dependencies)
        if (isJson) {
          writeData(dependencies.stdout, JSON.stringify(data))
        }
        else {
          writeHumanSummary(dependencies.stdout, data)
        }
      }
      catch (error: unknown) {
        if (isJson) {
          writeData(dependencies.stdout, JSON.stringify(errorData(error)))
        }
        else {
          createDiagnostics(dependencies.stderr).error(`evidence create: ${formatError(error)}`)
        }
        process.exitCode = EVIDENCE_CREATE_FAILURE_EXIT_CODE
      }
    })
}

export function evidenceCreateDefaultDependencies(): EvidenceCreateDependencies {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    readFile: (filePath: string) => readFile(filePath, 'utf8'),
    lintText: defaultLintText,
    writeWorkbook: writeEvidenceWorkbook,
  }
}

/**
人間向けサマリ (contracts §1)。除外が無いときは除外ブロックを出さない。
*/
function writeHumanSummary(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write は mutate メソッド
  stdout: NodeJS.WritableStream,
  data: Readonly<EvidenceCreateResultData>,
): void {
  writeData(stdout, `生成しました: ${data.outPath}`)
  writeData(stdout, `項目数: ${data.items.toString()} / 注記数: ${data.annotations.toString()}`)
  if (data.skipped.length === 0) {
    return
  }

  writeData(stdout, `除外: ${data.skipped.length.toString()} 件`)
  for (const entry of data.skipped) {
    writeData(stdout, `  - ${entry.path} (${entry.reason})`)
  }
}

/**
検証エラーは全件列挙する (どれを直せば通るかを 1 回の実行で示す)。
*/
function formatSpecErrors(errors: readonly SpecValidationError[]): string {
  return errors
    .map(error => `  - ${error.path === '' ? '(root)' : error.path}: ${error.message}`)
    .join('\n')
}

function optionString(value: unknown, fallback: string): string {
  /* c8 ignore next -- requiredOption と既定値により commander が非 string を通さない、防御網のみ */
  return typeof value === 'string' ? value : fallback
}

function doesArgvWantJson(argv: readonly string[]): boolean {
  return argv.includes('--json')
}

export function errorToReason(error: unknown): string {
  if (error instanceof EvidenceCreateError) return error.reason
  if (error instanceof EvidenceWorkbookError) return error.reason
  /* c8 ignore next -- 上記 2 種以外の throw は実装内に存在しない、防御網のみ */
  return 'unknown'
}

/**
`--json` のエラーイベントと MCP の data に載せる内容。CLI と MCP が同じ組み立てを使う。
*/
export function errorData(error: unknown): Readonly<Record<string, unknown>> {
  const violations = error instanceof EvidenceCreateError ? error.violations : undefined
  return {
    event: ERROR_EVENT,
    reason: errorToReason(error),
    detail: formatError(error),
    ...(violations !== undefined && { violations }),
  }
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */
