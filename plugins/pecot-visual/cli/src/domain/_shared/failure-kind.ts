// MCP ツールが失敗の結果の `kind`（と `data.reason`）で返しうる名前の一覧。
// 定義書の exit_status[].kind の集合との一致は、failure-kinds-definition.test.ts が確かめる。

// eslint-disable-next-line no-restricted-syntax -- 名前の一覧から型を作るため、要素をリテラルの型のまま残す
export const FAILURE_KINDS = [
  'broken-reference',
  'cancelled',
  'chromium-host-deps-missing',
  'chromium-install-failed',
  'chromium-not-installed',
  'copy-failed',
  'dest-exists',
  'dev-server-cancelled',
  'dev-server-exited',
  'dev-server-port-in-use',
  'dev-server-spawn-failed',
  'dev-server-timeout',
  'dir-not-found',
  'eslint-failed',
  'eslint-not-launched',
  'eslint-timeout',
  'export-failed',
  'file-exists',
  'icon-unresolved',
  'input-not-found',
  'invalid-file-name',
  'invalid-json',
  'invalid-option',
  'invalid-output-extension',
  'invalid-path',
  'invalid-report',
  'invalid-spec',
  'invalid-staging-json',
  'invalid-theme',
  'merge-failed',
  'migrate-failed',
  'no-valid-images',
  'node-modules-unresolved',
  'not-a-directory',
  'not-talk-dir',
  'numeric-filename-prefix',
  'output-write-failed',
  'pptx-convert-failed',
  'pptx-convert-timeout',
  'project-not-found',
  'reference-read-failed',
  'runtime-dependencies-not-installed',
  'runtime-install-failed',
  'skeleton-unavailable',
  'slides-md-not-found',
  'slidev-build-failed',
  'slidev-build-timeout',
  'symlink-failed',
  'talk-dir-not-found',
  'text-lint-failed',
  'text-violation',
  'theme-auth',
  'theme-connection',
  'theme-install',
  'theme-invalid-shape',
  'theme-name-mismatch',
  'theme-none',
  'theme-required',
  'theme-root',
  'theme-semver-range',
  'theme-tag',
  'theme-tag-format',
  'theme-tag-required',
  'theme-unknown',
  'theme-unknown-rule',
  'theme-unlinked',
  'theme-unsupported-spec',
  'theme-with-node-modules-only',
  'unknown',
  'unknown-layout',
  'write-failed',
] as const

export type FailureKind = typeof FAILURE_KINDS[number]

// CLI の引数の解釈と、MCP ツールの無いコマンド（pptx preview）だけが `--json` の reason に出す名前。
// MCP は引数を inputSchema と parsePathArguments で先に確かめるため、これらは返らない。
// eslint-disable-next-line no-restricted-syntax -- 名前の一覧から型を作るため、要素をリテラルの型のまま残す
export const CLI_ONLY_FAILURE_REASONS = [
  'input-mutated',
  'input-open-failed',
  'invalid-mode',
  'invalid-morph-option',
  'invalid-transition-duration-ms',
  'invalid-transition-type',
  'missing-icons-root',
  'missing-option',
  'relative-dir',
  'soffice-conversion-failed',
  'soffice-not-found',
  'soffice-timeout',
] as const

/**
CLI の `--json` と MCP の `data.reason` に載る失敗の名前。
*/
export type FailureReason = FailureKind | typeof CLI_ONLY_FAILURE_REASONS[number]

export function isFailureKind(reason: string): reason is FailureKind {
  return FAILURE_KINDS.some(kind => kind === reason)
}

/**
MCP の結果の `kind`。CLI だけの名前は MCP に届かないが、届いたときは `unknown` にする。
*/
export function failureKindOf(reason: FailureReason): FailureKind {
  return isFailureKind(reason) ? reason : 'unknown'
}
