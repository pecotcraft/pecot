/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// github-ops の pr-attach を確かめる。gh は PATH の先頭の偽物で、引数・cwd・環境・cwd のファイルを記録する。
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../libs/workflow-core/tests/_helpers/environment.js'
import { installFakeExecutable, readFakeCalls } from '../../../../libs/workflow-core/tests/_helpers/fake-executables.js'
import type { ResponseRule } from '../../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { makeTemporaryDirectory } from '../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { explains } from '../../_helpers/explains.js'
import { verifies } from '../../_helpers/verifies.js'
import { requestLabels, restRule } from '../../_helpers/github-rules.js'
import { runOperation, writesOf } from '../../_helpers/github-ops-case.js'
import type { OpsResult } from '../../_helpers/github-ops-case.js'

useIsolatedEnvironment()

const REPO = '/repos/acme/demo'
const BRANCH = 'pecot-attach/k3v9q2xa'
const HEAD = 'c'.repeat(40)
const ATTACH_TOKEN = 'github_pat_attach'
const HOUR = 60 * 60 * 1000

interface FakeGh {
  readonly bin: string
  /**
  偽の gh が記録した cwd・GH_TOKEN・GH_HOST・GH_REPO と、cwd のファイルの中身
  */
  readonly seen: () => Readonly<Record<string, string>>
}

// 偽の gh。記録を gh.seen に書き、stderr と終了コードを決める
function fakeGh(options: { readonly stderr?: string, readonly exitCode?: number } = {}): FakeGh {
  const bin = makeTemporaryDirectory('pecot-attach-gh-')
  const seenFile = path.join(bin, 'gh.seen')
  installFakeExecutable(bin, 'gh', [
    String.raw`{ printf 'cwd=%s\n' "$PWD"; printf 'token=%s\n' "$GH_TOKEN"; printf 'host=%s\n' "$GH_HOST"; printf 'repo=%s\n' "$GH_REPO"; for f in *; do printf 'file:%s=%s\n' "$f" "$(cat "$f")"; done; } > '${seenFile}'`,
    `printf '%s' '${options.stderr ?? ''}' >&2`,
    `exit ${String(options.exitCode ?? 0)}`,
    '',
  ].join('\n'))
  return {
    bin,
    seen: () => Object.fromEntries(readFileSync(seenFile, 'utf8').split('\n').filter(line => line !== '').map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at), line.slice(at + 1)]
    })),
  }
}

const referencesOf = (branches: readonly (readonly [string, string])[]): ResponseRule => restRule('GET', `${REPO}/git/matching-refs/heads/pecot-attach/`, 200, branches.map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha, type: 'commit' } })))
const commitAt = (sha: string, hoursAgo: number): ResponseRule => restRule('GET', `${REPO}/git/commits/${sha}`, 200, { sha, committer: { date: new Date(Date.now() - hoursAgo * HOUR).toISOString() } })
const treeOf = (entries: readonly Readonly<Record<string, string>>[]): ResponseRule => restRule('GET', `${REPO}/git/trees/${HEAD}`, 200, { sha: 't'.repeat(40), tree: entries, truncated: false })
const file = (name: string, sha: string): Record<string, string> => ({ path: name, type: 'blob', mode: '100644', sha })
const blob = (sha: string, text: string): ResponseRule => restRule('GET', `${REPO}/git/blobs/${sha}`, 200, { sha, encoding: 'base64', content: `${Buffer.from(text).toString('base64')}\n` })
const deleted = (branch: string): ResponseRule => restRule('DELETE', `${REPO}/git/refs/heads/${branch}`, 204)

interface AttachRun {
  readonly result: OpsResult
  readonly runnerTemporary: string
}

async function attach(rules: readonly ResponseRule[], gh: Readonly<FakeGh>, options: { readonly attachToken?: string, readonly branch?: string } = {}): Promise<AttachRun> {
  const runnerTemporary = realpathSync(makeTemporaryDirectory('pecot-runner-temp-'))
  const result = await runOperation('pr-attach', { pr: 12, branch: options.branch ?? BRANCH }, rules, {
    environment: { RUNNER_TEMP: runnerTemporary },
    inputs: { 'attach-token': options.attachToken ?? ATTACH_TOKEN },
    path: gh.bin,
  })
  return { result, runnerTemporary }
}

