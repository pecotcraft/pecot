/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下のみ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- フィクスチャを組み替える作業用のクラスを渡す */
// sandbox-sweep.sh を、偽の gh で動かして結果を確かめる。
// 偽の gh は呼び出しの引数を記録し、読む呼び出しにはエンドポイントごとのフィクスチャを返す。書き込みの有無と順は、その記録で見る。
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { stepSync } from '../_helpers/step.js'
import { readFakeCalls } from '../../../../../libs/workflow-core/tests/_helpers/fake-executables.js'
import { fixtureName, makeSandbox, pluginScript, runScript, splitLines, type Result, type Sandbox } from './_helpers/run.js'

const SANDBOX = 'pecotcraft/pecot-sandbox'
const REFS = `repos/${SANDBOX}/git/matching-refs/heads/cuj/`
const ISSUES = `repos/${SANDBOX}/issues?state=open&per_page=100`
const RELEASES = `repos/${SANDBOX}/releases?per_page=100`
const script = pluginScript('scripts/sandbox/sandbox-sweep.sh')

// FAKE_GH_FAIL の部分文字列を含む呼び出しは失敗する。読む呼び出し（-X の無い api）は、エンドポイントの記号を _ に替えた名前のフィクスチャを返す
const FAKE_GH = [
  'if [ -n "${FAKE_GH_FAIL:-}" ] && [[ "$*" == *"$FAKE_GH_FAIL"* ]]; then',
  '    echo "HTTP 422: Reference does not exist" >&2',
  '    exit 1',
  'fi',
  '[ "$1" = "api" ] || exit 0',
  'shift',
  'endpoint=""; method=""',
  'while [ "$#" -gt 0 ]; do',
  '    case "$1" in',
  '        -X) method="$2"; shift 2 ;;',
  '        -f|-F|-H) shift 2 ;;',
  '        -*) shift ;;',
  '        *) [ -z "$endpoint" ] && endpoint="$1"; shift ;;',
  '    esac',
  'done',
  '[ -n "$method" ] && exit 0',
  'f="$FAKE_GH_DIR/${endpoint//[^A-Za-z0-9]/_}"',
  '[ -f "$f" ] || { echo "HTTP 404: Not Found ($endpoint)" >&2; exit 1; }',
  'cat "$f"',
].join('\n')

interface Issue { number: number, title: string, state: string, pull_request?: { url: string } }

function reference(name: string): object {
  return { ref: `refs/heads/${name}`, object: { sha: '0'.repeat(40) } }
}

// state は 1 件ずつ取る API が返す今の状態。一覧の API は、閉じた直後でも開いたまま返すことがある
function issue(number: number, title: string, options: { pr?: boolean, state?: string } = {}): Issue {
  const { pr = false, state = 'open' } = options
  return { number, title, state, ...(pr && { pull_request: { url: `https://api.github.com/repos/${SANDBOX}/pulls/${String(number)}` } }) }
}

function card(itemId: string, number: number, title: string, isArchived = false): object {
  return {
    id: itemId,
    isArchived,
    content: { __typename: 'Issue', number, title, repository: { nameWithOwner: SANDBOX } },
  }
}

function listed(item: Readonly<Issue>): object {
  return { number: item.number, title: item.title, ...(item.pull_request && { pull_request: item.pull_request }) }
}

function isRead(call: string): boolean {
  return call.startsWith('api ') && !` ${call} `.includes(' -X ')
}

class Environment {
  fail = ''

  constructor(readonly sandbox: Sandbox) {
    // 何も無い状態を既定にする
    this.refs()
    this.issues()
    this.cards()
    this.releases()
  }

  // --paginate の出力は、ページごとの JSON を続けて並べた形になる
  private put(endpoint: string, pages: readonly unknown[]): void {
    writeFileSync(path.join(this.sandbox.fake, fixtureName(endpoint)), pages.map(page => JSON.stringify(page)).join('\n'))
  }

