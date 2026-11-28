import { describe, expect, it } from 'vitest'

import {
  collectPreflightWarnings,
  decidePullRequestBase,
  describeBaseStop,
  describePushStatus,
  extractClosingIssueNumbers,
  formatPreflightWarning,
  forkPushFixHint,
  hasClosingReference,
  isReleasePullRequest,
  parseHeadReference,
  pickLowerPullRequest,
  pushFixHintOf,
  hasStashEntries,
  hasStatusChanges,
} from '../pull-request.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import type { PullRequestBaseDecision } from '../pull-request.js'
import type { PullRequestReadout } from '../issue-readout.js'
import '../../../tests/_helpers/hint-commands.js'
import { formatHinted } from '../command-hint.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'
import type { BaseReading } from '../state.js'
import type { RestackDecision } from '../restack.js'

describe('extractClosingIssueNumbers', () => {
  it.each([
    ['Closes #123, Fixes #456', [123, 456]],
    ['Closes owner/repo#789', [789]],
    ['closes #1 and CLOSED #2 and fix #3 fixed #4 fixes #5 resolve #6 resolved #7 resolves #8', [1, 2, 3, 4, 5, 6, 7, 8]],
    ['Closes #5\nFixes #5\nCloses #4', [5, 4]],
    ['Closes\u{3000}#9', [9]],
    ['Closes #１２', [12]],
    ['Refs #10, see #11', []],
    ['Closes # 12', []],
    ['', []],
    ['```console\nCloses #1\n```\nCloses #2', [2]],
    ['~~~\nCloses #1\n~~~\nCloses #2', [2]],
    ['> ```\n> Closes #1\n> ```\n> Closes #2', [2]],
    ['`Closes #1` と Closes #2', [2]],
    ['``Closes #1 ` x`` Closes #2', [2]],
    ['<!-- Closes #1 -->\nCloses #2', [2]],
    ['Closes #2\n```\nCloses #1', [2]],
    ['text\n\n    Closes #1\n\nCloses #2', [2]],
    ['    Closes #1\n\tCloses #3\nCloses #2', [2]],
    ['text\n    Closes #1', [1]],
    ['> ```\n> x\n\nCloses #2', [2]],
    ['> > ```\n> > Closes #1\n> > ```\n> Closes #2', [2]],
    ['Closes other/repo#1, Closes Owner/Repo#2, Closes owner/repo#3', [2, 3]],
  ])('本文 %j から、閉じる Issue の番号を取り出す', async (body, expected) => {
    await explains('PR の本文から、マージ時に閉じる Issue の番号を取り出す、`extractClosingIssueNumbers` のテストです。本文に `Closes #123` などのキーワードと Issue の番号がある場合に、その番号を重複なく出現順に返し、コードの中や別のリポジトリの参照は含めないことを確認します。')
    stepSync('extractClosingIssueNumbers を呼び、結果を比べる', () => {
      expect(extractClosingIssueNumbers(body, { owner: 'owner', repository: 'repo' })).toEqual(expected)
    })
  })
})

describe('hasClosingReference', () => {
  it.each([
    ['Closes #12', true],
    ['fixed other/repo#3', true],
    ['Refs #12', false],
    ['Closes #', false],
    ['`Closes #12`', false],
    ['<!-- Closes #12 -->', false],
  ])('本文 %j は、閉じる語の有無を %j と判定する', async (body, expected) => {
    await explains(`PR の本文に Issue を閉じる語があるかを判定する、\`hasClosingReference\` のテストです。本文 \`${JSON.stringify(body)}\` の場合に、別のリポジトリの参照も閉じる語として数え、コードとコメントの中は数えないことを確認します。`)
    stepSync('hasClosingReference を呼び、結果を比べる', () => {
      expect(hasClosingReference(body)).toBe(expected)
    })
  })
})

