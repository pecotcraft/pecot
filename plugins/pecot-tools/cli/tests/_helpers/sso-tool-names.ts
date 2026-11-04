// 許可リストに載らない SSO の 2 件（tools/list では契約表どおり先頭に来る）。
//
// contract.test.ts / index.test.ts / mcp-stdio.test.ts の 3 箇所で同じ配列を作っていたのを
// ここへ集約する。knip の project 設定（tests/**/*.ts を含む）の対象なので、テスト専用でも
// 未使用エクスポート扱いにはならない。
export const SSO_TOOL_NAMES: readonly string[] = ['aws_sso_login', 'aws_sso_login_status']
