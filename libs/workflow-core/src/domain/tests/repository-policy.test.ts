import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { formatHinted } from '../command-hint.js'
import { createRepositoryReference } from '../repository-resolver.js'
import type { ResolvedRepository, UnreadableRemote } from '../repository-resolver.js'
import { applyRepositoryPolicy } from '../repository-policy.js'
import type { PolicyInput, PolicyMode } from '../repository-policy.js'

const CURRENT: ResolvedRepository = { repository: createRepositoryReference('acme-labs', 'pecot-cli'), source: 'current-git', remoteName: 'origin' }
const EXPLICIT_SOURCE: ResolvedRepository = { repository: createRepositoryReference('x', 'y'), source: 'explicit', remoteName: undefined }

const AMBIGUOUS_LINES = ['error: the repository is ambiguous', '  give repo: <owner/repo>']

// stderr の行を MCP の形に描いて比べる
function policy(input: PolicyInput): unknown {
  const outcome = applyRepositoryPolicy(input)
  return { ...outcome, stderr: outcome.stderr.map(line => formatHinted(line)) }
}

describe.each<PolicyMode>(['reject', 'warn'])('mode=%s で共通の分岐', (mode) => {
  it('repo を指定せず、Git リポジトリの外で実行すると、曖昧として終了コード 1 で終了する', async () => {
    await explains('リポジトリの扱いを決める `applyRepositoryPolicy` のテストです。`reject` と `warn` のどちらのモードでも、`repo` の指定がなく、Git リポジトリの外で実行した場合に、リポジトリが曖昧だとして終了コード 1 で終了することを確認します。')
    expect(policy({ explicit: undefined, resolved: undefined, mode })).toStrictEqual({ kind: 'exit', exitCode: 1, failure: 'git-unresolved', stderr: AMBIGUOUS_LINES })
  })

  it('repo を指定せず、Git リポジトリの中で実行すると、現在のリポジトリのまま続行する', async () => {
    await explains('`repo` の指定がなく、Git リポジトリの中で実行した場合のテストです。採用するリポジトリを決めず、警告も出さずに、そのまま続行することを確認します。')
    expect(policy({ explicit: undefined, resolved: CURRENT, mode })).toStrictEqual({ kind: 'proceed', adopted: undefined, stderr: [] })
  })

  it('repo を指定し、Git リポジトリの外で実行すると、指定したリポジトリを採用して続行する', async () => {
    await explains('`repo` を指定し、Git リポジトリの外で実行した場合のテストです。`reject` と `warn` のどちらのモードでも、指定したリポジトリを採用し、警告も出さずに続行することを確認します。')
    const result = policy({ explicit: 'acme-labs/aist-plugin', resolved: undefined, mode })
    expect(result).toStrictEqual({ kind: 'proceed', adopted: { owner: 'acme-labs', repository: 'aist-plugin' }, stderr: [] })
  })

  it('repo を指定し、現在のリポジトリの解決元が current-git でなければ、比較せず指定したリポジトリを採用する', async () => {
    await explains('リポジトリの解決元が、現在の Git の remote ではなく、明示した指定だった場合のテストです。現在のリポジトリと比較せず、`repo` で指定したリポジトリを採用して続行することを確認します。')
    const result = policy({ explicit: 'a/b', resolved: EXPLICIT_SOURCE, mode })
    expect(result).toStrictEqual({ kind: 'proceed', adopted: { owner: 'a', repository: 'b' }, stderr: [] })
  })

  it('repo の指定が現在の Git の remote と一致すれば、そのリポジトリを採用して続行する', async () => {
    await explains('`repo` の指定が、現在の Git の remote のリポジトリと一致する場合のテストです。指定したリポジトリを採用し、警告も出さずに続行することを確認します。')
    const result = policy({ explicit: 'acme-labs/pecot-cli', resolved: CURRENT, mode })
    expect(result).toStrictEqual({ kind: 'proceed', adopted: { owner: 'acme-labs', repository: 'pecot-cli' }, stderr: [] })
  })

  it('repo の形式が不正なら、入力値を引用符で囲んだエラーを出して終了コード 1 で終了する', async () => {
    await explains('`repo` の形式が不正な場合のテストです。`not-a-repo` のように `owner/repo` の形でない値を渡すと、入力値を引用符で囲んだエラーの行を出し、終了コード 1 で終了することを確認します。')
    expect(policy({ explicit: 'not-a-repo', resolved: undefined, mode })).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      failure: 'invalid-input',
      stderr: ['error: repo has an invalid form: \'not-a-repo\''],
    })
  })

  it('owner や repository の部分が不正でも、形式エラーにする（引用符を含む値は Python の repr に合わせる）', async () => {
    await explains('`repo` の owner や repository の部分が不正な場合のテストです。空白を含む値で形式エラーになり、引用符を含む値は、Python の `repr` と同じ二重引用符の表記でエラーの行に出ることを確認します。')
    expect(policy({ explicit: 'a/b c', resolved: undefined, mode })).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      failure: 'invalid-input',
      stderr: ['error: repo has an invalid form: \'a/b c\''],
    })
    expect(policy({ explicit: 'it\'s/x', resolved: undefined, mode })).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      failure: 'invalid-input',
      stderr: ['error: repo has an invalid form: "it\'s/x"'],
    })
  })
})

