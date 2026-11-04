// S3 の入力値（オブジェクト URI・一覧 URI・ローカル出力先）の書式検証。
//
// research R7 の方向制約は「入力の形で表現できない」ことで担保しているが、値そのものが
// 期待どおりの形かはここで見る。書式は contracts/mcp-tools.md の正規表現を逐語で写す。
//
// 戻り値は「入力名に続く述部」で、入力名と値の連結は arguments.ts が行う（`<name> <述部>: <value>`）。
// 述部に助詞まで含めるのは、`s3://…` のような欧文始まりの語で助詞との間に空白が要るかどうかが
// 語ごとに変わるため。文言の組み立てを 1 箇所に寄せると、規則を足したときに書式が割れない。

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
`s3://<bucket>/<key>` 形式か。

空白を含む値は拒否しない。引数は shell を介さず、1 要素 1 値で awscli へ渡る。
そのため `s3://b/k --recursive` のような値は「そういう名前のキー」として扱われ、
別オプションには化けない（research R3）。
*/
export function validateS3Uri(value: string): string | undefined {
  return S3_OBJECT_URI.test(value) ? undefined : 'は s3://<bucket>/<key> の形式で指定してください'
}

/**
`s3 ls` の位置引数として妥当か（バケット一覧・prefix 指定の双方を許す）。
*/
export function validateS3ListUri(value: string): string | undefined {
  return S3_LIST_URI.test(value) ? undefined : 'は s3://<bucket>[/<prefix>] の形式で指定してください'
}

/**
書き出し先のローカルパスとして妥当か。

`s3://…` を先に見るのは、絶対パスの検証だけでも弾けるが「相対パスだ」という案内になり、
取得元と書き出し先を取り違えた利用者に誤った直し方を促すため。
*/
export function validateLocalPath(value: string): string | undefined {
  if (S3_SCHEME.test(value)) return 'はローカルの絶対パスで指定してください（s3:// は書き出し先にできません）'
  return path.isAbsolute(value) ? undefined : 'は絶対パスで指定してください'
}
