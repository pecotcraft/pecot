// 対応する Python のテストは cli/tests/core/test_dependabot_prs.py。
// 期待値のうち Python と細かく違いうるもの（版の計算・時刻の読み）は、Python で実際に動かして確かめた値。
import { describe, expect, it } from 'vitest'

import {
  buildTrackerTitle,
  checksLabel,
  DependabotPrError,
  LIST_BEGIN,
  LIST_END,
  parseTrackerPullRequestNumbers,
  parseUpdateMetadata,
  planTracker,
  renderTrackerBody,
  rollupState,
  TRACKER_PATTERN,
  waitingReasons,
} from '../dependabot-pull-requests.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import type { PrEntry } from '../dependabot-pull-requests.js'
import type { JsonObject } from '../json.js'
import { JSON_NULL } from '../json-null.js'

const NOW = new Date('2026-11-09T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function iso(ageMs: number): string {
  return new Date(NOW.getTime() - ageMs).toISOString().replace('.000Z', 'Z')
}

type Dependency = readonly [string, string | undefined]

function message(...dependencies: readonly Dependency[]): string {
  const lines = ['Bump x', '', '---', 'updated-dependencies:']
  for (const [name, kind] of dependencies) {
    lines.push(`- dependency-name: "${name}"`, '  dependency-type: direct:development')
    if (kind !== undefined) lines.push(`  update-type: version-update:semver-${kind}`)
  }
  return [...lines, '...', '', 'Signed-off-by: dependabot[bot] <support@github.com>'].join('\n')
}

interface PrOptions {
  readonly dependencies?: readonly Dependency[]
  readonly message?: string
  readonly signature?: JsonObject | typeof JSON_NULL
  readonly commitAuthor?: string | typeof JSON_NULL
  readonly age?: number
  readonly autoMerge?: boolean
  readonly queue?: boolean
  readonly rollup?: string | typeof JSON_NULL
  readonly mergeable?: string
  readonly baseAge?: number
  readonly events?: readonly (readonly [string, number])[]
}

function last(kind: string, events: PrOptions['events']): JsonObject {
  const ages = (events ?? []).filter(([name]) => name === kind).map(([, age]) => age)
  return { nodes: ages.length > 0 ? [{ createdAt: iso(Math.min(...ages)) }] : [] }
}

function pr(options: Readonly<PrOptions> = {}): JsonObject {
  const age = options.age ?? 2 * HOUR
  const author = options.commitAuthor === undefined ? 'dependabot[bot]' : options.commitAuthor
  const rollup = options.rollup === undefined ? 'SUCCESS' : options.rollup
  return {
    number: 7,
    title: 'Bump left-pad',
    url: 'https://github.com/o/r/pull/7',
    createdAt: iso(age),
    author: { __typename: 'Bot', login: 'dependabot' },
    isInMergeQueue: options.queue ?? false,
    autoMergeRequest: options.autoMerge === false ? JSON_NULL : { enabledAt: iso(age) },
    mergeable: options.mergeable ?? 'MERGEABLE',
    baseRef: { target: { committedDate: iso(options.baseAge ?? 72 * HOUR) } },
    firstCommits: {
      nodes: [{
        commit: {
          message: options.message ?? message(...options.dependencies ?? [['left-pad', 'minor']]),
          signature: options.signature === undefined ? { isValid: true } : options.signature,
          author: { user: author === null ? JSON_NULL : { login: author } },
        },
      }],
    },
    headCommits: { nodes: [{ commit: { statusCheckRollup: rollup === null ? JSON_NULL : { state: rollup } } }] },
    lastForcePush: last('HeadRefForcePushedEvent', options.events),
    lastDequeue: last('RemovedFromMergeQueueEvent', options.events),
  }
}

