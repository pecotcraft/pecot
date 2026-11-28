import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { JSON_NULL } from '../json-null.js'
import { PecotError } from '../errors.js'
import {
  FrontmatterError,
  parseFrontmatter,
  parsePullRequestContent,
  stripFrontmatter,
  stripLeadingHtmlComment,
  validateIssueFrontmatter,
  validatePullRequestFrontmatter,
} from '../frontmatter.js'

function catchFrontmatterError(run: () => unknown): FrontmatterError {
  try {
    run()
  }
  catch (error: unknown) {
    if (error instanceof FrontmatterError) return error
    throw error
  }
  throw new Error('FrontmatterError was not thrown')
}

const ISSUE_BASE = { title: 'テスト', type: 'task', repository: 'owner/repo', status: 'ready' }

describe('FrontmatterError', () => {
  it('FrontmatterError は PecotError を継承する', async () => {
    await explains('フロントマターの誤りを表す例外 `FrontmatterError` のテストです。`PecotError` を継承していることを確認します。')
    stepSync('FrontmatterError を呼び、結果を比べる', () => {
      expect(new FrontmatterError('x')).toBeInstanceOf(PecotError)
    })
  })
})

describe('validateIssueFrontmatter', () => {
  it('必須のフィールドだけを渡すと、labels を空配列、parent_epic を undefined にして返す', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。必須のフィールドだけを渡した場合に、指定した値をそのまま返し、`labels` を空の配列、`parent_epic` を `undefined` にすることを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ title: 'テスト機能の実装', type: 'task', repository: 'owner/repo', status: 'ready' }))
    stepSync('結果を比べる', () => {
      expect(fm.title).toBe('テスト機能の実装')
      expect(fm.type).toBe('task')
      expect(fm.repository).toBe('owner/repo')
      expect(fm.status).toBe('ready')
      expect(fm.labels).toEqual([])
      expect(fm.parent_epic).toBeUndefined()
    })
  })

  it('すべてのフィールドを渡すと、渡した値をそのまま返す', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。すべてのフィールドを渡した場合に、渡した値をそのまま返すことを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({
      title: 'バグ修正',
      type: 'bug',
      repository: 'owner/repo',
      status: 'active',
      labels: ['bug', 'urgent'],
      parent_epic: 123,
      order: 1,
    }))
    stepSync('結果を比べる', () => {
      expect(fm.type).toBe('bug')
      expect(fm.status).toBe('active')
      expect(fm.labels).toEqual(['bug', 'urgent'])
      expect(fm.parent_epic).toBe(123)
      expect(fm.order).toBe(1)
    })
  })

  it.for([
    { name: 'priority: high', extra: { priority: 'high' } },
    { name: 'size: s', extra: { size: 's' } },
    { name: '選べない値の priority: urgent', extra: { priority: 'urgent' } },
    { name: 'priority・size の空文字列', extra: { priority: '', size: '' } },
  ])('旧いテンプレートの $name を渡すと、止めずに読み捨てる', async ({ name, extra }) => {
    await explains(`Issue のフロントマターを検証する、\`validateIssueFrontmatter\` のテストです。旧いテンプレートで使っていた ${name} を渡した場合に、エラーにせず、その項目を除いた結果を返すことを確認します。`)
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, ...extra }))
    stepSync('結果を比べる', () => {
      expect(fm).toEqual({ ...ISSUE_BASE, blocked_by: [], labels: [] })
    })
  })

  it('定義にない type を渡すと、FrontmatterError の例外が発生する', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。定義にない `type` を渡した場合に、`FrontmatterError` の例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, type: 'invalid' })).toThrow(FrontmatterError)
    })
  })

  it('定義にない status を渡すと、FrontmatterError の例外が発生する', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。定義にない `status` を渡した場合に、`FrontmatterError` の例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, status: 'invalid' })).toThrow(FrontmatterError)
    })
  })

  it('parent_epic と order に空文字列を渡すと、未指定として扱う', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`parent_epic` と `order` に空文字列を渡した場合に、どちらも `undefined`（未指定）になることを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: '', order: '' }))
    stepSync('結果を比べる', () => {
      expect(fm.parent_epic).toBeUndefined()
      expect(fm.order).toBeUndefined()
    })
  })

  it('parent_epic と order を両方渡すと、検証を通して両方の値を返す', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`parent_epic` と `order` を両方渡した場合に、検証を通り、両方の値を返すことを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 1 }))
    stepSync('結果を比べる', () => {
      expect(fm.parent_epic).toBe(353)
      expect(fm.order).toBe(1)
    })
  })

  it('parent_epic だけを渡すと、order を undefined にして返す', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`parent_epic` だけを渡した場合に、`order` を `undefined` にして返すことを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353 }))
    stepSync('結果を比べる', () => {
      expect(fm.parent_epic).toBe(353)
      expect(fm.order).toBeUndefined()
    })
  })

  it('status を省くと、undefined にして返す', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`status` を省略した場合に、`status` を `undefined` にして返すことを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(validateIssueFrontmatter({ title: 'T', type: 'task', repository: 'owner/repo' }).status).toBeUndefined()
    })
  })

  it.for([
    { name: 'docs', lane: 'docs', expected: 'docs' },
    { name: '空文字列', lane: '', expected: undefined },
    { name: 'null', lane: JSON_NULL, expected: undefined },
  ])('lane に $name を渡すと、$expected にして返す', async ({ name, lane, expected }) => {
    await explains(`Issue のフロントマターを検証する、\`validateIssueFrontmatter\` のテストです。\`lane\` に ${name} を渡した場合に、\`${String(expected)}\` を返すことを確認します。`)
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(validateIssueFrontmatter({ ...ISSUE_BASE, lane }).lane).toBe(expected)
    })
  })

  it('lane が文字列でないと、検証の誤りにする', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`lane` に文字列以外（配列）を渡した場合に、`FrontmatterError` の例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, lane: ['docs'] })).toThrow(FrontmatterError)
    })
  })

  it('blocked_by を省くと、空の一覧にして返す', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`blocked_by` を省略した場合と、空の配列や `null` を渡した場合に、どれも空の配列を返すことを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(validateIssueFrontmatter({ ...ISSUE_BASE }).blocked_by).toEqual([])
      expect(validateIssueFrontmatter({ ...ISSUE_BASE, blocked_by: [] }).blocked_by).toEqual([])
      expect(validateIssueFrontmatter({ ...ISSUE_BASE, blocked_by: JSON_NULL }).blocked_by).toEqual([])
    })
  })
})

