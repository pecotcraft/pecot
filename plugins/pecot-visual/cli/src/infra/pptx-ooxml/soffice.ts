// soffice (LibreOffice headless) を PdfConverter ポートに適合させるアダプタ。
// `pecotv pptx preview` がプレビュー正規化済みの一時 PPTX を PDF にレンダリングする。
//
// 成否判定の注意点 (tech-advisor 実機再現)。
//   - soffice は変換失敗でも exit 0 を返す (`Error: source file could not be loaded` でも exitCode=0・outdir 空)。
//     そのため exit code だけでなく、「期待 PDF が実在し非空」を必須条件とする。
//     判定は呼び出し元 (commands 層) の責務。
//   - soffice 不在時は、spawnPromise が exitCode: null + ENOENT を stderr に詰める契約。
//     これも commands 層が soffice-not-found にマップする。
//
// SofficePdfConverter 本体は e2e でのみ実行されるため `/* c8 ignore */` で coverage 90%
// 閾値を担保する。buildSofficeArguments は pure export として unit でカバーする。

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  PdfConvertArguments,
  PdfConvertResult,
  PdfConverter,
} from '../../domain/_shared/ports.js'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import { spawnPromise } from '../_shared/process.js'

/**
soffice の convert-to pdf 引数を構築する。

`-env:UserInstallation=file://<profile>` で profile dir を分離し、
同一 profile を共有する soffice の並行起動ロック競合を避ける。
残りは非対話 PDF 変換のための定型引数。
定型引数は次の 2 組。
`--headless --norestore --nofirststartwizard --nologo --nolockcheck`。
`--convert-to pdf --outdir <outDir> <input>`。
*/
export function buildSofficeArguments(input: {
  readonly profileDirectory: string
  readonly outputDirectory: string
  readonly inputPath: string
}): readonly string[] {
  return [
    `-env:UserInstallation=file://${input.profileDirectory}`,
    '--headless',
    '--norestore',
    '--nofirststartwizard',
    '--nologo',
    '--nolockcheck',
    '--convert-to',
    'pdf',
    '--outdir',
    input.outputDirectory,
    input.inputPath,
  ]
}

/**
入力 PPTX の stem から soffice が出力する PDF path を導出する。
*/
export function sofficePdfPath(outputDirectory: string, inputPath: string): string {
  const stem = path.basename(inputPath, path.extname(inputPath))
  return path.join(outputDirectory, `${stem}.pdf`)
}

/* c8 ignore start -- soffice 子プロセス起動は e2e でのみ実行。unit は buildSofficeArguments / sofficePdfPath をカバー */
export class SofficePdfConverter implements PdfConverter {
  async convertToPdf(

    arguments_: Readonly<PdfConvertArguments>,
  ): Promise<PdfConvertResult> {
    // soffice の profile dir は input/out とは別の mkdtemp 配下へ分離し finally で削除する
    // (同一 profile の並行起動ロック競合回避)。
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'pecotv-soffice-profile-'))
    try {
      const sofficeArguments = buildSofficeArguments({
        profileDirectory,
        outputDirectory: arguments_.outputDirectory,
        inputPath: arguments_.inputPath,
      })
      const result: SpawnResult = await spawnPromise('soffice', sofficeArguments, {
        timeoutMs: arguments_.timeoutMs,
      })
      if (result.exitCode === null && result.timedOut) {
        throw new SofficeTimeoutError(arguments_.timeoutMs)
      }
      if (result.exitCode === null) {
        throw new SofficeSpawnError(result.stderr)
      }
      return { pdfPath: sofficePdfPath(arguments_.outputDirectory, arguments_.inputPath) }
    }
    finally {
      await rm(profileDirectory, { recursive: true, force: true })
    }
  }
}

/**
soffice の起動自体に失敗した (exitCode: null かつ timeout でない = ENOENT 等) ことを表す。
commands 層が soffice-not-found にマップする。
*/
export class SofficeSpawnError extends Error {
  constructor(readonly stderr: string) {
    super(`soffice の起動に失敗しました: ${stderr}`)
    this.name = 'SofficeSpawnError'
  }
}

/**
soffice の PDF 変換が timeout (SIGTERM = exitCode: null かつ timedOut) したことを表す。
commands 層が soffice-timeout にマップする。SofficeSpawnError (起動失敗 = soffice 不在)
とは別の流れで、apt-get 案内は出さない。
*/
export class SofficeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`soffice の PDF 変換が ${String(timeoutMs)}ms でタイムアウトしました`)
    this.name = 'SofficeTimeoutError'
  }
}
/* c8 ignore stop */