describe('parseUpdateMetadata', () => {
  it('依存が 1 つなら、その名前と update-type を返す', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。依存パッケージが 1 つの場合に、その名前と `update-type` の種類（`minor` など）を返すことを確認します。')
    stepSync('`parseUpdateMetadata` を呼び、結果を比べる', () => {
      expect(parseUpdateMetadata(message(['a', 'minor']))).toEqual([['a', 'minor']])
    })
  })

  it('group の PR では、依存パッケージごとに返す', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。複数の依存パッケージをまとめた group の PR の場合に、パッケージごとの名前と種類を返すことを確認します。')
    stepSync('`parseUpdateMetadata` を呼び、結果を比べる', () => {
      expect(parseUpdateMetadata(message(['a', 'patch'], ['b', 'major']))).toEqual([['a', 'patch'], ['b', 'major']])
    })
  })

  it('update-type が存在しない場合は、group の Updates 行の版から種類を求める', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。`update-type` が存在しない場合に、`Updates` の行に書かれた変更前と変更後の版を比較して、`major` や `minor` を求めることを確認します。')
    const text = stepSync('`replace` を呼ぶ', () => message(['a', undefined], ['b', undefined]).replace(
      'Signed-off-by',
      'Updates `a` from 1.2.3 to 2.0.0\nUpdates `b` from v1.2.3 to v1.3.0\nSigned-off-by',
    ))

    stepSync('結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toEqual([['a', 'major'], ['b', 'minor']])
    })
  })

  it('同じ名前の依存パッケージには、Updates の行を出現順に対応させる', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。同じ名前の依存パッケージが複数ある場合に、`Updates` の行を出現した順に 1 つずつ対応させて、種類を求めることを確認します。')
    const text = stepSync('`replace` を呼ぶ', () => message(['a', undefined], ['a', undefined]).replace(
      'Signed-off-by',
      'Updates `a` from 1.0.0 to 1.0.1\nUpdates `a` from 1.0.0 to 2.0.0\nSigned-off-by',
    ))

    stepSync('結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toEqual([['a', 'patch'], ['a', 'major']])
    })
  })

  it('update-type が存在しない場合は、Bumps 行の版から種類を求める', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。`update-type` が存在しない場合に、`Bumps` の行に書かれた変更前と変更後の版から、種類を求めることを確認します。')
    stepSync('`parseUpdateMetadata` を呼び、結果を比べる', () => {
      expect(parseUpdateMetadata(`Bumps [a](https://x) from 1.2.3 to 1.2.4.\n\n${message(['a', undefined])}`)).toEqual([['a', 'patch']])
    })
  })

  it('Bumps 行は、先頭の依存パッケージにだけ対応させる', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。依存パッケージが複数ある場合に、`Bumps` の行から求めた種類を先頭のパッケージにだけ当て、ほかのパッケージの種類は `undefined` にすることを確認します。')
    const text = stepSync('入力を用意する', () => `Bumps [a](https://x) from 1.2.3 to 2.0.0.\n\n${message(['a', undefined], ['b', undefined])}`)

    stepSync('結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toEqual([['a', 'major'], ['b', undefined]])
    })
  })

  it('YAML の dependency-version を、変更後の版として使う', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。YAML に `dependency-version` がある場合に、`Bumps` の行の変更後の版ではなく、この値を変更後の版として種類を求めることを確認します。')
    const text = stepSync('入力を用意する', () => `Bumps [a](https://x) from 1.2.3 to 1.2.4.\n\n${message(['a', undefined]).replace('  dependency-type', '  dependency-version: 1.3.0\n  dependency-type')}`)

    stepSync('結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toEqual([['a', 'minor']])
    })
  })

  it('Updates 行は、行全体が一致する場合だけ読む', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。`Updates` の行の前に別の文字がある場合に、その行を読み取らず、種類を `undefined` にすることを確認します。')
    const text = stepSync('`replace` を呼ぶ', () => message(['a', undefined]).replace('Signed-off-by', 'see Updates `a` from 1.0.0 to 2.0.0 here\nSigned-off-by'))

    stepSync('結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toEqual([['a', undefined]])
    })
  })

  it.for([
    { old: '1.2.3', next: '1.2.3', expected: undefined },
    { old: '1.2.3', next: '1.2.4', expected: 'patch' },
    { old: '1.2.3', next: '1.3.0', expected: 'minor' },
    { old: '1.2.3', next: '2.0.0', expected: 'major' },
    { old: '1', next: '1.0', expected: 'minor' },
    { old: '1.0.0-beta.1', next: '1.0.0', expected: 'patch' },
    { old: 'v1.2.3', next: 'v1.2.4', expected: 'patch' },
  ])('版が $old から $next に変わると、種類は $expected になる', async ({ old, next, expected }) => {
    await explains(`dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、\`parseUpdateMetadata\` のテストです。版が \`${old}\` から \`${next}\` へ変わった場合の更新の種類として、\`${String(expected)}\` を返すことを確認します。`)
    stepSync('`parseUpdateMetadata` を呼び、結果を比べる', () => {
      expect(parseUpdateMetadata(`Bumps [a](https://x) from ${old} to ${next}.\n\n${message(['a', undefined])}`)).toEqual([['a', expected]])
    })
  })

  it('改行が CRLF のメッセージも読む', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。改行が `\\r\\n` のコミットメッセージの場合にも、`\\n` の場合と同じ結果を返すことを確認します。')
    stepSync('`parseUpdateMetadata` を呼び、結果を比べる', () => {
      expect(parseUpdateMetadata(message(['a', 'minor']).replaceAll('\n', '\r\n'))).toEqual([['a', 'minor']])
    })
  })

  it('update-type が semver- を含まない値でも、末尾が種類ならそれを使う', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。`update-type` が `minor` のように `semver-` を含まない値の場合でも、その値を種類として返すことを確認します。')
    const text = stepSync('`replace` を呼ぶ', () => message(['a', undefined]).replace('  dependency-type', '  update-type: minor\n  dependency-type'))

    stepSync('結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toEqual([['a', 'minor']])
    })
  })

  it('依存パッケージの名前が文字列でない項目は、読み飛ばす', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。依存パッケージの名前が数値の項目や、文字列だけの項目がある場合に、それらを除き、読み取れる項目だけを返すことを確認します。')
    const text = stepSync('入力を用意する', () => 'x\n\n---\nupdated-dependencies:\n- dependency-name: 1\n- just-a-string\n- dependency-name: b\n  update-type: version-update:semver-patch\n...\n')

    stepSync('結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toEqual([['b', 'patch']])
    })
  })

  it('update-type と版のどちらも存在しない場合は、種類を undefined にする', async () => {
    await explains('dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、`parseUpdateMetadata` のテストです。`update-type` と版のどちらも存在しない場合に、パッケージの名前だけを返し、種類を `undefined` にすることを確認します。')
    stepSync('`parseUpdateMetadata` を呼び、結果を比べる', () => {
      expect(parseUpdateMetadata(message(['a', undefined]))).toEqual([['a', undefined]])
    })
  })

  it.for([
    { name: 'YAML が無い', text: 'Bump a from 1 to 2\n\nplain message' },
    { name: 'YAML が読めない', text: 'x\n\n---\nupdated-dependencies: [\n...\n' },
    { name: 'YAML が辞書でない', text: 'x\n\n---\n- a\n- b\n...\n' },
    { name: 'YAML が set のタグ', text: 'x\n\n---\n!!set {a, b}\n...\n' },
    { name: '依存の配列が無い', text: 'x\n\n---\nother: 1\n...\n' },
    { name: '依存の配列が空', text: 'x\n\n---\nupdated-dependencies: []\n...\n' },
  ])('$name の場合は、undefined を返す', async ({ name, text }) => {
    await explains(`dependabot の PR のコミットメッセージから、依存パッケージの名前と更新の種類（update-type）を取り出す、\`parseUpdateMetadata\` のテストです。コミットメッセージの YAML が「${name}」場合に、メタデータを取り出せず、\`undefined\` を返すことを確認します。`)
    stepSync('`parseUpdateMetadata` を呼び、結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toBeUndefined()
    })
  })
})