describe('isReleasePullRequest', () => {
  it('テンプレートが release の場合は、リリース PR と判定する', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。テンプレートが `release` の場合に、ブランチにかかわらず `true` を返すことを確認します。')
    stepSync('isReleasePullRequest を呼び、結果を比べる', () => {
      expect(isReleasePullRequest('release', 'x', 'y', 'develop', 'main')).toBe(true)
    })
  })

  it('develop から release のブランチへの PR は、リリース PR と判定する', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。head が develop のブランチ、base が release のブランチの場合に、`true` を返すことを確認します。')
    stepSync('isReleasePullRequest を呼び、結果を比べる', () => {
      expect(isReleasePullRequest('default', 'main', 'develop', 'develop', 'main')).toBe(true)
    })
  })

  it('head が develop のブランチでない場合は、リリース PR と判定しない', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。head が develop のブランチでない場合に、`false` を返すことを確認します。')
    stepSync('isReleasePullRequest を呼び、結果を比べる', () => {
      expect(isReleasePullRequest('default', 'main', 'feat/x', 'develop', 'main')).toBe(false)
    })
  })

  it('base が release のブランチでない場合は、リリース PR と判定しない', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。base が release のブランチでない場合に、`false` を返すことを確認します。')
    stepSync('isReleasePullRequest を呼び、結果を比べる', () => {
      expect(isReleasePullRequest('default', 'develop', 'develop', 'develop', 'main')).toBe(false)
    })
  })

  it('release のブランチが未設定か空の場合は、リリース PR と判定しない', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。release のブランチが `undefined` または空文字の場合に、`false` を返すことを確認します。')
    stepSync('isReleasePullRequest を呼び、結果を比べる', () => {
      expect(isReleasePullRequest('default', 'main', undefined, undefined, undefined)).toBe(false)
      expect(isReleasePullRequest('default', '', '', '', '')).toBe(false)
    })
  })

  it('head と develop が未設定でも、base が release のブランチの場合は、リリース PR と判定する', async () => {
    await explains('リリース PR かどうかを判定する、`isReleasePullRequest` のテストです。head と develop のブランチが未設定で、base が release のブランチの場合に、`true` を返すことを確認します。')
    stepSync('isReleasePullRequest を呼び、結果を比べる', () => {
      expect(isReleasePullRequest('default', 'main', undefined, undefined, 'main')).toBe(true)
    })
  })
})

describe('hasStatusChanges と hasStashEntries', () => {
  it.each([
    ['', false],
    ['  \n', false],
    ['(git status failed)', false],
    ['On branch x\nnothing to commit, working tree clean', false],
    ['On branch x\nnothing to commit', true],
    ['On branch x\nChanges not staged', true],
  ])('git status の出力が %j の場合は、変更の有無を %s で返す', async (status, expected) => {
    await explains(`手元の git の状態を判定する、\`hasStatusChanges\` と \`hasStashEntries\` のテストです。\`git status\` の出力が \`${JSON.stringify(status)}\` の場合に、変更の有無として \`${String(expected)}\` を返すことを確認します。`)
    stepSync('hasStatusChanges を呼び、結果を比べる', () => {
      expect(hasStatusChanges(status)).toBe(expected)
    })
  })

  it.each([
    ['(no stash)', false],
    ['(git stash list failed)', false],
    ['stash@{0}: WIP', true],
  ])('git stash list の出力が %j の場合は、stash の有無を %s で返す', async (list, expected) => {
    await explains(`手元の git の状態を判定する、\`hasStatusChanges\` と \`hasStashEntries\` のテストです。\`git stash list\` の出力が \`${JSON.stringify(list)}\` の場合に、stash の有無として \`${String(expected)}\` を返すことを確認します。`)
    stepSync('hasStashEntries を呼び、結果を比べる', () => {
      expect(hasStashEntries(list)).toBe(expected)
    })
  })
})

describe('parseHeadReference', () => {
  it.for([
    { head: 'feat/x/12', expected: { owner: undefined, branch: 'feat/x/12' } },
    { head: 'someone:feat/x/12', expected: { owner: 'someone', branch: 'feat/x/12' } },
    { head: ':feat/x/12', expected: undefined },
    { head: 'someone:', expected: undefined },
    { head: '', expected: undefined },
  ])('head が $head の場合は、$expected に分ける', async ({ head, expected }) => {
    await explains(`PR の head の指定を分解する、\`parseHeadReference\` のテストです。head が \`${JSON.stringify(head)}\` の場合に、\`owner:branch\` は owner とブランチ名に分け、不正なら \`undefined\` を返すことを確認します。`)
    stepSync('parseHeadReference を呼び、結果を比べる', () => {
      expect(parseHeadReference(head)).toEqual(expected)
    })
  })
})

