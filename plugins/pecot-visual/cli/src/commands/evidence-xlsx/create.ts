// evidence_create ツールの実装。drawio/url.ts と同形の DI を採用する。
//
// 失敗する場合:
//   spec の読込・parse・検証エラー、文面の違反、有効画像 0 件、xlsx の書き出し失敗。
//   入力不正・文面の違反・有効画像 0 件では、出力に触れない。
//   output-write-failed では、部分生成物が残り得る。
// 除外警告があっても、有効画像が 1 件以上あれば成功とする。

/* eslint-disable security/detect-non-literal-fs-filename -- input / out はツールの引数として受理する仕様 */
import type { FailureReason } from '../../domain/_shared/failure-kind.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { collectTextViolations, formatTextViolations } from '../../domain/_shared/text-check.js'
import type { LintText, TextViolation } from '../../domain/_shared/text-check.js'
import type { EvidenceSpec, NormalizedEvidenceSpec, SpecValidationError } from '../../domain/evidence-xlsx/spec-schema.js'
import { parseEvidenceSpec } from '../../domain/evidence-xlsx/spec-schema.js'
import { specTexts } from '../../domain/evidence-xlsx/spec-text.js'
import type { EvidenceSkippedImage, EvidenceWriteResult } from '../../infra/evidence-xlsx/workbook-writer.js'
import { EvidenceWorkbookError, writeEvidenceWorkbook } from '../../infra/evidence-xlsx/workbook-writer.js'
import { defaultLintText } from '../../infra/text-lint.js'

/**
エラーの event 名。契約に定義が無いため drawio 同形の `<command>.error` に揃える。
*/
const ERROR_EVENT = 'evidence.create.error'

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
      `cannot read spec JSON: ${inputPath}: ${formatError(error)}`,
      'input-not-found',
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch (error: unknown) {
    throw new EvidenceCreateError(
      `cannot parse spec JSON: ${inputPath}: ${formatError(error)}`,
      'invalid-json',
    )
  }

  const parsed = parseEvidenceSpec(raw)
  if (!parsed.ok) {
    throw new EvidenceCreateError(
      `spec validation failed (${parsed.errors.length.toString()} errors)\n${formatSpecErrors(parsed.errors)}`,
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
      `text rules check failed: ${formatError(error)}`,
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
成功の結果。

event 名が `evidence.create.done` ではなく `result` なのは、従来の外形に合わせたため。
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
xlsx を生成し、結果オブジェクトを返す。MCP ツールがこの関数を呼ぶ。
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
検証エラーは全件列挙する (どれを直せば通るかを 1 回の実行で示す)。
*/
function formatSpecErrors(errors: readonly SpecValidationError[]): string {
  return errors
    .map(error => `  - ${error.path === '' ? '(root)' : error.path}: ${error.message}`)
    .join('\n')
}

export function errorToReason(error: unknown): FailureReason {
  if (error instanceof EvidenceCreateError) return error.reason
  if (error instanceof EvidenceWorkbookError) return error.reason
  /* c8 ignore next -- 上記 2 種以外の throw は実装内に存在しない、防御網のみ */
  return 'unknown'
}

/**
失敗時にツールの data に載せる内容。
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
