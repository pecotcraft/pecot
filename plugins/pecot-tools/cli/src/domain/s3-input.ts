// S3 の入力値（オブジェクト URI・一覧 URI・ローカル出力先）の書式検証。書式は contracts/mcp-tools.md の正規表現を写す。
// 戻り値は入力名に続く述部で、助詞の前の空白の要否を 1 箇所に寄せるため、連結は arguments.ts が行う。

import path from 'node:path'

/**
`aws_s3_cp` の取得元。バケットとキーの双方を要求する（契約表 aws_s3_cp の s3-uri）。
*/
const S3_OBJECT_URI = /^s3:\/\/[^/]+\/.+$/

/**
`aws_s3_ls` の一覧対象。バケット一覧（`s3://`）と prefix 指定の双方を許す（契約表 aws_s3_ls）。
*/
// eslint-disable-next-line security/detect-unsafe-regex -- 前半の [^/]* と後半の '/' 以降は排他で backtracking しない
const S3_LIST_URI = /^s3:\/\/[^/]*(?:\/.*)?$/

/**
ローカルパスに紛れ込んだ S3 URI。大小文字を区別せずに見る。
*/
const S3_SCHEME = /^s3:\/\//i

/**
`s3://<bucket>/<key>` 形式か。空白を含む値は、shell を介さず 1 値で渡るので拒否しない（research R3）。
*/
export function validateS3Uri(value: string): string | undefined {
  return S3_OBJECT_URI.test(value) ? undefined : 'must be in the form s3://<bucket>/<key>'
}

/**
`s3 ls` の位置引数として妥当か（バケット一覧・prefix 指定の双方を許す）。
*/
export function validateS3ListUri(value: string): string | undefined {
  return S3_LIST_URI.test(value) ? undefined : 'must be in the form s3://<bucket>[/<prefix>]'
}

/**
書き出し先のローカルパスとして妥当か。`s3://…` を先に弾くのは、取得元と取り違えた利用者に誤案内しないため。
*/
export function validateLocalPath(value: string): string | undefined {
  if (S3_SCHEME.test(value)) return 'must be a local absolute path (s3:// cannot be a destination)'
  return path.isAbsolute(value) ? undefined : 'must be an absolute path'
}
