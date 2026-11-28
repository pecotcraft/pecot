/* eslint-disable security/detect-non-literal-fs-filename -- 見るのは一時リポ配下だけ */
// session_start の振る舞いを、ツールをプロセス内で呼んで確かめる。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { step } from '../../../../../libs/interface-spec/src/vitest/step.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { runTool } from '../_helpers/command-harness.js'
import type { ToolResult, ToolRun } from '../_helpers/command-harness.js'

useIsolatedEnvironment()

const SHA = '0123456789abcdef0123456789abcdef01234567'
const TITLE = '.pecot/state/.pecot-session-title'
const BASE = '.pecot/state/.pecot-base'

const START = { issue_ref: 'acme/demo/7', base: 'main', sha: SHA, title: '[Task] 見本の Issue', reads: { pull_requests: [] } }

// 前の PR（#21、ブランチ feat/old/5）を list_pull_requests で読んだ結果
const OLD_BRANCH = 'feat/old/5'

type ListedState = 'open' | 'closed' | 'merged'

function listed(...states: readonly ListedState[]): readonly Readonly<Record<string, unknown>>[] {
  const branch = (reference: string): Readonly<Record<string, unknown>> => ({ ref: reference, repo: { full_name: 'acme/demo' } })
  return states.map((state, index) => ({
    number: 21 + index,
    state: state === 'merged' ? 'closed' : state,
    merged: state === 'merged',
    html_url: `https://ghes.example.com/acme/demo/pull/${String(21 + index)}`,
    head: branch(OLD_BRANCH),
    base: branch('main'),
  }))
}

async function start(arguments_: Readonly<Record<string, unknown>> = {}, run: Readonly<Partial<ToolRun>> = {}): Promise<ToolResult> {
  return await step('session_start を呼ぶ', async () => await runTool({ tool: 'session_start', arguments: { ...START, ...arguments_ }, ...run }))
}

describe('session_start', () => {
  it('issue_ref・base・sha を渡すと、.pecot-base・作業ディレクトリ・セッション名を書く', async (context) => {
    await verifies(context, 'PW-SESSION-START-01')
    await explains('`link-branch` で作ったブランチの `issue_ref`・`base`・`sha` を渡した場合のテストです。`.pecot-base` と作業ディレクトリとセッション名を書き込むことを確認します。')
    const result = await start()
    await step('結果と書いたファイルを確かめる', () => {
      expect(result.isError).toBe(false)
      expect(result.structured).toEqual({ repository: 'acme/demo', base: 'main', issue: 'acme/demo/7', workDirectory: path.join(result.directory, '.pecot/work/7') })
      expect(result.read(BASE)).toBe(`main ${SHA}`)
      expect(result.read(TITLE)).toBe('#7 見本の Issue')
      expect(existsSync(path.join(result.directory, '.pecot/work/7'))).toBe(true)
    })
  })

  it('stacked_on を渡すと、.pecot-base にスタック先の Issue を書き、stackedOn にその番号を入れる', async (context) => {
    await verifies(context, 'PW-SESSION-START-02')
    await explains('`branch_check` が返した `stacked_on` を渡した場合のテストです。`.pecot-base` にスタック先の Issue を書き込み、結果の `stackedOn` にその番号を入れることを確認します。')
    const result = await start({ base: 'feat/3', stacked_on: 'acme/demo/3' })
    await step('結果と書いたファイルを確かめる', () => {
      expect(result.structured).toMatchObject({ base: 'feat/3', stackedOn: 3 })
      expect(result.read(BASE)).toBe(`feat/3 ${SHA} acme/demo#3`)
    })
  })

  it('今のブランチの PR がマージ済みで開いた PR が無いと、leftovers と warnings に入れ、session_finish を案内する', async (context) => {
    await verifies(context, 'PW-SESSION-START-03')
    await explains('今のブランチ（`feat/old/5`）の PR がマージ済みで、開いた PR が存在しない場合のテストです。その PR を `leftovers` に入れ、`session_finish` の呼び方を警告に含めることを確認します。')
    const result = await start({ reads: { pull_requests: listed('merged') } }, { branch: OLD_BRANCH })
    await step('結果を確かめる', () => {
      expect(result.structured['leftovers']).toEqual([{ pullRequest: 'acme/demo/21' }])
      expect(result.structured['warnings']).toEqual([expect.stringContaining('PR acme/demo#21 of the current branch feat/old/5 is merged but not cleaned up; call session_finish with pr_ref: "acme/demo/21"')])
    })
  })

  it.for<{ name: string, states: readonly ListedState[] }>([
    { name: '開いた PR がある', states: ['merged', 'open'] },
    { name: '閉じただけの PR しか無い', states: ['closed'] },
  ])('今のブランチに $name と、leftovers と warnings を入れない', async ({ name, states }, context) => {
    await verifies(context, 'PW-SESSION-START-03')
    await explains(`今のブランチに${name}場合のテストです。取りこぼしとして扱わず、\`leftovers\` と \`warnings\` を含めないことを確認します。`)
    const result = await start({ reads: { pull_requests: listed(...states) } }, { branch: OLD_BRANCH })
    await step('結果を確かめる', () => {
      expect(result.structured).not.toHaveProperty('leftovers')
      expect(result.structured).not.toHaveProperty('warnings')
    })
  })

  it('reads.pull_requests が無いと、取りこぼしを確かめず、list_pull_requests を warning で案内する', async (context) => {
    await verifies(context, 'PW-SESSION-START-04')
    await explains('今のブランチの PR の読み取りを渡さない場合のテストです。取りこぼしを確認せずに記録を書き込み、`list_pull_requests` の読み取りを警告で案内することを確認します。')
    const result = await start({ reads: undefined }, { branch: OLD_BRANCH })
    await step('結果を確かめる', () => {
      expect(result.structured).not.toHaveProperty('leftovers')
      expect(result.structured['warnings']).toEqual(['leftovers are not checked: pass the result of list_pull_requests (head acme:feat/old/5, state all) in reads.pull_requests'])
      expect(result.read(BASE)).toBe(`main ${SHA}`)
    })
  })

  it.for([
    { name: 'issue_ref が owner/repo/N の形でない', arguments_: { issue_ref: 'demo#7' } },
    { name: 'stacked_on が owner/repo/N の形でない', arguments_: { stacked_on: '3' } },
    { name: 'sha が SHA の形でない', arguments_: { sha: 'abc123' } },
  ])('$name と、何も書かずに kind が invalid-input の失敗を返す', async ({ name, arguments_ }, context) => {
    await verifies(context, 'PW-SESSION-START-05')
    await explains(`${name}場合のテストです。\`.pecot-base\` とセッション名を書き込まずに、\`kind\` が \`invalid-input\` の失敗を返すことを確認します。`)
    const result = await start(arguments_)
    await step('結果と書いたファイルを確かめる', () => {
      expect(result.isError).toBe(true)
      expect(result.structured['kind']).toBe('invalid-input')
      expect(result.read(BASE)).toBeUndefined()
      expect(result.read(TITLE)).toBeUndefined()
    })
  })
})
