// S3 系のツール定義。
//
// 取得方向（S3 → ローカル）は入力の型で固定されており、逆方向は表現できない（research R7）。
// 残る上書き規則だけを実行前拒否（reject）で見て、書き出し先を artifacts に載せる。

import { z } from 'zod'

import { S3API_GET_OBJECT, S3_CP, S3_LS } from '../../domain/allowlist.js'
import { doesFileExist, isDirectory } from '../../infra/local-file.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  type PreExecutionRejection,
  type ToolOptions,
} from './_shared.js'

/**
書き出し先を指す入力の名前。ツールごとに 1 つだけ持つ。
*/
type TargetName = 'local_path' | 'outfile'

function targetOf(
  arguments_: Readonly<Record<string, unknown>>,
  name: TargetName,
): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- name は本ファイルの TargetName リテラル 2 値のみ
  const value = arguments_[name]
  return typeof value === 'string' ? value : undefined
}

/**
書き出し先を実行前に見る（research R7 の Edge Case）。

ディレクトリは overwrite に依らず拒否する。
`aws s3 cp s3://b/k /dir` は `/dir/k` を書く。
「上書きするなら overwrite に true を」の案内どおりに再実行しても、artifacts に載る書き出し先（`/dir`）と実体がずれたまま成功してしまう。

既存ファイルは overwrite が無ければ拒否する。書き出し先が未指定・非文字列のときは undefined を
返し、必須入力の検証へ委ねる。
*/
function rejectExistingTarget(
  name: TargetName,
): (arguments_: Readonly<Record<string, unknown>>) => PreExecutionRejection | undefined {
  return (arguments_) => {
    const target = targetOf(arguments_, name)
    if (target === undefined) return

    if (isDirectory(target)) {
      return {
        category: 'invalid-input',
        message: `${name} にディレクトリは指定できません。書き出すファイルの絶対パスを指定してください: ${target}`,
      }
    }

    if ((arguments_['overwrite'] === true) || !doesFileExist(target)) return

    return {
      category: 'invalid-input',
      message: `${name} は既に存在します。上書きするなら overwrite に true を指定してください: ${target}`,
    }
  }
}

/**
成功時に artifacts へ載せる書き出し先。
*/
function artifactsOfTarget(
  name: TargetName,
): (arguments_: Readonly<Record<string, unknown>>) => readonly string[] {
  return (arguments_) => {
    const target = targetOf(arguments_, name)
    return target === undefined ? [] : [target]
  }
}

const OVERWRITE_INPUT = z.boolean().default(false)
  .describe('true なら書き出し先が既にあっても上書きする')

export function s3Tools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: S3_LS,
      title: 'S3 の一覧',
      description: 'バケットまたは prefix の直下を一覧する。s3_uri を省略するとバケット一覧を返す。JSON 出力を持たないコマンドのため data.lines に行単位で返る',
      inputSchema: z.object({
        s3_uri: z.string().optional().describe('一覧する対象（s3://bucket または s3://bucket/prefix/）。省略時はバケット一覧'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: S3_CP,
      title: 'S3 オブジェクトの取得',
      description: 'S3 のオブジェクト 1 件をローカルの絶対パスへ取得する。アップロード方向と再帰コピーは公開していない',
      inputSchema: z.object({
        s3_uri: z.string().describe('取得元（s3://bucket/key の形式）'),
        local_path: z.string().describe('書き出し先のローカル絶対パス'),
        overwrite: OVERWRITE_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
      reject: rejectExistingTarget('local_path'),
      artifactsOf: artifactsOfTarget('local_path'),
    }, options),
    allowlistedTool({
      entry: S3API_GET_OBJECT,
      title: 'S3 オブジェクトの取得（メタデータ付き）',
      description: 'バケットとキーを指定してオブジェクトを取得し、メタデータを JSON で返す。version_id でバージョン指定、range で部分取得ができる',
      inputSchema: z.object({
        bucket: z.string().describe('バケット名'),
        key: z.string().describe('オブジェクトキー'),
        outfile: z.string().describe('書き出し先のローカル絶対パス'),
        version_id: z.string().optional().describe('取得するバージョン ID'),
        range: z.string().optional().describe('取得するバイト範囲（bytes=0-1023 の形式）'),
        overwrite: OVERWRITE_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
      reject: rejectExistingTarget('outfile'),
      artifactsOf: artifactsOfTarget('outfile'),
    }, options),
  ]
}
