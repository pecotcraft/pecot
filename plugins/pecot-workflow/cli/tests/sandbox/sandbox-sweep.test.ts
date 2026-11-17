/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下のみ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- フィクスチャを組み替える作業用のクラスを渡す */
// sandbox-sweep.sh を、偽の gh で動かして結果を確かめる。
// 偽の gh は呼び出しの引数を記録し、読む呼び出しにはエンドポイントごとのフィクスチャを返す。書き込みの有無と順は、その記録で見る。
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { readFakeCalls } from '../../src/tests/_helpers/fake-executables.js'
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
    it('形に合う PR・ブランチ・Issue を、この順で片付ける', () => {
      environment.refs('cuj/456-ab12')
      environment.issues([issue(11, '[Task] [cuj 456-ab12] 直す'), issue(12, '[cuj 456-ab12] 直す', { pr: true })])
      const result = environment.run()
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

    it('形に合わない名前は、そのまま残す', () => {
      environment.refs('main', 'cuj/notes', 'fix/ci', 'cuj/456-ab12', 'cuj/456-ab12x', 'cuj/456-AB12')
      environment.issues([
        issue(14, 'ci.yml を直す', { pr: true }),
        issue(15, '[cuj 456] 乱数が無い'),
        issue(16, '[Task] [cuj 456-ab12] 直す'),
      ])
      const result = environment.run()
      expect(result.status).toBe(0)
      expect(environment.writes()).toStrictEqual([
        `api -X DELETE repos/${SANDBOX}/git/refs/heads/cuj/456-ab12`,
        `issue close 16 -R ${SANDBOX}`,
      ])
    })

    it('--issue を付けると、その番号のものだけを片付ける', () => {
      fullScene(environment)
      const result = environment.run('--issue', '456')
      expect(result.status).toBe(0)
      const joined = environment.writes().join('\n')
      expect(joined).not.toContain('457')
      expect(joined).not.toContain('4560')
      expect(` ${joined} `).not.toContain(' 13 ')
      expect(` ${joined} `).not.toContain(' 15 ')
    })

    it('--dry-run は、書き換えずに一覧だけを出す', () => {
      fullScene(environment)
      const result = environment.run('--dry-run', '--issue', '456')
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

    it('片付けるものが無ければ、0 件と出して何も書き換えない', () => {
      environment.refs('main')
      const result = environment.run()
      expect([result.status, result.stdout, result.stderr]).toStrictEqual([0, '片付けるものは 0 件\n', ''])
      expect(environment.writes()).toStrictEqual([])
    })

    it('ブランチを 1 つ消せなくても、残りを続けて片付ける', () => {
      fullScene(environment)
      environment.fail = 'git/refs/heads/cuj/456-ab12/7'
      const result = environment.run('--issue', '456')
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

  describe('足した 5 つの場合', () => {
    it('リリースとそのタグを消す', () => {
      environment.releases('cuj/456-ab12-tgz', 'cuj/457-cd34-tgz', 'v1.0.0', 'cuj/456-ab12')
      const result = environment.run('--issue', '456')
      expect(result.status).toBe(0)
      expect(splitLines(result.stdout)).toStrictEqual(['リリース cuj/456-ab12-tgz'])
      expect(environment.writes()).toStrictEqual([`release delete cuj/456-ab12-tgz --cleanup-tag --yes -R ${SANDBOX}`])
    })

    it('題の途中にある cuj のタグを見つけ、閉じた Issue のカードもアーカイブする', () => {
      environment.issues([issue(21, '[Task] [cuj 456-ab12] 題の途中にある')])
      environment.cards(
        [card('PVTI_20', 20, '[Task] [cuj 456-ab12] 閉じた Issue のカード')],
        [
          card('PVTI_21', 21, '[Task] [cuj 456-ab12] 題の途中にある'),
          card('PVTI_22', 22, '[Task] [cuj 456-ab12] アーカイブ済み', true),
        ],
      )
      const result = environment.run()
      expect(result.status).toBe(0)
      expect(environment.writes()).toStrictEqual([
        `issue close 21 -R ${SANDBOX}`,
        'project item-archive 3 --owner pecotcraft --id PVTI_20',
        'project item-archive 3 --owner pecotcraft --id PVTI_21',
      ])
    })

    it('セッションの接尾辞の付いたブランチを拾い、番号の境目で別の番号と分ける', () => {
      environment.refs('cuj/456-ab12/7', 'cuj/4560-ab12', 'cuj/4560-ab12/9')
      const first = environment.run('--issue', '456')
      expect(first.status).toBe(0)
      expect(environment.writes()).toStrictEqual([`api -X DELETE repos/${SANDBOX}/git/refs/heads/cuj/456-ab12/7`])
      // 引数なしなら、番号の長いものも形に合う
      const second = environment.run()
      expect(second.status).toBe(0)
      expect(environment.writes()).toHaveLength(3)
    })

    it('どの呼び出しも検証用のリポとボードだけを指す', () => {
      fullScene(environment)
      const result = environment.run()
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

    it('PR を閉じてからブランチを消す', () => {
      fullScene(environment)
      const result = environment.run()
      expect(result.status).toBe(0)
      const kinds = environment.writes().map(call => (call.startsWith('api') ? 'branch' : (call.split(' ', 1)[0] ?? '')))
      const order = ['pr', 'branch', 'issue', 'project', 'release']
      expect(kinds).toStrictEqual(kinds.toSorted((a, b) => order.indexOf(a) - order.indexOf(b)))
      expect(kinds[0]).toBe('pr')
    })
  })

  describe('引数と読めない場合', () => {
    it('一覧がまだ開いたままと返す、閉じた直後の Issue と PR は飛ばす', () => {
      environment.issues([
        issue(11, '[Task] [cuj 456-ab12] 閉じた直後', { state: 'closed' }),
        issue(12, '[cuj 456-ab12] 閉じた直後', { pr: true, state: 'closed' }),
        issue(13, '[Task] [cuj 456-ab12] 開いている'),
      ])
      const result = environment.run()
      expect(result.status).toBe(0)
      expect(splitLines(result.stdout)).toStrictEqual(['Issue #13 [Task] [cuj 456-ab12] 開いている'])
      expect(environment.writes()).toStrictEqual([`issue close 13 -R ${SANDBOX}`])
    })

    it('閉じた直後のものしか無ければ、0 件になる', () => {
      environment.issues([issue(11, '[Task] [cuj 456-ab12] 閉じた直後', { state: 'closed' })])
      const result = environment.run()
      expect(result.status).toBe(0)
      expect(splitLines(result.stdout)).toStrictEqual(['片付けるものは 0 件'])
      expect(environment.writes()).toStrictEqual([])
    })

    it('片付けた後の検証用では、もう一度動かしても 0 件', () => {
      environment.refs('cuj/notes')
      environment.cards([card('PVTI_11', 11, '[Task] [cuj 456-ab12] 1 行直す', true)])
      const result = environment.run('--issue', '456')
      expect([result.status, result.stdout]).toStrictEqual([0, '片付けるものは 0 件\n'])
    })

    it.for([
      ['--issue'],
      ['--issue', '45a'],
      ['--issue', 'cuj/456'],
      ['--repo', 'pecotcraft/pecot'],
      ['-R', 'pecotcraft/pecot'],
      ['extra'],
    ])('許さない引数 %j は、gh を呼ばずに終了コード 2 で断る', (argumentList) => {
      const result = environment.run(...argumentList)
      expect(result.status).toBe(2)
      expect(result.stderr.startsWith('error: ')).toBe(true)
      expect(environment.calls()).toStrictEqual([])
    })

    it('読む呼び出しが失敗したら、書き換える前に終了コード 2 で止まる', () => {
      fullScene(environment)
      environment.fail = 'releases?per_page=100'
      const result = environment.run()
      expect(result.status).toBe(2)
      expect(splitLines(result.stderr)[0]?.startsWith('error: リリースの一覧を読めない: ')).toBe(true)
      expect(environment.writes()).toStrictEqual([])
    })
  })
})