describe('waitingReasons の update-type', () => {
  it('検証が成功している minor の更新は、待っている PR に含めない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` のテストです。更新の種類が `minor` で、検証が成功し、競合もない PR の場合に、理由が空の配列になることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr(), NOW)).toEqual([])
    })
  })

  it('major の更新は、理由に含める', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` のテストです。更新の種類が `major` の場合に、理由に `major` を含めることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ dependencies: [['a', 'major']] }), NOW)).toEqual(['major'])
    })
  })

  it('group の中に major の更新が 1 つでもあれば、major を理由に含める', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` のテストです。group の PR に `major` の更新が 1 つでも含まれる場合に、理由に `major` を含めることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ dependencies: [['a', 'patch'], ['b', 'major']] }), NOW)).toEqual(['major'])
    })
  })

  it('依存パッケージの名前に関係なく、minor の更新には理由を追加しない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` のテストです。依存パッケージの名前が `@Playwright/test` のように `@` で始まる場合でも、`minor` の更新に理由を追加しないことを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ dependencies: [['@Playwright/test', 'minor']] }), NOW)).toEqual([])
    })
  })

  it.for([{ author: 'someone' }, { author: JSON_NULL }])('最初のコミットの author が $author の場合は、種類を不明として扱う', async ({ author }) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` のテストです。最初のコミットの author が \`${String(author)}\` の場合に、理由へ \`unknown update type\` を含めることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ commitAuthor: author }), NOW)).toEqual(['unknown update type'])
    })
  })

  it('更新の種類が 1 つも決まらない場合は、種類を不明として扱う', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` のテストです。依存パッケージの更新の種類をどれも決められない場合に、理由に `unknown update type` を含めることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ dependencies: [['a', undefined]] }), NOW)).toEqual(['unknown update type'])
    })
  })

  it.for([{ signature: { isValid: false } }, { signature: {} }, { signature: JSON_NULL }])('署名が $signature の場合は、種類を不明として扱う', async ({ signature }) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` のテストです。コミットの署名が \`${JSON.stringify(signature)}\` の場合に、理由へ \`unknown update type\` を含めることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ signature }), NOW)).toEqual(['unknown update type'])
    })
  })

  it('YAML の依存パッケージの名前が、引用符のない @scope の場合は、種類を不明として扱う', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` のテストです。YAML の `dependency-name` が引用符のない `@scope/x` の場合に、YAML として読み取れないため、理由に `unknown update type` を含めることを確認します。')
    const text = stepSync('入力を用意する', () => 'Bump x\n\n---\nupdated-dependencies:\n- dependency-name: @scope/x\n  update-type: version-update:semver-minor\n...\n')

    stepSync('結果を比べる', () => {
      expect(waitingReasons(pr({ message: text }), NOW)).toEqual(['unknown update type'])
    })
  })

  it('更新の種類が理由になる PR には、検証や競合の状態を理由に追加しない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` のテストです。`major` の更新で、検証の失敗と競合もある場合に、理由が `major` だけになることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ dependencies: [['a', 'major']], rollup: 'FAILURE', mergeable: 'CONFLICTING' }), NOW)).toEqual(['major'])
    })
  })

  it('コミットのメッセージが存在しない場合は、種類を不明として扱う', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` のテストです。最初のコミットの一覧が空でメッセージが存在しない場合に、理由に `unknown update type` を含めることを確認します。')
    const node = stepSync('`pr` を呼ぶ', () => pr())

    stepSync('結果を比べる', () => {
      expect(waitingReasons({ ...node, firstCommits: { nodes: [] } }, NOW)).toEqual(['unknown update type'])
    })
  })
})

describe('waitingReasons の状態', () => {
  it.for(['FAILURE', 'ERROR'])('検証が %s の場合は、検証の失敗を理由にする', async (rollup) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` の状態の判定のテストです。検証の状態が \`${rollup}\` の場合に、理由に \`checks failed\` を含めることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ rollup }), NOW)).toEqual(['checks failed'])
    })
  })

  it('検証が PENDING で 24 時間以内の場合は、待っている PR に含めない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。検証が `PENDING` のまま、PR の作成から 24 時間以内の場合に、理由が空の配列になることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ rollup: 'PENDING', age: 23 * HOUR }), NOW)).toEqual([])
    })
  })

  it.for(['PENDING', 'EXPECTED', JSON_NULL])('検証が %j のまま 24 時間を超えた場合は、検証の停滞を理由にする', async (rollup) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` の状態の判定のテストです。検証の状態が \`${JSON.stringify(rollup)}\` のまま 24 時間を超えた場合に、理由に \`checks not finishing\` を含めることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ rollup, age: 25 * HOUR }), NOW)).toEqual(['checks not finishing'])
    })
  })

  it.for([
    { age: 24 * HOUR, expected: [] },
    { age: 24 * HOUR + 1000, expected: ['checks not finishing'] },
  ])('PR の作成から $age ミリ秒たった PENDING の理由は、$expected になる', async ({ age, expected }) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` の状態の判定のテストです。検証が \`PENDING\` のまま、PR の作成から ${String(age)} ミリ秒たった場合に、24 時間ちょうどでは理由が空になり、超えると \`checks not finishing\` を含めることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ rollup: 'PENDING', age }), NOW)).toEqual(expected)
    })
  })

  it('検証の停滞は、auto-merge が有効な PR にだけ当てはめる', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。auto-merge が有効でない PR は、検証が停滞していても、`checks not finishing` ではなく `no auto-merge` を理由にすることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ autoMerge: false, rollup: 'PENDING', age: 25 * HOUR }), NOW)).toEqual(['no auto-merge'])
    })
  })

  it.for([
    { age: 30 * MINUTE, expected: [] },
    { age: 30 * MINUTE + 1000, expected: ['no auto-merge'] },
  ])('auto-merge が有効でない PR は、$age ミリ秒たつと $expected になる', async ({ age, expected }) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` の状態の判定のテストです。auto-merge が有効でない PR を、作成から ${String(age)} ミリ秒たった時点で判定した場合に、30 分ちょうどでは理由が空になり、超えると \`no auto-merge\` を含めることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ autoMerge: false, age }), NOW)).toEqual(expected)
    })
  })

  it.for([
    { baseAge: 30 * MINUTE, expected: [] },
    { baseAge: 30 * MINUTE + 1000, expected: ['conflict'] },
  ])('base が $baseAge ミリ秒前に進んでいて競合している場合は、$expected になる', async ({ baseAge, expected }) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` の状態の判定のテストです。base のブランチが ${String(baseAge)} ミリ秒前に進み、PR が競合している場合に、30 分ちょうどでは理由が空になり、超えると \`conflict\` を含めることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age: 2 * HOUR, baseAge }), NOW)).toEqual(expected)
    })
  })

  it.for([
    { age: 30 * MINUTE, expected: [] },
    { age: 30 * MINUTE + 1000, expected: ['conflict'] },
  ])('最後の push が $age ミリ秒前で競合している場合は、$expected になる', async ({ age, expected }) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` の状態の判定のテストです。最後の push が ${String(age)} ミリ秒前で、PR が競合している場合に、30 分ちょうどでは理由が空になり、超えると \`conflict\` を含めることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age }), NOW)).toEqual(expected)
    })
  })

  it('base の時刻を読み取れなくても、push の時刻で競合を判定する', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。base のコミットの日時を読み取れない場合でも、最後の push の時刻から競合を判定し、理由に `conflict` を含めることを確認します。')
    const node = stepSync('`pr` を呼ぶ', () => pr({ mergeable: 'CONFLICTING', age: 2 * HOUR }))

    stepSync('結果を比べる', () => {
      expect(waitingReasons({ ...node, baseRef: { target: {} } }, NOW)).toEqual(['conflict'])
    })
  })

  it('rebase より前の dequeue が猶予時間の中なら、待っている PR に含めない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。merge queue からの除外（dequeue）が force push（rebase）より前で、猶予時間の中の場合に、理由が空の配列になることを確認します。')
    const events: PrOptions['events'] = stepSync('入力を用意する', () => [['RemovedFromMergeQueueEvent', 4 * HOUR], ['HeadRefForcePushedEvent', 10 * MINUTE]])

    stepSync('結果を比べる', () => {
      expect(waitingReasons(pr({ autoMerge: false, age: 5 * HOUR, events }), NOW)).toEqual([])
    })
  })

  it('古い dequeue の後に auto-merge が戻っていれば、待っている PR に含めない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。古い dequeue の後に force push があり、auto-merge が有効に戻っている場合に、理由が空の配列になることを確認します。')
    const events: PrOptions['events'] = stepSync('入力を用意する', () => [['RemovedFromMergeQueueEvent', 4 * HOUR], ['HeadRefForcePushedEvent', HOUR]])

    stepSync('結果を比べる', () => {
      expect(waitingReasons(pr({ age: 5 * HOUR, events }), NOW)).toEqual([])
    })
  })

  it('force push をすると、24 時間の起点が force push の時刻に戻る', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。PR の作成から 72 時間たっていても、直前の force push を起点に数えるため、検証が `PENDING` なら理由は空の配列になることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ rollup: 'PENDING', age: 72 * HOUR, events: [['HeadRefForcePushedEvent', HOUR]] }), NOW)).toEqual([])
    })
  })

  it('猶予時間の中の競合は、待っている PR に含めない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。PR が競合していても、最後の push から猶予時間の中の場合に、理由が空の配列になることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age: 10 * MINUTE }), NOW)).toEqual([])
    })
  })

  it('猶予時間を過ぎた競合は、待っている PR に含める', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。PR が競合し、最後の push から猶予時間を過ぎている場合に、理由に `conflict` を含めることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age: 2 * HOUR }), NOW)).toEqual(['conflict'])
    })
  })

  it('base が進んだ直後の競合は、待っている PR に含めない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。PR が競合していても、base のブランチが進んでから猶予時間の中の場合に、理由が空の配列になることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ mergeable: 'CONFLICTING', age: 2 * HOUR, baseAge: 5 * MINUTE }), NOW)).toEqual([])
    })
  })

  it('mergeable が UNKNOWN の場合は、理由にしない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。`mergeable` が `UNKNOWN` の場合に、競合を判定できないため、理由が空の配列になることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ mergeable: 'UNKNOWN', age: 2 * HOUR }), NOW)).toEqual([])
    })
  })

  it('最後の push の後に dequeue されていれば、dequeued を理由にする', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。最後の push の後に merge queue から除外された場合に、理由に `dequeued` を含めることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ autoMerge: false, age: 2 * HOUR, events: [['RemovedFromMergeQueueEvent', 5 * MINUTE]] }), NOW)).toEqual(['dequeued'])
    })
  })

  it('rebase より前の dequeue は、猶予時間を過ぎていれば no auto-merge を理由にする', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。dequeue が force push（rebase）より前で、猶予時間を過ぎている場合に、`dequeued` ではなく `no auto-merge` を理由にすることを確認します。')
    const events: PrOptions['events'] = stepSync('入力を用意する', () => [['RemovedFromMergeQueueEvent', 4 * HOUR], ['HeadRefForcePushedEvent', HOUR]])

    stepSync('結果を比べる', () => {
      expect(waitingReasons(pr({ autoMerge: false, age: 5 * HOUR, events }), NOW)).toEqual(['no auto-merge'])
    })
  })

  it('猶予時間の中の auto-merge なしは、待っている PR に含めない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。auto-merge が有効でなくても、PR の作成から猶予時間の中の場合に、理由が空の配列になることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ autoMerge: false, age: 10 * MINUTE, rollup: JSON_NULL }), NOW)).toEqual([])
    })
  })

  it('猶予時間を過ぎた auto-merge なしは、待っている PR に含める', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。auto-merge が有効でなく、PR の作成から猶予時間を過ぎている場合に、理由に `no auto-merge` を含めることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ autoMerge: false, age: HOUR }), NOW)).toEqual(['no auto-merge'])
    })
  })

  it('merge queue に入っていれば、待っている PR に含めない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。auto-merge が有効でなくても、merge queue に入っている場合に、理由が空の配列になることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ autoMerge: false, queue: true, age: HOUR }), NOW)).toEqual([])
    })
  })

  it('検証の失敗と競合は、両方を理由に含める', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。検証の失敗と競合が同時に起きている場合に、`checks failed` と `conflict` の両方を理由に含めることを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons(pr({ rollup: 'FAILURE', mergeable: 'CONFLICTING', age: 2 * HOUR }), NOW)).toEqual(['checks failed', 'conflict'])
    })
  })

  it('作成時刻を読み取れない場合は、理由を追加しない', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。PR の作成時刻が日時として読み取れない場合に、時間に関する理由を追加しないことを確認します。')
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: 'yesterday' }, NOW)).toEqual([])
    })
  })

  it.for([
    { name: 'タイムゾーンが無い', value: '2026-11-09T00:00:00' },
    { name: '日付だけ', value: '2026-11-09' },
    { name: '存在しない日', value: '2026-02-30T00:00:00Z' },
    { name: '24 時', value: '2026-11-09T24:00:00Z' },
    { name: '秒が 60', value: '2026-11-09T00:00:60Z' },
    { name: 'オフセットが 24 時間', value: '2026-11-09T00:00:00+24:00' },
    { name: '末尾に改行', value: '2026-11-09T00:00:00Z\n' },
  ])('作成時刻が「$name」の形の場合は、読み取れない時刻として扱う', async ({ name, value }) => {
    await explains(`dependabot の PR のうち、人の対応を待っている PR の理由を判定する、\`waitingReasons\` の状態の判定のテストです。作成時刻が「${name}」の形（\`${JSON.stringify(value)}\`）の場合に、日時として読み取れないため、理由が空の配列になることを確認します。`)
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: value }, NOW)).toEqual([])
    })
  })

  it('オフセット付きの時刻は、UTC に直して比較する', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。作成時刻が `+09:00` のようにオフセット付きの場合に、UTC に直して現在時刻と比較し、`no auto-merge` を理由にすることを確認します。')
    // 2026-11-09T20:00:00+09:00 は 11:00Z で、NOW の 1 時間前
    stepSync('`waitingReasons` を呼び、結果を比べる', () => {
      expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: '2026-11-09T20:00:00+09:00' }, NOW)).toEqual(['no auto-merge'])
    })
  })

  it('小数秒付きの時刻は、マイクロ秒まで読み取る', async () => {
    await explains('dependabot の PR のうち、人の対応を待っている PR の理由を判定する、`waitingReasons` の状態の判定のテストです。作成時刻が小数秒付きの場合に、マイクロ秒の単位まで比較し、猶予時間ちょうどでは理由が空になり、1 マイクロ秒でも超えれば `no auto-merge` を含めることを確認します。')
    const { exactly, later } = stepSync('入力を用意する', () => {
      const exactly = '2026-11-09T11:30:00.000000Z'
      const later = '2026-11-09T11:29:59.999999Z'
      return { exactly, later }
    })

    stepSync('結果を比べる', () => {
      expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: exactly }, NOW)).toEqual([])
      expect(waitingReasons({ ...pr({ autoMerge: false }), createdAt: later }, NOW)).toEqual(['no auto-merge'])
    })
  })
})