describe('github ops', () => {
  it('pr-attach を呼ぶと、ブランチの画像を置いたディレクトリで attach-token の gh を起こし、ブランチを消す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-16')
    await explains('`pr-attach` のテストです。一時ブランチの画像を `RUNNER_TEMP` の下に書き、そのディレクトリで `gh pr edit --attach` を起こします。gh に `attach-token` を渡し、ブランチを消すことを確認します。')
    const gh = fakeGh()
    const rules = [referencesOf([[BRANCH, HEAD]]), treeOf([file('shot.png', 'b1'), file('demo.MP4', 'b2')]), blob('b1', 'PNG-A'), blob('b2', 'MP4-B'), deleted(BRANCH)]
    const { result, runnerTemporary } = await attach(rules, gh)
    expect(result.code).toBe(0)
    expect(result.result).toEqual({ pr: 12, files: ['shot.png', 'demo.MP4'], deleted_branches: [BRANCH] })
    expect(readFakeCalls(gh.bin, 'gh')).toEqual([['pr', 'edit', '12', '--attach', './shot.png', '--attach', './demo.MP4']])
    const seen = gh.seen()
    expect(path.dirname(seen['cwd'] ?? '')).toBe(runnerTemporary)
    expect(seen).toMatchObject({ 'token': ATTACH_TOKEN, 'host': 'github.com', 'repo': 'github.com/acme/demo', 'file:shot.png': 'PNG-A', 'file:demo.MP4': 'MP4-B' })
    expect(existsSync(seen['cwd'] ?? '')).toBe(false)
    expect(writesOf(result.github.requests())).toEqual([`DELETE ${REPO}/git/refs/heads/${BRANCH}`])
    expect(result.stdout).not.toContain(ATTACH_TOKEN)
  })

  it('pr-attach を呼ぶと、渡したブランチのほかの pecot-attach のブランチのうち、24 時間より古いものだけを消す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-17')
    await explains('`pr-attach` の後片付けのテストです。commit が 25 時間前と 1 時間前の `pecot-attach/` のブランチがある場合に、25 時間前のものと渡したブランチだけを消すことを確認します。')
    const gh = fakeGh()
    const old = 'pecot-attach/old00001'
    const fresh = 'pecot-attach/new00001'
    const rules = [
      referencesOf([[old, 'd'.repeat(40)], [BRANCH, HEAD], [fresh, 'e'.repeat(40)]]),
      commitAt('d'.repeat(40), 25),
      commitAt('e'.repeat(40), 1),
      deleted(old),
      treeOf([file('shot.png', 'b1')]),
      blob('b1', 'PNG-A'),
      deleted(BRANCH),
    ]
    const { result } = await attach(rules, gh)
    expect(result.code).toBe(0)
    expect(result.result).toMatchObject({ deleted_branches: [old, BRANCH] })
    expect(writesOf(result.github.requests())).toEqual([`DELETE ${REPO}/git/refs/heads/${old}`, `DELETE ${REPO}/git/refs/heads/${BRANCH}`])
  })

  it('pr-attach の branch が pecot-attach/ で始まらないと、GitHub を呼ばずに invalid-input を返す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-19')
    await explains('`pr-attach` の入力のテストです。`pecot-attach/` で始まらないブランチを渡した場合に、GitHub を呼ばず、ブランチを消さずに `invalid-input` を返すことを確認します。')
    const gh = fakeGh()
    const { result } = await attach([], gh, { branch: 'feat/demo/7' })
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'invalid-input' } })
    expect(result.github.requests()).toEqual([])
    expect(readFakeCalls(gh.bin, 'gh')).toEqual([])
  })

  it.for([
    { name: '直下にファイルが無い', entries: [], reason: 'has no file' },
    { name: 'サブツリーがある', entries: [file('shot.png', 'b1'), { path: 'nested', type: 'tree', mode: '040000', sha: 'f'.repeat(40) }], reason: 'nested is not a file' },
    { name: '受けない拡張子がある', entries: [file('shot.png', 'b1'), file('notes.txt', 'b3')], reason: 'notes.txt is not one of' },
    { name: '受けない名前がある', entries: [file('my shot.png', 'b1')], reason: 'my shot.png has a name other than' },
  ])('pr-attach のブランチに $name と、gh を起こさずに invalid-input を返し、ブランチを消す', async ({ entries, reason }, context) => {
    await verifies(context, 'PA-GITHUB-OPS-18')
    await explains('`pr-attach` の画像の形のテストです。一時ブランチの直下に載せられないものがある場合に、何も載せず、`invalid-input` を返してブランチを消すことを確認します。')
    const gh = fakeGh()
    const { result, runnerTemporary } = await attach([referencesOf([[BRANCH, HEAD]]), treeOf(entries), deleted(BRANCH)], gh)
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'invalid-input' } })
    expect(result.message).toContain(reason)
    expect(readFakeCalls(gh.bin, 'gh')).toEqual([])
    expect(readdirSync(runnerTemporary)).toEqual([])
    expect(requestLabels(result.github.requests())).toContain(`DELETE ${REPO}/git/refs/heads/${BRANCH}`)
  })

  it('pr-attach で gh が失敗すると、gh の標準エラーを message に入れた github-api を返し、ブランチを消す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-18')
    await explains('`pr-attach` の gh の失敗のテストです。gh が 0 以外で終わった場合に、gh の標準エラーを `message` に入れた `github-api` を返し、ブランチを消すことを確認します。')
    const gh = fakeGh({ stderr: 'failed to upload shot.png: HTTP 404', exitCode: 1 })
    const { result } = await attach([referencesOf([[BRANCH, HEAD]]), treeOf([file('shot.png', 'b1')]), blob('b1', 'PNG-A'), deleted(BRANCH)], gh)
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'github-api' } })
    expect(result.message).toContain('failed to upload shot.png: HTTP 404')
    expect(writesOf(result.github.requests())).toEqual([`DELETE ${REPO}/git/refs/heads/${BRANCH}`])
  })

  it('pr-attach で attach-token が空だと、gh を起こさずに github-auth を返し、ブランチを消す', async (context) => {
    await verifies(context, 'PA-GITHUB-OPS-18')
    await explains('`pr-attach` の token の不足のテストです。`attach-token` が空の場合に、画像を読まず gh も起こさずに `github-auth` を返し、ブランチを消すことを確認します。')
    const gh = fakeGh()
    const { result } = await attach([referencesOf([[BRANCH, HEAD]]), deleted(BRANCH)], gh, { attachToken: '' })
    expect(result.code).toBe(1)
    expect(result.line).toMatchObject({ ok: false, error: { kind: 'github-auth' } })
    expect(result.message).toContain('PECOT_ATTACH_TOKEN')
    expect(readFakeCalls(gh.bin, 'gh')).toEqual([])
  })
})