describe('forkPushFixHint', () => {
  it('ローカルと remote がずれていない場合は、remote とブランチ名を付けた git push を案内する', async () => {
    await explains('fork へ push するときの直し方を案内する、`forkPushFixHint` のテストです。ローカルと remote が分岐していない場合に、`git push fork feat/x` のように remote とブランチ名を付けた `git push` を案内することを確認します。')
    stepSync('forkPushFixHint を呼び、結果を比べる', () => {
      expect(formatHinted(forkPushFixHint('fork', 'feat/x', false))).toBe('git push fork feat/x')
    })
  })

  it('ローカルと remote がずれている場合は、取り込みか lease 付きの上書きを案内する', async () => {
    await explains('fork へ push するときの直し方を案内する、`forkPushFixHint` のテストです。ローカルと remote が分岐している場合に、取り込みの `git pull --rebase` か、上書きの `git push --force-with-lease` を案内することを確認します。')
    stepSync('forkPushFixHint を呼び、結果を比べる', () => {
      expect(formatHinted(forkPushFixHint('fork', 'feat/x', true))).toBe('git pull --rebase fork feat/x, or git push --force-with-lease fork feat/x if you rewrote pushed commits')
    })
  })
})

describe('describePushStatus', () => {
  it.each([
    [0, 0, true, 'in sync with origin/feat', false],
    [3, 0, false, '3 unpushed commits', false],
    [0, 2, true, 'origin/feat is 2 commits ahead (pull recommended)', false],
    [3, 2, false, 'diverged: local is 3 commits ahead, origin/feat is 2 ahead', true],
  ])('ローカルが remote より %i 件先、%i 件後ろの場合の状態を返す', async (ahead, behind, isPushed, message, isDiverged) => {
    await explains(`push の状態を説明する、\`describePushStatus\` のテストです。ローカルが remote より ${String(ahead)} 件先、${String(behind)} 件後ろの場合に、push の状態を説明するメッセージと、分岐しているかどうかの判定を返すことを確認します。`)
    stepSync('describePushStatus を呼び、結果を比べる', () => {
      expect(describePushStatus('origin', 'feat', ahead, behind)).toEqual({ isPushed, message, isDiverged })
    })
  })
})

describe('pushFixHintOf', () => {
  const rows: readonly { readonly name: string, readonly decision: RestackDecision | undefined, readonly expected: string }[] = [
    { name: '親ブランチが動いた', decision: { kind: 'moved', base: 'feat/1' }, expected: 'pr_restack' },
    { name: '親 PR がマージ済み', decision: { kind: 'merged', base: 'main', pullRequest: 1 }, expected: 'pr_restack' },
    { name: 'スタックし直し済みで記録だけが古い', decision: { kind: 'rebased', base: 'main' }, expected: 'pr_restack' },
    { name: '親ブランチが動いていない', decision: { kind: 'up-to-date', base: 'feat/1' }, expected: `git pull --rebase, or ${['git', 'push', '--force-with-lease'].join(' ')} if you rewrote pushed commits` },
    { name: '親ブランチが消えた', decision: { kind: 'gone', base: 'feat/1', pullRequest: undefined }, expected: 'pr_restack with check: true' },
    { name: '判断を読めない', decision: undefined, expected: 'pr_restack with check: true' },
  ]

  it.for(rows)('$name の場合は、$expected を案内する', async (row) => {
    await explains(`push の問題の直し方を案内する、\`pushFixHintOf\` のテストです。${row.name}の場合に、\`${row.expected}\` を案内することを確認します。`)
    stepSync('pushFixHintOf を呼び、結果を比べる', () => {
      expect(formatHinted(pushFixHintOf(row.decision))).toBe(row.expected)
    })
  })
})