describe('checksLabel と rollupState', () => {
  it.for([
    { state: 'SUCCESS', label: 'passed' },
    { state: 'FAILURE', label: 'failed' },
    { state: 'ERROR', label: 'failed' },
    { state: 'PENDING', label: 'pending' },
    { state: 'EXPECTED', label: 'pending' },
    { state: undefined, label: 'none' },
  ])('検証が $state の場合は、$label と表示する', async ({ state, label }) => {
    await explains(`検証（チェック）の状態を扱う、\`checksLabel\` と \`rollupState\` のテストです。検証の状態が \`${String(state)}\` の場合に、表示用のラベルとして \`${label}\` を返すことを確認します。`)
    stepSync('`checksLabel` を呼び、結果を比べる', () => {
      expect(checksLabel(state)).toBe(label)
    })
  })

  it('最後のコミットの検証の状態を返す', async () => {
    await explains('検証（チェック）の状態を扱う、`checksLabel` と `rollupState` のテストです。PR の最後のコミットの検証の状態（`FAILURE` など）を返すことを確認します。')
    stepSync('`rollupState` を呼び、結果を比べる', () => {
      expect(rollupState(pr({ rollup: 'FAILURE' }))).toBe('FAILURE')
    })
  })

  it.for([{ name: '検証が無い', node: pr({ rollup: JSON_NULL }) }, { name: 'commit が無い', node: {} }])('$name の場合は、undefined を返す', async ({ name, node }) => {
    await explains(`検証（チェック）の状態を扱う、\`checksLabel\` と \`rollupState\` のテストです。「${name}」場合に、検証の状態を取り出せず、\`undefined\` を返すことを確認します。`)
    stepSync('`rollupState` を呼び、結果を比べる', () => {
      expect(rollupState(node)).toBeUndefined()
    })
  })
})