describe('validateIssueFrontmatter の blocked_by', () => {
  const NO_STATUS = { title: 'テスト', type: 'task', repository: 'owner/repo' }

  it('wait を省略すると stack にし、issue と reason は渡した値で返す', async () => {
    await explains('Issue のフロントマターの `blocked_by` を検証する、`validateIssueFrontmatter` のテストです。`wait` を省略した前提は `stack` として扱い、`wait` が `merge` の前提は `reason` の前後の空白を除いて返すことを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1' }, { issue: 'acme/demo/3', wait: 'merge', reason: '  既定のブランチから配られる  ' }] }))
    stepSync('blocked_by を呼び、結果を比べる', () => {
      expect(fm.blocked_by).toEqual([
        { issue: 'phase1', wait: 'stack', reason: undefined },
        { issue: 'acme/demo/3', wait: 'merge', reason: '既定のブランチから配られる' },
      ])
    })
  })

  it('blocked_by があり status が blocked の場合は、検証を通す', async () => {
    await explains('Issue のフロントマターの `blocked_by` を検証する、`validateIssueFrontmatter` のテストです。`blocked_by` があり、`status` が `blocked` の場合に、検証を通り、`status` が `blocked` のまま返ることを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(validateIssueFrontmatter({ ...NO_STATUS, status: 'blocked', blocked_by: [{ issue: 'phase1' }] }).status).toBe('blocked')
    })
  })

  it('stack の前提に reason がある場合も、検証を通す', async () => {
    await explains('Issue のフロントマターの `blocked_by` を検証する、`validateIssueFrontmatter` のテストです。`wait` が `stack` の前提に `reason` がある場合でも、例外が発生しないことを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'stack', reason: '理由' }] })).not.toThrow()
    })
  })

  it('reason がない wait: merge は、merge-without-reason の誤りにする', async () => {
    await explains('Issue のフロントマターの `blocked_by` を検証する、`validateIssueFrontmatter` のテストです。`wait` が `merge` で `reason` が存在しない場合に、種類が `merge-without-reason` の `FrontmatterError` が発生することを確認します。')
    const error = stepSync('validateIssueFrontmatter を呼ぶ', () => catchFrontmatterError(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'merge' }] })))
    stepSync('結果を比べる', () => {
      expect(error.kind).toBe('merge-without-reason')
    })
  })

  it('reason が空白だけの wait: merge も、merge-without-reason の誤りにする', async () => {
    await explains('Issue のフロントマターの `blocked_by` を検証する、`validateIssueFrontmatter` のテストです。`wait` が `merge` で `reason` が空白だけの場合に、種類が `merge-without-reason` の `FrontmatterError` が発生することを確認します。')
    const error = stepSync('validateIssueFrontmatter を呼ぶ', () => catchFrontmatterError(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'merge', reason: ' '.repeat(3) }] })))
    stepSync('結果を比べる', () => {
      expect(error.kind).toBe('merge-without-reason')
    })
  })

  it('複数行の reason は、検証の誤りにする', async () => {
    await explains('Issue のフロントマターの `blocked_by` を検証する、`validateIssueFrontmatter` のテストです。`reason` が複数行の場合に、`reason must be a single line` を含むメッセージで例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'merge', reason: '一行目\n二行目' }] }))
        .toThrow('validation error:\n  - blocked_by.0.reason: Value error, reason must be a single line')
    })
  })

  it('wait が stack でも merge でもない場合は、選択肢を示すエラーにする', async () => {
    await explains('Issue のフロントマターの `blocked_by` を検証する、`validateIssueFrontmatter` のテストです。`wait` が `stack` でも `merge` でもない値の場合に、`stack` か `merge` を指定するよう示すメッセージで例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [{ issue: 'phase1', wait: 'later' }] }))
        .toThrow('  - blocked_by.0.wait: Input should be \'stack\' or \'merge\'')
    })
  })

  it.for([
    { name: 'issue が文字列でない', entry: { issue: 12 }, expected: '  - blocked_by.0.issue: Input should be a valid string' },
    { name: 'issue が存在しない', entry: { wait: 'stack' }, expected: '  - blocked_by.0.issue: Field required' },
    { name: 'issue が空', entry: { issue: ' ' }, expected: '  - blocked_by.0.issue: String should have at least 1 character' },
  ])('次の blocked_by を渡すと、検証の誤りにする: $name', async ({ name, entry, expected }) => {
    await explains(`Issue のフロントマターの \`blocked_by\` を検証する、\`validateIssueFrontmatter\` のテストです。「${name}」の場合に、\`${expected}\` を含むメッセージで例外が発生することを確認します。`)
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: [entry] })).toThrow(expected)
    })
  })

  it('blocked_by が配列でない場合は、検証の誤りにする', async () => {
    await explains('Issue のフロントマターの `blocked_by` を検証する、`validateIssueFrontmatter` のテストです。`blocked_by` に配列以外（文字列）を渡した場合に、`Input should be a valid list` を含むメッセージで例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...NO_STATUS, blocked_by: 'phase1' })).toThrow('  - blocked_by: Input should be a valid list')
    })
  })

  it.for([
    { name: 'blocked_by と status: ready の併記', input: { ...NO_STATUS, status: 'ready', blocked_by: [{ issue: 'phase1' }] }, expected: 'status: ready cannot be set together with blocked_by' },
    { name: 'blocked_by がない status: blocked', input: { ...NO_STATUS, status: 'blocked' }, expected: 'status: blocked requires blocked_by' },
    { name: 'blocked_by が空の status: blocked', input: { ...NO_STATUS, status: 'blocked', blocked_by: [] }, expected: 'status: blocked requires blocked_by' },
    { name: 'Epic の blocked_by', input: { ...NO_STATUS, type: 'epic', blocked_by: [{ issue: 'phase1' }] }, expected: 'blocked_by cannot be set for type epic' },
    { name: 'Tracker の blocked_by', input: { ...NO_STATUS, type: 'tracker', blocked_by: [{ issue: 'phase1' }] }, expected: 'blocked_by cannot be set for type tracker' },
  ])('次の指定をすると、検証の誤りにする: $name', async ({ name, input, expected }) => {
    await explains(`Issue のフロントマターの \`blocked_by\` を検証する、\`validateIssueFrontmatter\` のテストです。「${name}」を指定した場合に、\`validation error:\` に続けて \`${expected}\` を含むメッセージで例外が発生することを確認します。`)
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter(input)).toThrow(`validation error:\n  - : Value error, ${expected}`)
    })
  })
})