describe('collectPreflightWarnings', () => {
  const clean = { gitStatus: 'nothing to commit, working tree clean', stashList: '(no stash)', isPushed: true, pushMessage: 'in sync' }

  it('問題がない場合は、空の配列を返す', async () => {
    await explains('PR を作成する前の警告を集める、`collectPreflightWarnings` のテストです。push 済みで、変更と stash のどちらもない場合に、空の配列を返すことを確認します。')
    stepSync('collectPreflightWarnings を呼び、結果を比べる', () => {
      expect(collectPreflightWarnings(clean)).toEqual([])
    })
  })

  it('警告は push・status・stash の順に返し、stash の件数に空行を含めない', async () => {
    await explains('PR を作成する前の警告を集める、`collectPreflightWarnings` のテストです。push 前・未コミットの変更・stash のすべてがある場合に、その順の警告を返し、stash の件数から空行を除くことを確認します。')
    const warnings = stepSync('collectPreflightWarnings を呼ぶ', () => collectPreflightWarnings({ gitStatus: ' M a.ts', stashList: 'stash@{0}: a\n\nstash@{1}: b\r\nstash@{2}: c', isPushed: false, pushMessage: '2 unpushed commits' }))
    stepSync('結果を比べる', () => {
      expect(warnings.map(warning => ({ ...warning, fixHint: formatHinted(warning.fixHint) }))).toEqual([
        { label: 'Push Status', message: '2 unpushed commits', fixHint: 'git push' },
        { label: 'Git Status', message: 'modified or untracked files', fixHint: 'commit' },
        { label: 'Stash List', message: '3 stash entries', fixHint: 'check them' },
      ])
    })
  })

  it('Push Status の直し方を渡した場合は、その直し方を使う', async () => {
    await explains('PR を作成する前の警告を集める、`collectPreflightWarnings` のテストです。push の問題の直し方を渡した場合に、既定の `git push` の案内ではなく、渡した直し方を `Push Status` の警告に使うことを確認します。')
    const [warning] = stepSync('collectPreflightWarnings を呼ぶ', () => collectPreflightWarnings({ ...clean, isPushed: false, pushMessage: 'diverged', pushFixHint: pushFixHintOf({ kind: 'moved', base: 'feat/1' }) }))
    stepSync('結果を比べる', () => {
      expect(warning === undefined ? undefined : formatHinted(warning.fixHint)).toBe('pr_restack')
    })
  })

  it('警告を 1 行の文にする', async () => {
    await explains('PR を作成する前の警告を 1 行の文にする、`formatPreflightWarning` のテストです。ラベル・メッセージ・直し方を渡した場合に、`Push Status: m (fix: git push)` の形の文を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(formatHinted(formatPreflightWarning({ label: 'Push Status', message: 'm', fixHint: ['git push'] }))).toBe('Push Status: m (fix: git push)')
    })
  })
})

const STACKED_ON = createIssueReference(createRepositoryReference('acme', 'app'), 11)
const SHA = 'a'.repeat(40)
const STACKED: BaseReading = { kind: 'stacked', record: { branch: 'feat/a/11', sha: SHA, stackedOn: STACKED_ON }, stackedOn: STACKED_ON }

function lower(state: PullRequestReadout['state']): PullRequestReadout {
  return { repository: createRepositoryReference('acme', 'app'), number: 21, state, headRefName: 'feat/a/11', baseRefName: 'develop', isDraft: false, isCrossRepository: false }
}

const NO_RECORD: BaseReading = { kind: 'development', record: undefined }
const DEVELOPMENT_RECORD: BaseReading = { kind: 'development', record: { branch: 'develop', sha: SHA, stackedOn: undefined } }

function decide(reading: BaseReading, base: string, lowerPullRequest?: PullRequestReadout): PullRequestBaseDecision {
  return decidePullRequestBase({ reading, base, developBranch: 'develop', lowerPullRequest })
}