function entry(number: number, title = 'Bump a', ...reasons: readonly string[]): PrEntry {
  return { number, title, url: `https://github.com/o/r/pull/${String(number)}`, reasons: reasons.length > 0 ? reasons : ['major'], checks: 'failed' }
}

const OLD_FORM_BODY = [
  '<!-- pecot-dependabot-pr: tracker -->',
  '',
  '<!-- pecot-dependabot-pr: list-begin -->',
  '| PR | 待っている理由 |',
  '|---|---|',
  '| <!-- pecot-dependabot-pr: pr/120 --> [#120](https://github.com/o/r/pull/120) `build(repo): bump ajv from 6.15.0 to 8.20.0` | major |',
  '| <!-- pecot-dependabot-pr: pr/166 --> [#166](https://github.com/o/r/pull/166) `build(repo): bump jsdom from 29.1.1 to 31.0.0` | major |',
  '<!-- pecot-dependabot-pr: list-end -->',
].join('\n')

describe('Tracker の本文', () => {
  it('新しい本文は、目印のコメントと表を持つ', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。既存の本文がない場合に、Tracker の目印のコメント、一覧の目印、見出し、`title`・`PR`・`checks` の列を持つ表を作成することを確認します。')
    stepSync('`renderTrackerBody` を呼び、結果を比べる', () => {
      expect(renderTrackerBody([entry(2, 'Bump a', 'major', 'conflict')])).toBe([
        '<!-- pecot-dependabot-pr: tracker -->',
        '',
        '<!-- pecot-dependabot-pr: list-begin -->',
        '## dependabot PR',
        '',
        '| title | PR | checks |',
        '|---|---|---|',
        '| <!-- pecot-dependabot-pr: pr/2 --> `Bump a` | [#2](https://github.com/o/r/pull/2) | failed |',
        '<!-- pecot-dependabot-pr: list-end -->',
        '',
      ].join('\n'))
    })
  })

  it('scope 付きの題は、メンションにならないようにコードスパンにする', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。題に `@vueuse/core` のように `@` で始まる scope が含まれる場合に、GitHub のメンションにならないよう題をコードスパンで囲み、その PR の番号を読み取れることを確認します。')
    const body = stepSync('`renderTrackerBody` を呼ぶ', () => renderTrackerBody([entry(4, 'Bump @vueuse/core from 1.0.0 to 1.1.0')]))

    stepSync('結果を比べる', () => {
      expect(body).toContain('`Bump @vueuse/core from 1.0.0 to 1.1.0`')
      expect(parseTrackerPullRequestNumbers(body)).toEqual([4])
    })
  })

  it('題にバッククォートがある場合は、コードスパンの囲みを長くする', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。題にバッククォートや `|` が含まれる場合に、コードスパンの囲みのバッククォートを題より長くし、`|` をエスケープすることを確認します。')
    stepSync('`renderTrackerBody` を呼び、結果を比べる', () => {
      expect(renderTrackerBody([entry(4, 'Bump `@scope/pkg` | x')])).toContain('``Bump `@scope/pkg` \\| x``')
      expect(renderTrackerBody([entry(5, '`@scope/pkg`')])).toContain('`` `@scope/pkg` ``')
    })
  })

  it('題の改行と前後の空白は、1 つの空白にまとめる', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。題に改行や連続する空白、前後の空白がある場合に、1 つの空白にまとめて 1 行で表示することを確認します。')
    stepSync('`renderTrackerBody` を呼び、結果を比べる', () => {
      expect(renderTrackerBody([entry(6, '  a \r\n  b\nc  ')])).toContain('`a b c`')
    })
  })

  it('作成した本文から、PR の番号を番号順に読み取れる', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。PR の番号を 5、2 の順で渡した場合でも、作成した本文から 2、5 の番号順に読み取れることを確認します。')
    const body = stepSync('`renderTrackerBody` を呼ぶ', () => renderTrackerBody([entry(5), entry(2)]))

    stepSync('結果を比べる', () => {
      expect(parseTrackerPullRequestNumbers(body)).toEqual([2, 5])
    })
  })

  it('一覧の外の文は残し、一覧だけを書き直す', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。既存の本文の一覧の後ろへ人が注記を書いた場合に、注記を残して一覧だけを書き直すことを確認します。')
    const { body } = stepSync('`renderTrackerBody` を呼ぶ', () => {
      const existing = renderTrackerBody([entry(1)]).replace(LIST_END, () => `${LIST_END}\n\n人の注記`)
      const body = renderTrackerBody([entry(2)], existing)
      return { body }
    })

    stepSync('結果を比べる', () => {
      expect(body.endsWith('list-end -->\n\n人の注記\n')).toBe(true)
      expect(body).not.toContain('pr/1 ')
      expect(body).toContain('pr/2 ')
    })
  })

  it('既存の本文の改行 CRLF は、LF にそろえて書き直す', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。既存の本文の改行が `\\r\\n` の場合に、書き直した本文を `\\n` にそろえ、`\\r` を含めないことを確認します。')
    const existing = stepSync('`replaceAll` を呼ぶ', () => renderTrackerBody([entry(1)]).replaceAll('\n', '\r\n'))

    stepSync('結果を比べる', () => {
      expect(renderTrackerBody([entry(2)], existing)).not.toContain('\r')
    })
  })

  it('題の内容にかかわらず、表の列がずれない', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。題に `|` や PR の目印のコメントに似た文字列が含まれる場合でも、本文から読み取れる PR の番号が正しいままであることを確認します。')
    const body = stepSync('`renderTrackerBody` を呼ぶ', () => renderTrackerBody([entry(3, 'a | b <!-- pecot-dependabot-pr: pr/99 -->')]))

    stepSync('結果を比べる', () => {
      expect(parseTrackerPullRequestNumbers(body)).toEqual([3])
    })
  })

  it('題に | とバッククォートがあっても、表の区切りは 4 つのままにする', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。題に `|` とバッククォートが含まれる場合でも、エスケープされていない表の区切りが 1 行に 4 つであることを確認します。')
    const { line } = stepSync('`renderTrackerBody` を呼び、PR の行を取り出す', () => {
      const body = renderTrackerBody([entry(3, 'a | `b` | c')])
      const line = body.split('\n').find(candidate => candidate.includes('pr/3 ')) ?? ''
      return { line }
    })

    stepSync('結果を比べる', () => {
      expect(line.match(/(?<!\\)\|/gu)).toHaveLength(4)
    })
  })

  it('一覧が空の場合は、none だけを書く', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。PR の一覧が空の場合に、一覧の範囲に見出しと `none` だけを書き、読み取れる番号がないことを確認します。')
    const { body, begin } = stepSync('`renderTrackerBody` を呼ぶ', () => {
      const body = renderTrackerBody([])
      const begin = body.indexOf(LIST_BEGIN) + LIST_BEGIN.length
      return { body, begin }
    })

    stepSync('結果を比べる', () => {
      expect(body.slice(begin, body.indexOf(LIST_END))).toBe('\n## dependabot PR\n\nnone\n')
      expect(parseTrackerPullRequestNumbers(body)).toEqual([])
    })
  })

  it('前の形式（2 列）の本文も読み取れる', async () => {
    await explains('Tracker の本文から PR の番号を読み取る、`parseTrackerPullRequestNumbers` のテストです。列が `PR` と `待っている理由` の前の形式の本文でも、PR の番号を読み取れることを確認します。')
    stepSync('`parseTrackerPullRequestNumbers` を呼び、結果を比べる', () => {
      expect(parseTrackerPullRequestNumbers(OLD_FORM_BODY)).toEqual([120, 166])
    })
  })

  it('前の形式の本文は、一覧の外の文を残して、今の形式に書き直す', async () => {
    await explains('dependabot の PR の一覧を載せる Tracker の本文を作成する、`renderTrackerBody` のテストです。前の形式の本文を既存の本文として渡した場合に、一覧の外の注記を残して、今の形式（`title`・`PR`・`checks` の列）に書き直すことを確認します。')
    const body = stepSync('`renderTrackerBody` を呼ぶ', () => renderTrackerBody([entry(120)], `${OLD_FORM_BODY}\n\n人の注記\n`))

    stepSync('結果を比べる', () => {
      expect(body).toContain('| title | PR | checks |')
      expect(body).not.toContain('待っている理由')
      expect(body).not.toContain('pr/166 ')
      expect(body.endsWith('list-end -->\n\n人の注記\n')).toBe(true)
    })
  })

  it('本文が存在しない場合は、目印がないため DependabotPrError の例外が発生する', async () => {
    await explains('Tracker の本文から PR の番号を読み取る、`parseTrackerPullRequestNumbers` のテストです。本文が `undefined` の場合に、目印を見つけられず、`DependabotPrError` の例外が発生することを確認します。')
    stepSync('`parseTrackerPullRequestNumbers` を呼び、結果を比べる', () => {
      expect(() => parseTrackerPullRequestNumbers(undefined)).toThrow(DependabotPrError)
    })
  })

  it.for(['no markers', `${LIST_END}\n${LIST_BEGIN}`, `${LIST_BEGIN}\n${LIST_BEGIN}\n${LIST_END}`])('目印のコメントが 1 組でない本文 %j は、読み取りと書き込みの両方で DependabotPrError の例外が発生する', async (body) => {
    await explains(`Tracker の本文から PR の番号を読み取る、\`parseTrackerPullRequestNumbers\` のテストです。一覧の目印が 1 組でない本文 \`${JSON.stringify(body)}\` の場合に、読み取りと作成のどちらでも \`DependabotPrError\` の例外が発生することを確認します。`)
    stepSync('`parseTrackerPullRequestNumbers` を呼び、結果を比べる', () => {
      expect(() => parseTrackerPullRequestNumbers(body)).toThrow(DependabotPrError)
      expect(() => renderTrackerBody([], body)).toThrow(DependabotPrError)
    })
  })

  it('表の行でない行にある目印は、PR の番号に数えない', async () => {
    await explains('Tracker の本文から PR の番号を読み取る、`parseTrackerPullRequestNumbers` のテストです。表の行ではない注記の行に PR の目印がある場合に、その番号を除き、表の行にある番号だけを返すことを確認します。')
    const body = stepSync('入力を用意する', () => `${LIST_BEGIN}\nnote <!-- pecot-dependabot-pr: pr/9 -->\n| <!-- pecot-dependabot-pr: pr/3 --> x |\n${LIST_END}`)

    stepSync('結果を比べる', () => {
      expect(parseTrackerPullRequestNumbers(body)).toEqual([3])
    })
  })

  it('Tracker の目印を持つ本文だけに、TRACKER_PATTERN が一致する', async () => {
    await explains('Tracker の本文かどうかを判定する、`TRACKER_PATTERN` のテストです。作成した Tracker の本文には一致し、目印のない文字列には一致しないことを確認します。')
    stepSync('`renderTrackerBody` を呼び、結果を比べる', () => {
      expect(TRACKER_PATTERN.test(renderTrackerBody([]))).toBe(true)
      expect(TRACKER_PATTERN.test('none')).toBe(false)
    })
  })

  it('Tracker の題は、作成した日を含む', async () => {
    await explains('Tracker の題を作成する、`buildTrackerTitle` のテストです。日付を渡した場合に、`[Tracker] dependabot PR — 2026-11-09` の形の題を返すことを確認します。')
    stepSync('`buildTrackerTitle` を呼び、結果を比べる', () => {
      expect(buildTrackerTitle('2026-11-09')).toBe('[Tracker] dependabot PR — 2026-11-09')
    })
  })
})

