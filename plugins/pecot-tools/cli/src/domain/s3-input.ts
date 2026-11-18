// S3 の入力値（一覧 URI）の書式検証。書式は contracts/mcp-tools.md の正規表現を写す。
// 戻り値は入力名に続く述部で、助詞の前の空白の要否を 1 箇所に寄せるため、連結は arguments.ts が行う。

/**
`aws_s3_ls` の一覧対象。バケット一覧（`s3://`）と prefix 指定の双方を許す（契約表 aws_s3_ls）。
*/
// eslint-disable-next-line security/detect-unsafe-regex -- 前半の [^/]* と後半の '/' 以降は排他で backtracking しない
const S3_LIST_URI = /^s3:\/\/[^/]*(?:\/.*)?$/

/**
`s3 ls` の位置引数として妥当か（バケット一覧・prefix 指定の双方を許す）。
*/
export function validateS3ListUri(value: string): string | undefined {
  return S3_LIST_URI.test(value) ? undefined : 'must be in the form s3://<bucket>[/<prefix>]'
}