describe('decidePullRequestBase', () => {
  it.for([
    { name: '記録が無い', reading: NO_RECORD },
    { name: '開発ブランチからの着手の記録', reading: DEVELOPMENT_RECORD },
  ])('$name の場合は、渡された base をそのまま使い、スタックに登録しない', async ({ name, reading }) => {
    await explains(`PR の base を決める、\`decidePullRequestBase\` のテストです。${name}の場合に、渡された base をそのまま使い、スタックに登録しないことを確認します。`)
    stepSync('結果を比べる', () => {
      expect(decide(reading, 'develop')).toEqual({ kind: 'use', base: 'develop', stackOn: undefined, stackedBase: undefined, isLowerMerged: false })
    })
  })

  it('スタックの記録があり、親 PR が開いている場合は、親ブランチを base にして、その PR のスタックに登録する', async () => {
    await explains('PR の base を決める、`decidePullRequestBase` のテストです。スタックの記録があり、親 PR が開いている場合に、親ブランチを base に使い、その PR のスタックに登録することを確認します。')
    stepSync('結果を比べる', () => {
      expect(decide(STACKED, 'feat/a/11', lower('OPEN'))).toEqual({ kind: 'use', base: 'feat/a/11', stackOn: 21, stackedBase: 'feat/a/11', isLowerMerged: false })
    })
  })

  it.for([
    { name: '記録の base', base: 'feat/a/11' },
    { name: '開発ブランチ', base: 'develop' },
  ])('親 PR がマージ済みで $name を渡した場合は、開発ブランチを base にして、スタックに登録しない', async ({ name, base }) => {
    await explains(`PR の base を決める、\`decidePullRequestBase\` のテストです。親 PR がマージ済みの場合に、${name}を渡しても、開発ブランチを base に使い、スタックに登録しないことを確認します。`)
    stepSync('結果を比べる', () => {
      expect(decide(STACKED, base, lower('MERGED'))).toEqual({ kind: 'use', base: 'develop', stackOn: undefined, stackedBase: 'feat/a/11', isLowerMerged: true })
    })
  })

  it.for([
    { name: '親 PR が無い', pullRequest: undefined },
    { name: '親 PR がマージされずに閉じた', pullRequest: lower('CLOSED') },
  ])('$name の場合は、PR を作成せずに止める', async ({ name, pullRequest }) => {
    await explains(`PR の base を決める、\`decidePullRequestBase\` のテストです。${name}の場合に、PR を作成せず、開いている PR が存在しないことを理由に止めることを確認します。`)
    stepSync('結果を比べる', () => {
      expect(decide(STACKED, 'feat/a/11', pullRequest)).toEqual({ kind: 'stop', reason: 'no-open-pr', branch: 'feat/a/11' })
    })
  })

  it('記録が不正な形式の場合は、止める', async () => {
    await explains('PR の base を決める、`decidePullRequestBase` のテストです。スタックの記録が読み取れない形式（`malformed`）の場合に、内容を添えて止めることを確認します。')
    stepSync('結果を比べる', () => {
      expect(decide({ kind: 'malformed', content: 'broken' }, 'develop')).toEqual({ kind: 'stop', reason: 'malformed', content: 'broken' })
    })
  })

  it('親 PR が開いているのに開発ブランチを渡した場合は、止める', async () => {
    await explains('PR の base を決める、`decidePullRequestBase` のテストです。親 PR が開いているのに、base に開発ブランチを渡した場合に、親ブランチの情報を添えて止めることを確認します。')
    stepSync('結果を比べる', () => {
      expect(decide(STACKED, 'develop', lower('OPEN'))).toEqual({ kind: 'stop', reason: 'lower-open', branch: 'feat/a/11', pullRequest: 21, base: 'develop' })
    })
  })

  it('記録の base でも開発ブランチでもない base は、そのまま返し、内容の検証に任せる', async () => {
    await explains('PR の base を決める、`decidePullRequestBase` のテストです。記録の base でも開発ブランチでもない base を渡した場合に、止めずにそのまま使い、エラーの判断を内容の検証に任せることを確認します。')
    stepSync('結果を比べる', () => {
      expect(decide(STACKED, 'main', lower('OPEN'))).toEqual({ kind: 'use', base: 'main', stackOn: undefined, stackedBase: 'feat/a/11', isLowerMerged: false })
    })
  })
})

