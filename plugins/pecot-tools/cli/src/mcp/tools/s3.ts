// S3 系のツール定義。取得方向は入力の型で固定され（research R7）、残る上書き規則だけを実行前拒否で見る。

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
書き出し先を実行前に見る（research R7）。ディレクトリは overwrite に依らず拒否する。`/dir/k` に書かれ、artifacts の `/dir` とずれるため。
*/
function rejectExistingTarget(
  name: TargetName,
): (arguments_: Readonly<Record<string, unknown>>) => PreExecutionRejection | undefined {
  return (arguments_) => {
    const target = targetOf(arguments_, name)
    if (target === undefined) return

    if (isDirectory(target)) {
      return {
        kind: 'invalid-input',
        message: `${name} must not be a directory. Specify the absolute path of the file to write: ${target}`,
      }
    }

    if ((arguments_['overwrite'] === true) || !doesFileExist(target)) return

    return {
      kind: 'invalid-input',
      message: `${name} already exists. To overwrite, set overwrite to true: ${target}`,
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
  .describe('If true, overwrites the destination even if it already exists')

export function s3Tools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: S3_LS,
      title: 'List S3',
      description: 'Lists the entries directly under a bucket or prefix. Omit s3_uri to list buckets. The command has no JSON output, so results are returned per line in data.lines',
      inputSchema: z.object({
        s3_uri: z.string().optional().describe('Target to list (s3://bucket or s3://bucket/prefix/). If omitted, lists buckets'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: S3_CP,
      title: 'Get S3 object',
      description: 'Downloads one S3 object to a local absolute path. Uploads and recursive copy are not exposed',
      inputSchema: z.object({
        s3_uri: z.string().describe('Source (s3://bucket/key)'),
        local_path: z.string().describe('Local absolute path to write to'),
        overwrite: OVERWRITE_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
      reject: rejectExistingTarget('local_path'),
      artifactsOf: artifactsOfTarget('local_path'),
    }, options),
    allowlistedTool({
      entry: S3API_GET_OBJECT,
      title: 'Get S3 object (with metadata)',
      description: 'Gets an object by bucket and key and returns its metadata as JSON. Use version_id to pick a version and range for a partial download',
      inputSchema: z.object({
        bucket: z.string().describe('Bucket name'),
        key: z.string().describe('Object key'),
        outfile: z.string().describe('Local absolute path to write to'),
        version_id: z.string().optional().describe('Version ID to get'),
        range: z.string().optional().describe('Byte range to get (bytes=0-1023)'),
        overwrite: OVERWRITE_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
      reject: rejectExistingTarget('outfile'),
      artifactsOf: artifactsOfTarget('outfile'),
    }, options),
  ]
}