describe('planTracker', () => {
  it('Tracker が存在せず、載せる行がある場合は、Tracker を作成する', async () => {
    await explains('Tracker の作成や更新の内容を決める、`planTracker` のテストです。Tracker が存在せず、載せる PR がある場合に、Tracker を作成する計画になり、閉じる計画にはならないことを確認します。')
    const plan = stepSync('`planTracker` を呼ぶ', () => planTracker([entry(1)], undefined))

    stepSync('結果を比べる', () => {
      expect(plan.create).toBe(true)
      expect(plan.close).toBe(false)
      expect(plan.added.map(added => added.number)).toEqual([1])
    })
  })

  it('Tracker が存在せず、載せる行もない場合は、何もしない', async () => {
    await explains('Tracker の作成や更新の内容を決める、`planTracker` のテストです。Tracker と載せる PR が存在しない場合に、作成と閉じる処理のどちらも行わない計画になることを確認します。')
    const plan = stepSync('`planTracker` を呼ぶ', () => planTracker([], undefined))

    stepSync('結果を比べる', () => {
      expect([plan.create, plan.close]).toEqual([false, false])
    })
  })

  it('行の追加と削除を、番号順に返す', async () => {
    await explains('Tracker の作成や更新の内容を決める、`planTracker` のテストです。Tracker に載っている番号と、今の PR の番号が異なる場合に、一覧を番号順に並べ、追加する行と削除する番号も番号順に返すことを確認します。')
    const plan = stepSync('`planTracker` を呼ぶ', () => planTracker([entry(3), entry(2)], [4, 1, 2]))

    stepSync('結果を比べる', () => {
      expect(plan.entries.map(row => row.number)).toEqual([2, 3])
      expect(plan.added.map(added => added.number)).toEqual([3])
      expect(plan.removed).toEqual([1, 4])
      expect([plan.create, plan.close]).toEqual([false, false])
    })
  })

  it('Tracker が存在し、載せる行がない場合は、Tracker を閉じる', async () => {
    await explains('Tracker の作成や更新の内容を決める、`planTracker` のテストです。Tracker が存在し、載せる PR がなくなった場合に、Tracker を閉じる計画になり、載っていた番号が削除の対象になることを確認します。')
    const plan = stepSync('`planTracker` を呼ぶ', () => planTracker([], [1]))

    stepSync('結果を比べる', () => {
      expect(plan.close).toBe(true)
      expect(plan.removed).toEqual([1])
    })
  })
})

