/**
infra が警告・エラーを伝える受け口。呼ぶ側（commands）が渡す。
`src/commands/output.ts` の `Output` がそのまま満たす。前置き（`warning:`・`error:`）と字下げは受け口の側が付ける
*/
export interface Diagnostics {
  readonly warning: (message: string) => void
  readonly error: (message: string) => void
}
