// git などの子プロセスの標準入力の扱い。CLI は継承する。
// MCP のサーバでは fd 0 が JSON-RPC のパイプで、子が読むとメッセージを食う。そのため、サーバは起動時に 'ignore' へ切り替える。
export type ChildStdin = 'inherit' | 'ignore'

const state: { mode: ChildStdin } = { mode: 'inherit' }

export function childStdin(): ChildStdin {
  return state.mode
}

export function setChildStdin(mode: ChildStdin): void {
  state.mode = mode
}