  refs(...names: string[]): void {
    this.put(REFS, [names.map(name => reference(name))])
  }

  issues(...pages: Issue[][]): void {
    this.put(ISSUES, pages.length === 0 ? [[]] : pages.map(page => page.map(item => listed(item))))
    for (const item of pages.flat()) this.put(`repos/${SANDBOX}/issues/${String(item.number)}`, [{ state: item.state }])
  }

  cards(...pages: object[][]): void {
    const withDefault = pages.length === 0 ? [[]] : pages
    this.put('graphql', withDefault.map(nodes => ({ data: { organization: { projectV2: { items: { nodes } } } } })))
  }

  releases(...tags: string[]): void {
    this.put(RELEASES, [tags.map(tag => ({ tag_name: tag, name: tag }))])
  }

  run(...argumentList: string[]): Result {
    rmSync(path.join(this.sandbox.bin, 'gh.calls'), { force: true })
    return runScript(this.sandbox, script, argumentList, { FAKE_GH_FAIL: this.fail })
  }

  calls(): string[] {
    return readFakeCalls(this.sandbox.bin, 'gh').map(call => call.join(' '))
  }

  writes(): string[] {
    return this.calls().filter(call => !isRead(call))
  }
}

// 456 の PR・ブランチ・Issue・カード・リリースと、形に合わないもの、457 のもの
function fullScene(environment: Environment): void {
  environment.refs('cuj/456-ab12', 'cuj/456-ab12/7', 'cuj/457-cd34', 'cuj/4560-ab12', 'cuj/notes')
  environment.issues([
    issue(11, '[Task] [cuj 456-ab12] 1 行直す'),
    issue(12, '[cuj 456-ab12] 1 行直す', { pr: true }),
    issue(13, '[Task] [cuj 457-cd34] 別の確かめ'),
    issue(14, 'ci.yml を直す', { pr: true }),
    issue(15, '[Task] [cuj 4560-ab12] 番号が長い'),
  ])
  environment.cards([
    card('PVTI_11', 11, '[Task] [cuj 456-ab12] 1 行直す'),
    card('PVTI_14', 14, 'ci.yml を直す'),
  ])
  environment.releases('cuj/456-ab12-tgz', 'v1.0.0')
}