function withType(type: string): string {
  return `x\n\n---\nupdated-dependencies:\n- dependency-name: a\n  update-type: ${type}\n...\n`
}

describe('parseUpdateMetadata の Python との細部', () => {
  it.for([
    { type: 'semver-semver-minor', expected: 'minor' },
    { type: 'foo-semver-major', expected: 'major' },
  ])('update-type が $type の場合は、最後の semver- より後ろを種類にする', async ({ type, expected }) => {
    await explains(`dependabot の PR のコミットメッセージから更新の種類を取り出す、\`parseUpdateMetadata\` のテストです。\`update-type\` が \`${type}\` の場合に、最後の \`semver-\` より後ろの \`${expected}\` を、Python の実装と同じく種類として返すことを確認します。`)
    stepSync('`parseUpdateMetadata` を呼び、結果を比べる', () => {
      expect(parseUpdateMetadata(withType(type))).toEqual([['a', expected]])
    })
  })

  it.for([
    { range: 'from v1.0 to 1.v1', expected: 'minor' },
    { range: 'from 1.0 to 1v.0', expected: 'patch' },
  ])('版が $range の場合は、v の位置にかかわらず最初の 1 つを取り除く', async ({ range, expected }) => {
    await explains(`dependabot の PR のコミットメッセージから更新の種類を取り出す、\`parseUpdateMetadata\` のテストです。\`Bumps\` の行の版が \`${range}\` の場合に、先頭の \`v\` の有無にかかわらず最初の 1 つだけを取り除き、\`${expected}\` を返すことを確認します。`)
    const text = stepSync('入力を用意する', () => `Bumps [a] ${range}.\n\n---\nupdated-dependencies:\n- dependency-name: a\n...\n`)

    stepSync('結果を比べる', () => {
      expect(parseUpdateMetadata(text)).toEqual([['a', expected]])
    })
  })
})