describe('validateIssueFrontmatter の parallel と order', () => {
  it('parallel に値がある場合は、種類 parallel の誤りにする', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` の `parallel` と `order` のテストです。`parallel` に値を渡した場合に、種類が `parallel` の `FrontmatterError` が発生することを確認します。')
    const error = stepSync('validateIssueFrontmatter を呼ぶ', () => catchFrontmatterError(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 4, parallel: 'b' })))
    stepSync('parallel を呼び、結果を比べる', () => {
      expect(error.kind).toBe('parallel')
    })
  })

  it('type の誤りなどほかの誤りと重なっても、種類 parallel の誤りを優先する', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` の `parallel` と `order` のテストです。`type` が不正で、同時に `parallel` に値がある場合でも、種類が `parallel` の誤りが優先されることを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(catchFrontmatterError(() => validateIssueFrontmatter({ ...ISSUE_BASE, type: 'nope', parallel: 'a' })).kind).toBe('parallel')
    })
  })

  it('order が存在しなくても、parallel に値があれば種類 parallel の誤りにする', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` の `parallel` と `order` のテストです。`order` を渡さない場合でも、`parallel` に値があれば、種類が `parallel` の誤りになることを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(catchFrontmatterError(() => validateIssueFrontmatter({ ...ISSUE_BASE, parallel: 'a' })).kind).toBe('parallel')
    })
  })

  it.for(['', JSON_NULL])('parallel が %j の場合は、検証を通す', async (value) => {
    await explains(`Issue のフロントマターを検証する、\`validateIssueFrontmatter\` の \`parallel\` と \`order\` のテストです。\`parallel\` が \`${JSON.stringify(value)}\` の場合に、例外が発生しないことを確認します。`)
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 4, parallel: value })).not.toThrow()
    })
  })

  it('order を指定して parent_epic が存在しない場合は、エラーにする', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` の `parallel` と `order` のテストです。`order` だけを指定した場合に、`parent_epic is required when order is set` を含むメッセージで例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, order: 1 })).toThrow('parent_epic is required when order is set')
    })
  })

  it('order が 0 の場合は、エラーにする', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` の `parallel` と `order` のテストです。`order` が `0` の場合に、1 以上の整数を求めるメッセージで例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: 0 })).toThrow('integer of 1 or more')
    })
  })

  it('order が負の値の場合は、エラーにする', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` の `parallel` と `order` のテストです。`order` が負の値の場合に、1 以上の整数を求めるメッセージで例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 353, order: -1 })).toThrow('integer of 1 or more')
    })
  })

  it('parent_epic に owner/repo/N の形式を指定でき、文字列のまま保持する', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`parent_epic` に `acme-labs/aist-roadmap/21` の形式を渡した場合に、文字列のまま返すことを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 'acme-labs/aist-roadmap/21', order: 1 }))
    stepSync('order を呼び、結果を比べる', () => {
      expect(fm.parent_epic).toBe('acme-labs/aist-roadmap/21')
      expect(fm.order).toBe(1)
    })
  })

  it('parent_epic の数字の文字列は、整数に変換する', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`parent_epic` に数字だけの文字列（`21`）を渡した場合に、整数の `21` に変換して返すことを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: '21', order: 1 }))
    stepSync('結果を比べる', () => {
      expect(fm.parent_epic).toBe(21)
    })
  })

  it('parent_epic の整数は、そのまま保持する', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`parent_epic` に整数を渡した場合に、同じ整数を返すことを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 21, order: 1 }))
    stepSync('結果を比べる', () => {
      expect(fm.parent_epic).toBe(21)
    })
  })

  it('template を省略すると、未指定として扱う', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`template` を省略した場合に、`template` が `undefined` になることを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(validateIssueFrontmatter(ISSUE_BASE).template).toBeUndefined()
    })
  })

  it('template に task-implement を指定すると、検証を通す', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`template` に `task-implement` を指定した場合に、その値を返すことを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(validateIssueFrontmatter({ ...ISSUE_BASE, title: 'フェーズ1', template: 'task-implement' }).template).toBe('task-implement')
    })
  })

  it('template が type と同じ値でも、検証を通す', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`template` に `type` と同じ `task` を指定した場合でも、その値を返すことを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(validateIssueFrontmatter({ ...ISSUE_BASE, template: 'task' }).template).toBe('task')
    })
  })

  it('定義にない template を指定すると、FrontmatterError の例外が発生する', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。定義にない `template` を指定した場合に、`FrontmatterError` の例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ ...ISSUE_BASE, template: 'invalid-template' })).toThrow(FrontmatterError)
    })
  })

  it('template に空文字列を渡すと、未指定として扱う', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`template` に空文字列を渡した場合に、`undefined`（未指定）になることを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(validateIssueFrontmatter({ ...ISSUE_BASE, template: '' }).template).toBeUndefined()
    })
  })

  it('template・parent_epic・order に null を渡すと、未指定として扱う', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`template`・`parent_epic`・`order` に `null` を渡した場合に、すべて `undefined`（未指定）になることを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, template: JSON_NULL, parent_epic: JSON_NULL, order: JSON_NULL }))
    stepSync('order を呼び、結果を比べる', () => {
      expect(fm.template).toBeUndefined()
      expect(fm.parent_epic).toBeUndefined()
      expect(fm.order).toBeUndefined()
    })
  })

  it('検証した値は、変更できないように凍結する', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。検証した結果のオブジェクトと、その `labels` が、`Object.freeze` で凍結されていることを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, labels: ['a'] }))
    stepSync('結果を比べる', () => {
      expect(Object.isFrozen(fm)).toBe(true)
      expect(Object.isFrozen(fm.labels)).toBe(true)
    })
  })

  it('エラーのメッセージは、validation error: の後に項目ごとの行を続ける', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。必須の項目が複数存在しない場合に、`validation error:` の後に、項目ごとの `Field required` の行が続くメッセージで例外が発生することを確認します。')
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(() => validateIssueFrontmatter({ title: 'T' })).toThrow(
        'validation error:\n  - type: Field required\n  - repository: Field required',
      )
    })
  })

  it('整数への変換では、前後の空白・小数部が 0 の文字列・数字の間の _ を受け付ける', async () => {
    await explains('Issue のフロントマターを検証する、`validateIssueFrontmatter` のテストです。`order` に ` 1_0 `・`2.0`・`true` を渡した場合に、Python と同じく整数の `10`・`2`・`1` に変換することを確認します。')
    const fm = stepSync('validateIssueFrontmatter を呼ぶ', () => validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 1, order: ' 1_0 ' }))
    stepSync('validateIssueFrontmatter を呼び、結果を比べる', () => {
      expect(fm.order).toBe(10)
      expect(validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 1, order: '2.0' }).order).toBe(2)
      expect(validateIssueFrontmatter({ ...ISSUE_BASE, parent_epic: 1, order: true }).order).toBe(1)
    })
  })
})

describe('parseFrontmatter', () => {
  it('title・type・repository・status と本文のあるコンテンツを渡すと、フロントマターと本文を取り出す', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。`title`・`type`・`repository`・`status` と本文があるコンテンツを渡した場合に、フロントマターの値と本文を取り出すことを確認します。')
    const result = stepSync('parseFrontmatter を呼ぶ', () => {
      const content = `---
title: テスト機能の実装
type: task
repository: owner/repo
status: ready
---

## 概要

これは本文です。
`
      const result = parseFrontmatter(content)
      return result
    })
    stepSync('結果を比べる', () => {
      expect(result.frontmatter.title).toBe('テスト機能の実装')
      expect(result.frontmatter.type).toBe('task')
      expect(result.frontmatter.repository).toBe('owner/repo')
      expect(result.frontmatter.status).toBe('ready')
      expect(result.body).toContain('## 概要')
      expect(result.body).toContain('これは本文です。')
    })
  })

  it('labels・parent_epic・order まで書いたコンテンツを渡すと、すべての値を取り出し、旧い priority・size を読み捨てる', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。`labels`・`parent_epic`・`order` まで書いたコンテンツを渡した場合に、すべての値を取り出し、旧い `priority` と `size` は結果に含めないことを確認します。')
    const result = stepSync('parseFrontmatter を呼ぶ', () => {
      const content = `---
title: Epic実装
type: epic
repository: org/project
status: backlog
priority: high
size: l
labels:
  - enhancement
  - epic
parent_epic: 42
order: 1
---

本文
`
      const result = parseFrontmatter(content)
      return result
    })
    stepSync('結果を比べる', () => {
      expect(result.frontmatter.title).toBe('Epic実装')
      expect(result.frontmatter.type).toBe('epic')
      expect(result.frontmatter.status).toBe('backlog')
      expect(result.frontmatter).not.toHaveProperty('priority')
      expect(result.frontmatter).not.toHaveProperty('size')
      expect(result.frontmatter.labels).toEqual(['enhancement', 'epic'])
      expect(result.frontmatter.parent_epic).toBe(42)
      expect(result.frontmatter.order).toBe(1)
    })
  })

  it('フロントマターが存在しない場合は、エラーにする', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。本文だけでフロントマターが存在しないコンテンツを渡した場合に、`frontmatter not found` のメッセージで例外が発生することを確認します。')
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(() => parseFrontmatter('# タイトル\n\n本文のみ\n')).toThrow('frontmatter not found (does not start with ---)')
    })
  })

  it('閉じられていないフロントマターは、エラーにする', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。フロントマターの終わりの `---` が存在しない場合に、`frontmatter is not closed` を含むメッセージで例外が発生することを確認します。')
    const content = stepSync('入力を用意する', () => `---
title: テスト
type: task
repository: owner/repo

本文（閉じタグなし）
`)
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(() => parseFrontmatter(content)).toThrow('frontmatter is not closed (missing closing ---)')
    })
  })

  it('YAML として不正なフロントマターは、エラーにする', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。YAML として不正なフロントマターを渡した場合に、メッセージが `failed to parse YAML:` で始まる例外が発生することを確認します。')
    const content = stepSync('入力を用意する', () => `---
title: テスト
type: epic: invalid
---

本文
`)
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(() => parseFrontmatter(content)).toThrow(/^failed to parse YAML: /u)
    })
  })

  it('YAML がマッピングでないフロントマターは、エラーにする', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。フロントマターが配列やコメントだけの場合に、`frontmatter must be a mapping` を含むメッセージで例外が発生することを確認します。')
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(() => parseFrontmatter('---\n- a\n- b\n---\n\n本文\n')).toThrow('frontmatter must be a mapping (key: value)')
      expect(() => parseFrontmatter('---\n# コメントだけ\n---\n\n本文\n')).toThrow('frontmatter must be a mapping (key: value)')
    })
  })

  it('必須のフィールドが存在しない場合は、エラーにする', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。`title` だけのように必須のフィールドが不足している場合に、`validation error` を含むメッセージで例外が発生することを確認します。')
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(() => parseFrontmatter('---\ntitle: テスト\n---\n\n本文\n')).toThrow('validation error')
    })
  })

  it('parent_epic・order が空文字列のとき、いずれも undefined にする', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。`parent_epic` と `order` が空文字列のコンテンツを渡した場合に、どちらも `undefined` になることを確認します。')
    const result = stepSync('parseFrontmatter を呼ぶ', () => {
      const content = [
        '---',
        'title: Epic実装',
        'type: epic',
        'repository: org/project',
        'status: backlog',
        'parent_epic: ""',
        'order: ""',
        '---',
        '',
        'Epic本文',
        '',
      ].join('\n')
      const result = parseFrontmatter(content)
      return result
    })
    stepSync('結果を比べる', () => {
      expect(result.frontmatter.parent_epic).toBeUndefined()
      expect(result.frontmatter.order).toBeUndefined()
    })
  })

  it('template を書いたコンテンツを渡すと、template の値を取り出す', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。`template` を書いたコンテンツを渡した場合に、`template` の値を取り出すことを確認します。')
    const result = stepSync('parseFrontmatter を呼ぶ', () => {
      const content = `---
title: フェーズ1実装
type: task
template: task-implement
repository: owner/repo
status: ready
---

## タスク概要

フェーズ1の実装タスク
`
      const result = parseFrontmatter(content)
      return result
    })
    stepSync('結果を比べる', () => {
      expect(result.frontmatter.template).toBe('task-implement')
      expect(result.frontmatter.type).toBe('task')
    })
  })

  it('template を書かないコンテンツを渡すと、template は undefined になる', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。`template` を書かないコンテンツを渡した場合に、`template` が `undefined` になることを確認します。')
    const content = stepSync('入力を用意する', () => `---
title: 通常タスク
type: task
repository: owner/repo
status: ready
---

## タスク概要

通常のタスク
`)
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(parseFrontmatter(content).frontmatter.template).toBeUndefined()
    })
  })

  it('本文の前後の空白を除去する', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。本文の前後に空行や空白がある場合に、それらを除いた本文を取り出すことを確認します。')
    const content = stepSync('入力を用意する', () => `---
title: テスト
type: task
repository: owner/repo
status: ready
---

   本文

`)
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(parseFrontmatter(content).body).toBe('本文')
    })
  })

  it('本文が空のとき、body を空文字列にする', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。フロントマターの後に本文が存在しない場合に、`body` が空文字列になることを確認します。')
    const content = stepSync('入力を用意する', () => `---
title: テスト
type: task
repository: owner/repo
status: ready
---
`)
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(parseFrontmatter(content).body).toBe('')
    })
  })

  it('YAML の型の判定は Python と同じにする（y は文字列、yes は真偽値）', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。`y` は文字列、`yes` は真偽値として扱い、文字列の `title` に `yes` を書いた場合は `Input should be a valid string` のメッセージで例外が発生することを確認します。')
    const result = stepSync('parseFrontmatter を呼ぶ', () => {
      const content = '---\ntitle: y\ntype: task\nrepository: o/r\nstatus: ready\nlabels: [n, "yes"]\n---\n\n本文\n'
      const result = parseFrontmatter(content)
      return result
    })
    stepSync('parseFrontmatter を呼び、結果を比べる', () => {
      expect(result.frontmatter.title).toBe('y')
      expect(result.frontmatter.labels).toEqual(['n', 'yes'])
      expect(() => parseFrontmatter('---\ntitle: yes\ntype: task\nrepository: o/r\nstatus: ready\n---\n')).toThrow('  - title: Input should be a valid string')
    })
  })

  it('改行が CRLF の本文でも、フロントマターを認識する', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。改行が `\\r\\n` のコンテンツを渡した場合にも、フロントマターと本文を取り出すことを確認します。')
    const result = stepSync('parseFrontmatter を呼ぶ', () => parseFrontmatter('---\r\ntitle: T\r\ntype: task\r\nrepository: o/r\r\nstatus: ready\r\n---\r\n\r\n本文\r\n'))
    stepSync('結果を比べる', () => {
      expect(result.frontmatter.title).toBe('T')
      expect(result.body).toBe('本文')
    })
  })
})

describe('validatePullRequestFrontmatter', () => {
  it('title・repository・base だけを渡すと、head を undefined、draft を false にして返す', async () => {
    await explains('PR のフロントマターを検証する、`validatePullRequestFrontmatter` のテストです。`title`・`repository`・`base` だけを渡した場合に、`head` を `undefined`、`draft` を `false` にして返すことを確認します。')
    const fm = stepSync('validatePullRequestFrontmatter を呼ぶ', () => validatePullRequestFrontmatter({ title: '機能追加', repository: 'owner/repo', base: 'develop-aist' }))
    stepSync('結果を比べる', () => {
      expect(fm.title).toBe('機能追加')
      expect(fm.repository).toBe('owner/repo')
      expect(fm.base).toBe('develop-aist')
      expect(fm.head).toBeUndefined()
      expect(fm.draft).toBe(false)
    })
  })

  it('head と draft まで渡すと、渡した値をそのまま返す', async () => {
    await explains('PR のフロントマターを検証する、`validatePullRequestFrontmatter` のテストです。`head` と `draft` まで渡した場合に、渡した値をそのまま返すことを確認します。')
    const fm = stepSync('validatePullRequestFrontmatter を呼ぶ', () => validatePullRequestFrontmatter({ title: 'バグ修正PR', repository: 'org/project', base: 'develop', head: 'feat/issue-123-fix-bug', draft: true }))
    stepSync('結果を比べる', () => {
      expect(fm.head).toBe('feat/issue-123-fix-bug')
      expect(fm.draft).toBe(true)
    })
  })

  it('screenshot は前後の空白を除き、空文字・null・未指定の場合は undefined にする', async () => {
    await explains('PR のフロントマターを検証する、`validatePullRequestFrontmatter` のテストです。`screenshot` の前後の空白を除いて返し、空白だけ・`null`・未指定の場合は `undefined` を返すことを確認します。')
    const base = stepSync('入力を用意する', () => ({ title: 'T', repository: 'o/r', base: 'develop' }))
    stepSync('validatePullRequestFrontmatter を呼び、結果を比べる', () => {
      expect(validatePullRequestFrontmatter({ ...base, screenshot: '  画面は変わらない  ' }).screenshot).toBe('画面は変わらない')
      expect(validatePullRequestFrontmatter({ ...base, screenshot: '  ' }).screenshot).toBeUndefined()
      expect(validatePullRequestFrontmatter({ ...base, screenshot: JSON_NULL }).screenshot).toBeUndefined()
      expect(validatePullRequestFrontmatter(base).screenshot).toBeUndefined()
    })
  })

  it('screenshot が文字列でない場合は、エラーにする', async () => {
    await explains('PR のフロントマターを検証する、`validatePullRequestFrontmatter` のテストです。`screenshot` に文字列以外（数値）を渡した場合に、`Input should be a valid string` を含むメッセージで例外が発生することを確認します。')
    stepSync('validatePullRequestFrontmatter を呼び、結果を比べる', () => {
      expect(() => validatePullRequestFrontmatter({ title: 'T', repository: 'o/r', base: 'develop', screenshot: 5 })).toThrow('  - screenshot: Input should be a valid string')
    })
  })

  it('title が存在しない場合は、エラーにする', async () => {
    await explains('PR のフロントマターを検証する、`validatePullRequestFrontmatter` のテストです。`title` が存在しない場合に、`title: Field required` を含むメッセージで例外が発生することを確認します。')
    stepSync('validatePullRequestFrontmatter を呼び、結果を比べる', () => {
      expect(() => validatePullRequestFrontmatter({ repository: 'owner/repo', base: 'develop' })).toThrow('  - title: Field required')
    })
  })

  it('repository が存在しない場合は、エラーにする', async () => {
    await explains('PR のフロントマターを検証する、`validatePullRequestFrontmatter` のテストです。`repository` が存在しない場合に、`repository: Field required` を含むメッセージで例外が発生することを確認します。')
    stepSync('validatePullRequestFrontmatter を呼び、結果を比べる', () => {
      expect(() => validatePullRequestFrontmatter({ title: 'テストPR', base: 'develop' })).toThrow('  - repository: Field required')
    })
  })

  it('base が存在しない場合は、エラーにする', async () => {
    await explains('PR のフロントマターを検証する、`validatePullRequestFrontmatter` のテストです。`base` が存在しない場合に、`base: Field required` を含むメッセージで例外が発生することを確認します。')
    stepSync('validatePullRequestFrontmatter を呼び、結果を比べる', () => {
      expect(() => validatePullRequestFrontmatter({ title: 'テストPR', repository: 'owner/repo' })).toThrow('  - base: Field required')
    })
  })
})

describe('parsePullRequestContent', () => {
  it('title・repository・base と本文のあるコンテンツを渡すと、head を undefined、draft を false にして取り出す', async () => {
    await explains('PR のコンテンツからフロントマターと本文を取り出す、`parsePullRequestContent` のテストです。`title`・`repository`・`base` と本文があるコンテンツを渡した場合に、値と本文を取り出し、`head` を `undefined`、`draft` を `false` にすることを確認します。')
    const result = stepSync('parsePullRequestContent を呼ぶ', () => {
      const content = `---
title: "機能追加PR"
repository: "owner/repo"
base: "develop-aist"
---

## Changed — テスト用本文

- 機能Aを追加

Refs #123
`
      const result = parsePullRequestContent(content)
      return result
    })
    stepSync('結果を比べる', () => {
      expect(result.frontmatter.title).toBe('機能追加PR')
      expect(result.frontmatter.repository).toBe('owner/repo')
      expect(result.frontmatter.base).toBe('develop-aist')
      expect(result.frontmatter.head).toBeUndefined()
      expect(result.frontmatter.draft).toBe(false)
      expect(result.body).toContain('## Changed — テスト用本文')
      expect(result.body).toContain('Refs #123')
    })
  })

  it('head と draft まで書いたコンテンツを渡すと、その値を取り出す', async () => {
    await explains('PR のコンテンツからフロントマターと本文を取り出す、`parsePullRequestContent` のテストです。`head` と `draft` まで書いたコンテンツを渡した場合に、その値を取り出すことを確認します。')
    const result = stepSync('parsePullRequestContent を呼ぶ', () => {
      const content = `---
title: "バグ修正"
repository: "org/project"
base: "develop"
head: "fix/issue-456"
draft: true
---

## Changed — テスト用本文

- バグ修正
`
      const result = parsePullRequestContent(content)
      return result
    })
    stepSync('結果を比べる', () => {
      expect(result.frontmatter.title).toBe('バグ修正')
      expect(result.frontmatter.head).toBe('fix/issue-456')
      expect(result.frontmatter.draft).toBe(true)
    })
  })

  it('フロントマターが存在しない場合は、エラーにする', async () => {
    await explains('PR のコンテンツからフロントマターと本文を取り出す、`parsePullRequestContent` のテストです。フロントマターが存在しないコンテンツを渡した場合に、`frontmatter not found` を含むメッセージで例外が発生することを確認します。')
    stepSync('parsePullRequestContent を呼び、結果を比べる', () => {
      expect(() => parsePullRequestContent('# PR\n\n本文のみ\n')).toThrow('frontmatter not found')
    })
  })

  it('title が存在しない場合は、エラーにする', async () => {
    await explains('PR のコンテンツからフロントマターと本文を取り出す、`parsePullRequestContent` のテストです。`title` が存在しないコンテンツを渡した場合に、`validation error` を含むメッセージで例外が発生することを確認します。')
    stepSync('parsePullRequestContent を呼び、結果を比べる', () => {
      expect(() => parsePullRequestContent('---\nrepository: "owner/repo"\nbase: "develop"\n---\n\n本文\n')).toThrow('validation error')
    })
  })
})

describe('stripLeadingHtmlComment（冒頭ガイドコメント除去 #958 F-02）', () => {
  it('冒頭のコメントと、その前後の空行を除去する', async () => {
    await explains('本文の冒頭の HTML コメントを除去する、`stripLeadingHtmlComment` のテストです。本文の冒頭に HTML コメントがある場合に、コメントとその前後の空行を除いた本文を返すことを確認します。')
    const body = stepSync('入力を用意する', () => '\n<!--\n読者: だれか\n書き方:\n- なにか\n-->\n\n## Goal — 目標\n\n本文\n')
    stepSync('stripLeadingHtmlComment を呼び、結果を比べる', () => {
      expect(stripLeadingHtmlComment(body)).toBe('## Goal — 目標\n\n本文\n')
    })
  })

  it('先頭の 1 ブロックだけを除去し、本文の途中の HTML は残す', async () => {
    await explains('本文の冒頭の HTML コメントを除去する、`stripLeadingHtmlComment` のテストです。本文の途中にも HTML コメントがある場合に、先頭の 1 ブロックだけを除き、途中のコメントは残すことを確認します。')
    const body = stepSync('入力を用意する', () => '<!-- guide -->\n\n## Goal — 目標\n\n<!-- 本文中のメモ -->\n')
    stepSync('stripLeadingHtmlComment を呼び、結果を比べる', () => {
      expect(stripLeadingHtmlComment(body)).toBe('## Goal — 目標\n\n<!-- 本文中のメモ -->\n')
    })
  })

  it('冒頭にコメントが存在しない本文は、変更しない', async () => {
    await explains('本文の冒頭の HTML コメントを除去する、`stripLeadingHtmlComment` のテストです。冒頭に HTML コメントが存在しない本文を渡した場合に、同じ本文を返すことを確認します。')
    const body = stepSync('入力を用意する', () => '## Goal — 目標\n\n<details><summary>log</summary>x</details>\n')
    stepSync('stripLeadingHtmlComment を呼び、結果を比べる', () => {
      expect(stripLeadingHtmlComment(body)).toBe(body)
    })
  })

  it('issue のコンテンツを読み取るときに、冒頭のコメントを除去する', async () => {
    await explains('Issue のコンテンツからフロントマターと本文を取り出す、`parseFrontmatter` のテストです。本文の冒頭に HTML コメントがある場合に、コメントを除いた本文を取り出すことを確認します。')
    const content = stepSync('入力を用意する', () => '---\ntitle: "T"\ntype: task\nrepository: "owner/repo"\nstatus: ready\n---\n\n<!--\n読者: 実装者\n-->\n\n## Goal — 目標\n')
    stepSync('結果を比べる', () => {
      expect(parseFrontmatter(content).body).toBe('## Goal — 目標')
    })
  })

  it('PR のコンテンツを読み取るときに、冒頭のコメントを除去する', async () => {
    await explains('PR のコンテンツからフロントマターと本文を取り出す、`parsePullRequestContent` のテストです。本文の冒頭に HTML コメントがある場合に、コメントを除いた本文を取り出すことを確認します。')
    const content = stepSync('入力を用意する', () => '---\ntitle: "T"\nrepository: "owner/repo"\nbase: "main"\n---\n\n<!--\nフィールド: なにか\n-->\n\n## Verified — 検証済み\n')
    stepSync('結果を比べる', () => {
      expect(parsePullRequestContent(content).body).toBe('## Verified — 検証済み')
    })
  })

  it('改行が CRLF のコメントも、1 ブロックとして除去する', async () => {
    await explains('本文の冒頭の HTML コメントを除去する、`stripLeadingHtmlComment` のテストです。改行が `\\r\\n` の場合でも、冒頭のコメントを 1 ブロックとして除去し、後ろの改行は保つことを確認します。')
    stepSync('stripLeadingHtmlComment を呼び、結果を比べる', () => {
      expect(stripLeadingHtmlComment('<!-- g -->\r\n\r\n## A — あ\r\n')).toBe('## A — あ\r\n')
    })
  })
})

describe('stripFrontmatter（frontmatter 除去ヘルパ）', () => {
  it('フロントマターを除去した本文を返す', async () => {
    await explains('本文からフロントマターを除去する、`stripFrontmatter` のテストです。フロントマターがある本文を渡した場合に、フロントマターを除いた本文を返すことを確認します。')
    stepSync('stripFrontmatter を呼び、結果を比べる', () => {
      expect(stripFrontmatter('---\ntitle: x\n---\n\n## Goal — 目標\n')).toBe('## Goal — 目標\n')
    })
  })

  it('フロントマターが存在しない場合は、元の本文を返す', async () => {
    await explains('本文からフロントマターを除去する、`stripFrontmatter` のテストです。フロントマターが存在しない本文を渡した場合に、同じ本文を返すことを確認します。')
    const content = stepSync('入力を用意する', () => '## Goal — 目標\n')
    stepSync('stripFrontmatter を呼び、結果を比べる', () => {
      expect(stripFrontmatter(content)).toBe(content)
    })
  })

  it('閉じられていないフロントマターの場合は、元の本文を返す', async () => {
    await explains('本文からフロントマターを除去する、`stripFrontmatter` のテストです。フロントマターの終わりの `---` が存在しない場合に、同じ本文を返すことを確認します。')
    const content = stepSync('入力を用意する', () => '---\ntitle: x\n本文\n')
    stepSync('stripFrontmatter を呼び、結果を比べる', () => {
      expect(stripFrontmatter(content)).toBe(content)
    })
  })
})
