import { describe, expect, it } from 'vitest'

import { createRepositoryReference } from '../repository-resolver.js'
import type { ResolvedRepository } from '../repository-resolver.js'
import { applyRepositoryPolicy } from '../repository-policy.js'
import type { PolicyMode } from '../repository-policy.js'

const CURRENT: ResolvedRepository = { repository: createRepositoryReference('acme-labs', 'pecot-cli'), source: 'current-git', remoteName: 'origin' }
const EXPLICIT_SOURCE: ResolvedRepository = { repository: createRepositoryReference('x', 'y'), source: 'explicit', remoteName: undefined }

const AMBIGUOUS_LINES = ['error: the repository is ambiguous', '  give --repo <owner/repo>']

describe.each<PolicyMode>(['reject', 'warn'])('mode=%s で共通の分岐', (mode) => {
  it('--repo 無し + Git 外は曖昧で終了コード 1', () => {
    expect(applyRepositoryPolicy({ explicit: undefined, resolved: undefined, mode })).toStrictEqual({ kind: 'exit', exitCode: 1, stderr: AMBIGUOUS_LINES })
  })

  it('--repo 無し + Git 内は従来挙動で続行（採用値なし）', () => {
    expect(applyRepositoryPolicy({ explicit: undefined, resolved: CURRENT, mode })).toStrictEqual({ kind: 'proceed', adopted: undefined, stderr: [] })
  })

  it('明示値あり + Git 外は明示値を採用して続行', () => {
    const result = applyRepositoryPolicy({ explicit: 'acme-labs/aist-plugin', resolved: undefined, mode })
    expect(result).toStrictEqual({ kind: 'proceed', adopted: { owner: 'acme-labs', repository: 'aist-plugin' }, stderr: [] })
  })

  it('明示値あり + 解決が current-git でなければ、比較せず明示値を採用する', () => {
    const result = applyRepositoryPolicy({ explicit: 'a/b', resolved: EXPLICIT_SOURCE, mode })
    expect(result).toStrictEqual({ kind: 'proceed', adopted: { owner: 'a', repository: 'b' }, stderr: [] })
  })

  it('明示値と current-git が一致すれば採用して続行', () => {
    const result = applyRepositoryPolicy({ explicit: 'acme-labs/pecot-cli', resolved: CURRENT, mode })
    expect(result).toStrictEqual({ kind: 'proceed', adopted: { owner: 'acme-labs', repository: 'pecot-cli' }, stderr: [] })
  })

  it('明示値の形式が不正なら repr 付きで終了コード 1', () => {
    expect(applyRepositoryPolicy({ explicit: 'not-a-repo', resolved: undefined, mode })).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      stderr: ['error: --repo has an invalid form: \'not-a-repo\''],
    })
  })

  it('セグメントが不正でも形式エラー（引用符を含む値は Python の repr に合わせる）', () => {
    expect(applyRepositoryPolicy({ explicit: 'a/b c', resolved: undefined, mode })).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      stderr: ['error: --repo has an invalid form: \'a/b c\''],
    })
    expect(applyRepositoryPolicy({ explicit: 'it\'s/x', resolved: undefined, mode })).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      stderr: ['error: --repo has an invalid form: "it\'s/x"'],
    })
  })
})

describe('不一致', () => {
  it('reject は 2 行を出して終了コード 1（採用しない）', () => {
    const result = applyRepositoryPolicy({ explicit: 'acme-labs/aist-plugin', resolved: CURRENT, mode: 'reject' })
    expect(result).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      stderr: [
        'error: --repo acme-labs/aist-plugin differs from the current Git remote (acme-labs/pecot-cli)',
        '  worktree and branch commands are rejected to protect the local Git state',
      ],
    })
  })

  it('warn は警告を出して明示値を採用し、続行する', () => {
    const result = applyRepositoryPolicy({ explicit: 'acme-labs/aist-plugin', resolved: CURRENT, mode: 'warn' })
    expect(result).toStrictEqual({
      kind: 'proceed',
      adopted: { owner: 'acme-labs', repository: 'aist-plugin' },
      stderr: ['warning: using --repo acme-labs/aist-plugin (current Git remote: acme-labs/pecot-cli)'],
    })
  })

  it('owner だけ、repository だけが違っても不一致', () => {
    expect(applyRepositoryPolicy({ explicit: 'other/pecot-cli', resolved: CURRENT, mode: 'reject' }).kind).toBe('exit')
    expect(applyRepositoryPolicy({ explicit: 'acme-labs/other', resolved: CURRENT, mode: 'reject' }).kind).toBe('exit')
  })

  it('大文字小文字は区別する', () => {
    expect(applyRepositoryPolicy({ explicit: 'Acme-labs/pecot-cli', resolved: CURRENT, mode: 'reject' }).kind).toBe('exit')
  })
})
