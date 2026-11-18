// S3 系のツール定義。取得方向は入力の型で固定され（research R7）、残る上書き規則だけを実行前拒否で見る。

import { z } from 'zod'

import { S3API_GET_OBJECT, S3_CP, S3_LS } from '../../domain/allowlist.js'
import { doesFileExist, isDirectory } from '../../infra/local-file.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  awsTimestamp,
  COMMON_INPUT_SHAPE,
  type PreExecutionRejection,
  type ResponseShape,
  type ToolOptions,
} from './_shared.js'

function getObject(description: string): string {
  return `${description} (S3 GetObject response)`
}

/**
GetObject の応答の最上位のキー。Body は awscli が outfile に書き、出力から外す。
*/
const GET_OBJECT_RESPONSE: ResponseShape = {
  DeleteMarker: z.boolean().describe(getObject('Whether the object is a delete marker')),
  AcceptRanges: z.string().describe(getObject('Range unit the object accepts')),
  Expiration: z.string().describe(getObject('Expiration by the lifecycle rule')),
  Restore: z.string().describe(getObject('Restore state of an archived object')),
  LastModified: awsTimestamp(getObject('Last modified time')),
  ContentLength: z.number().describe(getObject('Body size in bytes')),
  ETag: z.string().describe(getObject('Entity tag')),
  ChecksumCRC32: z.string().describe(getObject('CRC32 checksum')),
  ChecksumCRC32C: z.string().describe(getObject('CRC32C checksum')),
  ChecksumCRC64NVME: z.string().describe(getObject('CRC64NVME checksum')),
  ChecksumSHA1: z.string().describe(getObject('SHA1 checksum')),
  ChecksumSHA256: z.string().describe(getObject('SHA256 checksum')),
  ChecksumSHA512: z.string().describe(getObject('SHA512 checksum')),
  ChecksumMD5: z.string().describe(getObject('MD5 checksum')),
  ChecksumXXHASH64: z.string().describe(getObject('XXHASH64 checksum')),
  ChecksumXXHASH3: z.string().describe(getObject('XXHASH3 checksum')),
  ChecksumXXHASH128: z.string().describe(getObject('XXHASH128 checksum')),
  ChecksumType: z.string().describe(getObject('Checksum type')),
  MissingMeta: z.number().describe(getObject('Number of metadata entries not returned in headers')),
  VersionId: z.string().describe(getObject('Version ID')),
  CacheControl: z.string().describe(getObject('Cache-Control header')),
  ContentDisposition: z.string().describe(getObject('Content-Disposition header')),
  ContentEncoding: z.string().describe(getObject('Content-Encoding header')),
  ContentLanguage: z.string().describe(getObject('Content-Language header')),
  ContentRange: z.string().describe(getObject('Range of the returned part')),
  ContentType: z.string().describe(getObject('Content-Type header')),
  Expires: z.string().describe(getObject('Expires header')),
  WebsiteRedirectLocation: z.string().describe(getObject('Website redirect location')),
  ServerSideEncryption: z.string().describe(getObject('Server-side encryption algorithm')),
  Metadata: z.record(z.string(), z.string()).describe(getObject('User-defined metadata')),
  SSECustomerAlgorithm: z.string().describe(getObject('SSE-C algorithm')),
  SSECustomerKeyMD5: z.string().describe(getObject('MD5 of the SSE-C key')),
  SSEKMSKeyId: z.string().describe(getObject('KMS key ID used for encryption')),
  BucketKeyEnabled: z.boolean().describe(getObject('Whether an S3 Bucket Key is used')),
  StorageClass: z.string().describe(getObject('Storage class')),
  RequestCharged: z.string().describe(getObject('Whether the requester was charged')),
  ReplicationStatus: z.string().describe(getObject('Replication status')),
  PartsCount: z.number().describe(getObject('Number of parts of a multipart object')),
  TagCount: z.number().describe(getObject('Number of tags')),
  ObjectLockMode: z.string().describe(getObject('Object Lock mode')),
  ObjectLockRetainUntilDate: awsTimestamp(getObject('Object Lock retention end')),
  ObjectLockLegalHoldStatus: z.string().describe(getObject('Object Lock legal hold status')),
  ObjectLockEventHold: z.string().describe(getObject('Object Lock event hold')),
  ObjectLockEventHoldDurationDays: z.number().describe(getObject('Object Lock event hold duration in days')),
  ObjectLockEventHoldDurationYears: z.number().describe(getObject('Object Lock event hold duration in years')),
}

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
書き出し先を実行前に見る（research R7）。ディレクトリは overwrite に依らず拒否する。`/dir/k` に書かれ、file の `/dir` とずれるため。
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
成功時に file の項目へ載せる書き出し先。
*/
function fileOfTarget(
  name: TargetName,
): (arguments_: Readonly<Record<string, unknown>>) => string | undefined {
  return arguments_ => targetOf(arguments_, name)
}

const OVERWRITE_INPUT = z.boolean().default(false)
  .describe('If true, overwrites the destination even if it already exists')

export function s3Tools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: S3_LS,
      title: 'List S3',
      description: 'Lists the entries directly under a bucket or prefix. Omit s3_uri to list buckets. The command has no JSON output, so results are returned per line in lines',
      inputSchema: z.object({
        s3_uri: z.string().optional().describe('Target to list (s3://bucket or s3://bucket/prefix/). If omitted, lists buckets'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: S3_CP,
      title: 'Get S3 object',
      description: 'Downloads one S3 object to a local absolute path, returned in file. Uploads and recursive copy are not exposed',
      inputSchema: z.object({
        s3_uri: z.string().describe('Source (s3://bucket/key)'),
        local_path: z.string().describe('Local absolute path to write to'),
        overwrite: OVERWRITE_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
      reject: rejectExistingTarget('local_path'),
      fileOf: fileOfTarget('local_path'),
    }, options),
    allowlistedTool({
      entry: S3API_GET_OBJECT,
      title: 'Get S3 object (with metadata)',
      description: 'Gets an object by bucket and key and returns its metadata as JSON, with the written path in file. Use version_id to pick a version and range for a partial download',
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
      fileOf: fileOfTarget('outfile'),
      responseShape: GET_OBJECT_RESPONSE,
    }, options),
  ]
}