// 親ブランチの PR。番号と状態と fork かを変える
function pullRequestIn(number: number, state: PullRequestReadout['state'], isCrossRepository = false): PullRequestReadout {
  return { ...lower(state), number, isCrossRepository }
}

describe('pickLowerPullRequest', () => {
  it.for([
    { name: '閉じた PR が新しく、マージ済みの PR が古い', pullRequests: [pullRequestIn(30, 'CLOSED'), pullRequestIn(21, 'MERGED')], expected: 21 },
    { name: '開いた PR が閉じた PR とマージ済みの PR より古い', pullRequests: [pullRequestIn(31, 'CLOSED'), pullRequestIn(30, 'MERGED'), pullRequestIn(21, 'OPEN')], expected: 21 },
    { name: '閉じた PR しか無い', pullRequests: [pullRequestIn(31, 'CLOSED'), pullRequestIn(30, 'CLOSED')], expected: 31 },
    { name: 'fork の開いた PR と、自分のリポのマージ済みの PR がある', pullRequests: [pullRequestIn(40, 'OPEN', true), pullRequestIn(21, 'MERGED')], expected: 21 },
  ])('$name の場合は、開いている PR・マージ済みの PR・閉じた PR の順に選ぶ', async ({ name, pullRequests, expected }) => {
    await explains(`親ブランチの PR を選ぶ、\`pickLowerPullRequest\` のテストです。${name}の場合に、開いている PR・マージ済みの PR・閉じた PR の順に優先して選び、番号が \`${String(expected)}\` の PR を返すことを確認します。`)
    stepSync('pickLowerPullRequest を呼び、結果を比べる', () => {
      expect(pickLowerPullRequest(pullRequests)?.number).toBe(expected)
    })
  })

  it('fork の PR しか存在しない場合は、undefined を返す', async () => {
    await explains('親ブランチの PR を選ぶ、`pickLowerPullRequest` のテストです。候補が fork のリポジトリからの PR だけの場合に、`undefined` を返すことを確認します。')
    stepSync('pickLowerPullRequest を呼び、結果を比べる', () => {
      expect(pickLowerPullRequest([pullRequestIn(40, 'OPEN', true)])).toBeUndefined()
    })
  })
})

describe('describeBaseStop', () => {
  it('親 PR が存在しない場合は、止めた理由と、pr_check を呼び直す直し方の 2 行を返す', async () => {
    await explains('base を決められずに止めたときの説明を作成する、`describeBaseStop` のテストです。開いている親 PR が存在しない場合に、止めた理由と、`pr_check` を呼び直す直し方の 2 行を返すことを確認します。')
    stepSync('describeBaseStop を呼び、結果を比べる', () => {
      expect(describeBaseStop({ kind: 'stop', reason: 'no-open-pr', branch: 'feat/a/11' }).map(line => formatHinted(line))).toEqual([
        'base branch feat/a/11 has no open PR',
        'reopen the PR of feat/a/11, or create a new one, then call pr_check again',
      ])
    })
  })

  it('記録が不正な形式の場合は、記録の内容を示す', async () => {
    await explains('base を決められずに止めたときの説明を作成する、`describeBaseStop` のテストです。スタックの記録が読み取れない形式の場合に、記録の内容を含む 1 行を返すことを確認します。')
    stepSync('describeBaseStop を呼び、結果を比べる', () => {
      expect(describeBaseStop({ kind: 'stop', reason: 'malformed', content: 'broken' })).toEqual(['.pecot-base is malformed: broken'])
    })
  })

  it('親 PR が開いているのに開発ブランチを渡した場合は、使うべき base を示す', async () => {
    await explains('base を決められずに止めたときの説明を作成する、`describeBaseStop` のテストです。親 PR が開いているのに base に開発ブランチを渡した場合に、使うべき親ブランチと PR の番号を示す 1 行を返すことを確認します。')
    stepSync('describeBaseStop を呼び、結果を比べる', () => {
      expect(describeBaseStop({ kind: 'stop', reason: 'lower-open', branch: 'feat/a/11', pullRequest: 21, base: 'develop' })).toEqual([
        'base branch must be feat/a/11 while its PR #21 is open (given: develop)',
      ])
    })
  })
})