describe('sandbox-sweep.sh', { timeout: 30_000 }, () => {
  let environment: Environment

  beforeEach(() => {
    environment = new Environment(makeSandbox(FAKE_GH))
  })

  describe('契約の 6 つの場合', () => {
    it('形式に合う PR・ブランチ・Issue を、PR・ブランチ・Issue の順に片付ける', async () => {
      await explains('`sandbox-sweep.sh` が検証用リポジトリを片付ける動作のテストです。`cuj 456-ab12` の形式に合う PR・ブランチ・Issue が、PR・ブランチ・Issue の順に閉じられるか削除されることを確認します。')
      stepSync('偽の gh に、形式に合う PR・ブランチ・Issue を置く', () => {
        environment.refs('cuj/456-ab12')
        environment.issues([issue(11, '[Task] [cuj 456-ab12] 直す'), issue(12, '[cuj 456-ab12] 直す', { pr: true })])
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('標準出力と書き込みを比べる', () => {
        expect(result.status).toBe(0)
        expect(splitLines(result.stdout)).toStrictEqual([
          'PR #12 [cuj 456-ab12] 直す',
          'ブランチ cuj/456-ab12',
          'Issue #11 [Task] [cuj 456-ab12] 直す',
        ])
        expect(environment.writes()).toStrictEqual([
          `pr close 12 -R ${SANDBOX}`,
          `api -X DELETE repos/${SANDBOX}/git/refs/heads/cuj/456-ab12`,
          `issue close 11 -R ${SANDBOX}`,
        ])
      })
    })

    it('形式に合わない名前の PR・ブランチ・Issue は、変更せずに残す', async () => {
      await explains('形式に合わない名前の扱いのテストです。`cuj/notes` や `[cuj 456]` などの名前は変更せず、形式に合う `cuj/456-ab12` と Issue #16 だけを片付けることを確認します。')
      stepSync('偽の gh に、形式に合う名前と合わない名前を置く', () => {
        environment.refs('main', 'cuj/notes', 'fix/ci', 'cuj/456-ab12', 'cuj/456-ab12x', 'cuj/456-AB12')
        environment.issues([
          issue(14, 'ci.yml を直す', { pr: true }),
          issue(15, '[cuj 456] 乱数が無い'),
          issue(16, '[Task] [cuj 456-ab12] 直す'),
        ])
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('書き込みを比べる', () => {
        expect(result.status).toBe(0)
        expect(environment.writes()).toStrictEqual([
          `api -X DELETE repos/${SANDBOX}/git/refs/heads/cuj/456-ab12`,
          `issue close 16 -R ${SANDBOX}`,
        ])
      })
    })

    it('--issue で番号を指定すると、その番号のものだけを片付ける', async () => {
      await explains('`--issue 456` を指定した場合のテストです。番号 456 の PR・ブランチ・Issue だけが書き換えられ、457 と 4560 のものは書き換えられないことを確認します。')
      stepSync('偽の gh に、456・457・4560 のものを置く', () => {
        fullScene(environment)
      })
      const result = stepSync('--issue 456 を指定して sandbox-sweep.sh を動かす', () => environment.run('--issue', '456'))
      stepSync('456 のものだけを書き換えたことを確かめる', () => {
        expect(result.status).toBe(0)
        const joined = environment.writes().join('\n')
        expect(joined).not.toContain('457')
        expect(joined).not.toContain('4560')
        expect(` ${joined} `).not.toContain(' 13 ')
        expect(` ${joined} `).not.toContain(' 15 ')
      })
    })

    it('--dry-run を指定すると、書き換えずに一覧だけを表示する', async () => {
      await explains('`--dry-run` を指定した場合のテストです。片付ける対象の一覧と「6 件を書き換えていない」の行を表示し、書き込みの呼び出しが 1 件も存在しないことを確認します。')
      stepSync('偽の gh に、456・457・4560 のものを置く', () => {
        fullScene(environment)
      })
      const result = stepSync('--dry-run を指定して sandbox-sweep.sh を動かす', () => environment.run('--dry-run', '--issue', '456'))
      stepSync('一覧の表示と、書き込みが無いことを確かめる', () => {
        expect(result.status).toBe(0)
        expect(splitLines(result.stdout)).toStrictEqual([
          'PR #12 [cuj 456-ab12] 1 行直す',
          'ブランチ cuj/456-ab12',
          'ブランチ cuj/456-ab12/7',
          'Issue #11 [Task] [cuj 456-ab12] 1 行直す',
          'カード #11 [Task] [cuj 456-ab12] 1 行直す',
          'リリース cuj/456-ab12-tgz',
          '--dry-run のため、6 件を書き換えていない',
        ])
        expect(environment.calls().length).toBeGreaterThan(0)
        expect(environment.writes()).toStrictEqual([])
      })
    })

    it('片付ける対象が存在しない場合は、0 件と表示して何も書き換えない', async () => {
      await explains('片付ける対象が存在しない場合のテストです。「片付けるものは 0 件」と表示して正常終了し、書き込みの呼び出しが存在しないことを確認します。')
      stepSync('偽の gh に、片付ける対象の無いブランチを置く', () => {
        environment.refs('main')
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('0 件の表示と、書き込みが無いことを確かめる', () => {
        expect([result.status, result.stdout, result.stderr]).toStrictEqual([0, '片付けるものは 0 件\n', ''])
        expect(environment.writes()).toStrictEqual([])
      })
    })

    it('ブランチを 1 つ削除できなくても、残りの対象を続けて片付け、終了コード 1 で終了する', async () => {
      await explains('ブランチの削除に失敗した場合のテストです。失敗したブランチの分を標準エラーに表示して終了コード 1 になり、PR・Issue・カード・リリースの残りの書き込みは続けて行われることを確認します。')
      stepSync('偽の gh に、456 のものを置き、1 つのブランチの削除を失敗させる', () => {
        fullScene(environment)
        environment.fail = 'git/refs/heads/cuj/456-ab12/7'
      })
      const result = stepSync('--issue 456 を指定して sandbox-sweep.sh を動かす', () => environment.run('--issue', '456'))
      stepSync('失敗の表示と、残りの書き込みを比べる', () => {
        expect(result.status).toBe(1)
        expect(splitLines(result.stderr)).toStrictEqual(['error: ブランチ cuj/456-ab12/7 を消せない: HTTP 422: Reference does not exist'])
        expect(splitLines(result.stdout)).not.toContain('ブランチ cuj/456-ab12/7')
        expect(environment.writes()).toStrictEqual([
          `pr close 12 -R ${SANDBOX}`,
          `api -X DELETE repos/${SANDBOX}/git/refs/heads/cuj/456-ab12`,
          `api -X DELETE repos/${SANDBOX}/git/refs/heads/cuj/456-ab12/7`,
          `issue close 11 -R ${SANDBOX}`,
          'project item-archive 3 --owner pecotcraft --id PVTI_11',
          `release delete cuj/456-ab12-tgz --cleanup-tag --yes -R ${SANDBOX}`,
        ])
      })
    })
  })

  describe('足した 5 つの場合', () => {
    it('--issue に対応するリリースを、タグごと削除する', async () => {
      await explains('リリースの削除のテストです。`--issue 456` の場合に、`cuj/456-ab12-tgz` のリリースだけが `--cleanup-tag` つきで削除され、`v1.0.0` や 457 のリリースは削除されないことを確認します。')
      stepSync('偽の gh に、リリースを置く', () => {
        environment.releases('cuj/456-ab12-tgz', 'cuj/457-cd34-tgz', 'v1.0.0', 'cuj/456-ab12')
      })
      const result = stepSync('--issue 456 を指定して sandbox-sweep.sh を動かす', () => environment.run('--issue', '456'))
      stepSync('リリースの削除を比べる', () => {
        expect(result.status).toBe(0)
        expect(splitLines(result.stdout)).toStrictEqual(['リリース cuj/456-ab12-tgz'])
        expect(environment.writes()).toStrictEqual([`release delete cuj/456-ab12-tgz --cleanup-tag --yes -R ${SANDBOX}`])
      })
    })

    it('題の途中にある cuj のタグを検出し、閉じた Issue のカードもアーカイブする', async () => {
      await explains('題の途中に `[cuj 456-ab12]` がある Issue とボードのカードのテストです。Issue を閉じ、その Issue と閉じた Issue のカードをアーカイブし、アーカイブ済みのカードには何もしないことを確認します。')
      stepSync('偽の gh に、Issue とボードのカードを置く', () => {
        environment.issues([issue(21, '[Task] [cuj 456-ab12] 題の途中にある')])
        environment.cards(
          [card('PVTI_20', 20, '[Task] [cuj 456-ab12] 閉じた Issue のカード')],
          [
            card('PVTI_21', 21, '[Task] [cuj 456-ab12] 題の途中にある'),
            card('PVTI_22', 22, '[Task] [cuj 456-ab12] アーカイブ済み', true),
          ],
        )
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('Issue とカードの書き込みを比べる', () => {
        expect(result.status).toBe(0)
        expect(environment.writes()).toStrictEqual([
          `issue close 21 -R ${SANDBOX}`,
          'project item-archive 3 --owner pecotcraft --id PVTI_20',
          'project item-archive 3 --owner pecotcraft --id PVTI_21',
        ])
      })
    })

    it('セッションの番号が付いたブランチ（cuj/456-ab12/7）を対象にし、別の Issue 番号（4560）のブランチと区別する', async () => {
      await explains('ブランチ名の判定のテストです。`--issue 456` では `cuj/456-ab12/7` だけを削除し、引数を省略すると `cuj/4560-ab12` などの番号の長いブランチも合わせて 3 件を削除することを確認します。')
      stepSync('偽の gh に、ブランチを置く', () => {
        environment.refs('cuj/456-ab12/7', 'cuj/4560-ab12', 'cuj/4560-ab12/9')
      })
      const first = stepSync('--issue 456 を指定して sandbox-sweep.sh を動かす', () => environment.run('--issue', '456'))
      stepSync('456 のブランチだけを削除したことを確かめる', () => {
        expect(first.status).toBe(0)
        expect(environment.writes()).toStrictEqual([`api -X DELETE repos/${SANDBOX}/git/refs/heads/cuj/456-ab12/7`])
      })
      // 引数なしなら、番号の長いものも形に合う
      const second = stepSync('引数なしで sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('番号の長いブランチも削除したことを確かめる', () => {
        expect(second.status).toBe(0)
        expect(environment.writes()).toHaveLength(3)
      })
    })

    it('すべての gh の呼び出しが、検証用のリポジトリとボードだけを指す', async () => {
      await explains('gh の呼び出しの宛先のテストです。すべての呼び出しが検証用リポジトリかボード（番号 3）だけを指し、一覧の取得に `--paginate` が付くことを確認します。')
      stepSync('偽の gh に、456・457・4560 のものを置く', () => {
        fullScene(environment)
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('gh の呼び出しの宛先を確かめる', () => {
        expect(result.status).toBe(0)
        const calls = environment.calls()
        // 1 件ずつ今の状態を読む呼び出し（issues/<番号>）は一覧ではないので、ページ送りが要らない
        const reads = calls.filter(call => isRead(call) && !/\/issues\/\d+$/u.test(call))
        expect(reads.length).toBeGreaterThan(0)
        expect(reads.every(call => call.includes('--paginate'))).toBe(true)
        const projectCalls = calls.filter(call => call.startsWith('project ') || call.startsWith('api graphql '))
        const repositoryCalls = calls.filter(call => !projectCalls.includes(call))
        expect(projectCalls.every(call => call.includes('pecotcraft') && /(?:^| )3(?: |$)|number=3/u.test(call))).toBe(true)
        expect(repositoryCalls.every(call => call.includes(`-R ${SANDBOX}`) || call.includes(`repos/${SANDBOX}/`))).toBe(true)
        expect(calls.every(call => !call.includes('--delete-branch'))).toBe(true)
      })
    })

    it('PR を閉じてからブランチを削除する', async () => {
      await explains('書き込みの順序のテストです。書き込みの呼び出しが PR・ブランチ・Issue・ボード・リリースの順に並び、先頭が PR を閉じる呼び出しであることを確認します。')
      stepSync('偽の gh に、456・457・4560 のものを置く', () => {
        fullScene(environment)
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('書き込みの順序を確かめる', () => {
        expect(result.status).toBe(0)
        const kinds = environment.writes().map(call => (call.startsWith('api') ? 'branch' : (call.split(' ', 1)[0] ?? '')))
        const order = ['pr', 'branch', 'issue', 'project', 'release']
        expect(kinds).toStrictEqual(kinds.toSorted((a, b) => order.indexOf(a) - order.indexOf(b)))
        expect(kinds[0]).toBe('pr')
      })
    })
  })

  describe('引数と読めない場合', () => {
    it('一覧が開いたままと返しても、閉じた直後の Issue と PR は対象から除く', async () => {
      await explains('一覧の API が、閉じた直後の Issue を開いたままと返す場合のテストです。個別に取得した状態が `closed` の Issue と PR は対象から除き、開いている Issue #13 だけを閉じることを確認します。')
      stepSync('偽の gh に、閉じた直後の Issue と PR、開いている Issue を置く', () => {
        environment.issues([
          issue(11, '[Task] [cuj 456-ab12] 閉じた直後', { state: 'closed' }),
          issue(12, '[cuj 456-ab12] 閉じた直後', { pr: true, state: 'closed' }),
          issue(13, '[Task] [cuj 456-ab12] 開いている'),
        ])
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('開いている Issue だけを閉じたことを確かめる', () => {
        expect(result.status).toBe(0)
        expect(splitLines(result.stdout)).toStrictEqual(['Issue #13 [Task] [cuj 456-ab12] 開いている'])
        expect(environment.writes()).toStrictEqual([`issue close 13 -R ${SANDBOX}`])
      })
    })

    it('閉じた直後のものしか存在しない場合は、0 件になる', async () => {
      await explains('閉じた直後の Issue だけが残っている場合のテストです。「片付けるものは 0 件」と表示し、書き込みの呼び出しが存在しないことを確認します。')
      stepSync('偽の gh に、閉じた直後の Issue を置く', () => {
        environment.issues([issue(11, '[Task] [cuj 456-ab12] 閉じた直後', { state: 'closed' })])
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('0 件の表示と、書き込みが無いことを確かめる', () => {
        expect(result.status).toBe(0)
        expect(splitLines(result.stdout)).toStrictEqual(['片付けるものは 0 件'])
        expect(environment.writes()).toStrictEqual([])
      })
    })

    it('片付けた後の検証用リポジトリで再び実行しても、0 件になる', async () => {
      await explains('片付けた後にもう一度実行する場合のテストです。アーカイブ済みのカードと `cuj/notes` だけが残る状態で、「片付けるものは 0 件」と表示して正常終了することを確認します。')
      stepSync('偽の gh に、アーカイブ済みのカードと cuj/notes を置く', () => {
        environment.refs('cuj/notes')
        environment.cards([card('PVTI_11', 11, '[Task] [cuj 456-ab12] 1 行直す', true)])
      })
      const result = stepSync('--issue 456 を指定して sandbox-sweep.sh を動かす', () => environment.run('--issue', '456'))
      stepSync('0 件の表示を比べる', () => {
        expect([result.status, result.stdout]).toStrictEqual([0, '片付けるものは 0 件\n'])
      })
    })

    it.for([
      ['--issue'],
      ['--issue', '45a'],
      ['--issue', 'cuj/456'],
      ['--repo', 'pecotcraft/pecot'],
      ['-R', 'pecotcraft/pecot'],
      ['extra'],
    ].map(argumentList => ({ argumentList })))('許可しない引数 $argumentList を渡すと、gh を呼ばずに終了コード 2 で終了する', async ({ argumentList }) => {
      await explains(`許可しない引数のテストです。\`${argumentList.join(' ')}\` を渡すと、\`error: \` で始まるメッセージを標準エラーに表示し、gh を呼ばずに終了コード 2 で終了することを確認します。`)
      const result = stepSync('許可しない引数を指定して sandbox-sweep.sh を動かす', () => environment.run(...argumentList))
      stepSync('終了コードと、gh を呼ばないことを確かめる', () => {
        expect(result.status).toBe(2)
        expect(result.stderr.startsWith('error: ')).toBe(true)
        expect(environment.calls()).toStrictEqual([])
      })
    })

    it('読み取りの呼び出しが失敗すると、書き換える前に終了コード 2 で止まる', async () => {
      await explains('リリースの一覧の取得に失敗した場合のテストです。「リリースの一覧を読めない」と標準エラーに表示して終了コード 2 になり、書き込みの呼び出しが存在しないことを確認します。')
      stepSync('偽の gh に、456 のものを置き、リリースの一覧の取得を失敗させる', () => {
        fullScene(environment)
        environment.fail = 'releases?per_page=100'
      })
      const result = stepSync('sandbox-sweep.sh を動かす', () => environment.run())
      stepSync('終了コードと、書き込みが無いことを確かめる', () => {
        expect(result.status).toBe(2)
        expect(splitLines(result.stderr)[0]?.startsWith('error: リリースの一覧を読めない: ')).toBe(true)
        expect(environment.writes()).toStrictEqual([])
      })
    })
  })
})