describe.each<PolicyMode>(['reject', 'warn'])('mode=%s で remote の URL を読めない', (mode) => {
  const UNREADABLE: UnreadableRemote = { source: 'unreadable-remote', remoteName: 'origin' }

  it('remote の URL を読めなくても、repo があれば、警告を出して指定したリポジトリを採用して続行する', async () => {
    await explains('remote の URL からリポジトリを読み取れない場合の、`repo` を指定したときのテストです。読み取れなかった理由を添えた警告の行を出し、指定したリポジトリを採用して続行することを確認します。')
    expect(policy({ explicit: 'acme-labs/aist-plugin', resolved: UNREADABLE, mode })).toStrictEqual({
      kind: 'proceed',
      adopted: { owner: 'acme-labs', repository: 'aist-plugin' },
      stderr: ['warning: using repo acme-labs/aist-plugin (could not read the repository from the URL of the Git remote origin)'],
    })
  })

  it('remote の URL を読めず repo もなければ、曖昧の行に理由の行を添えて終了コード 1 で終了する', async () => {
    await explains('remote の URL からリポジトリを読み取れない場合の、`repo` を指定しないときのテストです。曖昧であることを示すエラーの行に、読み取れなかった理由の行を添えて、終了コード 1 で終了することを確認します。')
    expect(policy({ explicit: undefined, resolved: UNREADABLE, mode })).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      failure: 'git-unresolved',
      stderr: ['error: the repository is ambiguous', '  could not read the repository from the URL of the Git remote origin', '  give repo: <owner/repo>'],
    })
  })

  it('remote の URL を読めない場合も、repo の形式が不正なら、形式のエラー invalid-input を先に出す', async () => {
    await explains('remote の URL を読み取れず、`repo` の形式も不正な場合のテストです。remote の読み取りの失敗より先に、入力値の不正を示す `invalid-input` で終了することを確認します。')
    expect(applyRepositoryPolicy({ explicit: 'not-a-repo', resolved: UNREADABLE, mode })).toMatchObject({ kind: 'exit', failure: 'invalid-input' })
  })

  it.for(['acme-labs/pecot-cli', 'other/tree'])('remote の URL を読めない場合は、repo が %s でも、不一致のエラーにならず続行する', async (explicit) => {
    await explains('remote の URL からリポジトリを読み取れない場合のテストです。現在の remote と同じ名前でも、別の名前でも、比較する相手がないため、`repo-mismatch` にならず続行することを確認します。')
    expect(applyRepositoryPolicy({ explicit, resolved: UNREADABLE, mode }).kind).toBe('proceed')
  })
})

describe('不一致', () => {
  it('reject モードでは、不一致のときにエラーの 2 行を出し、終了コード 1 で終了する', async () => {
    await explains('`reject` モードで、`repo` が現在の Git の remote と異なる場合のテストです。指定したリポジトリは採用せず、不一致を示す 2 行のエラーを出して、終了コード 1 で終了することを確認します。')
    const result = policy({ explicit: 'acme-labs/aist-plugin', resolved: CURRENT, mode: 'reject' })
    expect(result).toStrictEqual({
      kind: 'exit',
      exitCode: 1,
      failure: 'repo-mismatch',
      stderr: [
        'error: repo acme-labs/aist-plugin differs from the current Git remote (acme-labs/pecot-cli)',
        '  this command works only on the repository of the current Git remote',
      ],
    })
  })

  it('warn モードでは、不一致のときに警告を出し、指定したリポジトリを採用して続行する', async () => {
    await explains('`warn` モードで、`repo` が現在の Git の remote と異なる場合のテストです。警告の行を出し、指定したリポジトリを採用して、続行することを確認します。')
    const result = policy({ explicit: 'acme-labs/aist-plugin', resolved: CURRENT, mode: 'warn' })
    expect(result).toStrictEqual({
      kind: 'proceed',
      adopted: { owner: 'acme-labs', repository: 'aist-plugin' },
      stderr: ['warning: using repo acme-labs/aist-plugin (current Git remote: acme-labs/pecot-cli)'],
    })
  })

  it('owner と repository のどちらか一方だけが異なる場合も、不一致として扱う', async () => {
    await explains('部分的に異なる指定のテストです。owner だけが異なる場合と、repository だけが異なる場合のどちらでも、不一致として終了することを確認します。')
    expect(applyRepositoryPolicy({ explicit: 'other/pecot-cli', resolved: CURRENT, mode: 'reject' }).kind).toBe('exit')
    expect(applyRepositoryPolicy({ explicit: 'acme-labs/other', resolved: CURRENT, mode: 'reject' }).kind).toBe('exit')
  })

  it('大文字と小文字が異なる場合は、不一致として扱う', async () => {
    await explains('大文字と小文字の扱いのテストです。`repo` の owner の大文字と小文字だけが、現在の remote と異なる場合も、不一致として終了することを確認します。')
    expect(applyRepositoryPolicy({ explicit: 'Acme-labs/pecot-cli', resolved: CURRENT, mode: 'reject' }).kind).toBe('exit')
  })
})
