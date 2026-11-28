// 失敗の原因の名前。MCP の結果の kind に入る。pecot-workflow と actions の定義書の exit_status[].kind の集合と一致させる（tests/failure-kinds-definition.test.ts）。
// eslint-disable-next-line no-restricted-syntax -- 配列から型を作るための as const
export const FAILURE_KINDS = [
  'invalid-input',
  'aborted',
  'github-auth',
  'github-not-found',
  'github-rate-limit',
  'github-api',
  'github-mcp-shape',
  'config-invalid',
  'project-root-not-found',
  'session-directory-unresolved',
  'no-active-project',
  'project-not-found',
  'not-initialized',
  'already-exists',
  'repo-not-in-project',
  'repo-setting-missing',
  'repo-mismatch',
  'git-unresolved',
  'status-not-configured',
  'not-ready',
  'dependency-unreadable',
  'order-conflict',
  'content-invalid',
  'preflight-failed',
  'pr-state',
  'git-conflict',
  'partial-failure',
  'other',
] as const

export type FailureKind = typeof FAILURE_KINDS[number]
