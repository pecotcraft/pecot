import { describe, expect, it } from 'vitest'

import { InvalidValueError } from '../errors.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'
import { splitCodePoints } from '../python-format.js'
import {
  FLAG_PECOT_ACTIVE,
  FLAG_PECOT_BASE,
  formatBaseRecord,
  interpretBaseRecord,
  FLAG_PECOT_QUICK_MODE,
  FLAG_PECOT_SESSION_TITLE,
  FLAG_ISSUE_CREATE_SLASH_PENDING,
  FLAG_ISSUE_PENDING,
  FLAG_MERGE_SLASH_PENDING,
  FLAG_PR_CREATE_SLASH_PENDING,
  FLAG_WIP_BRANCH_LINKED,
  formatSessionTitle,
  planWorkTarget,
  SESSION_TITLE_MAX_CHARS,
  workDirectoryName,
} from '../state.js'

describe('フラグ名', () => {
  it('hooks が読み書きするファイル名と同じ', () => {
    expect([FLAG_PECOT_ACTIVE, FLAG_PECOT_SESSION_TITLE, FLAG_PECOT_QUICK_MODE]).toEqual(['.pecot-active', '.pecot-session-title', '.pecot-quick-mode'])
    expect([FLAG_PR_CREATE_SLASH_PENDING, FLAG_ISSUE_CREATE_SLASH_PENDING, FLAG_ISSUE_PENDING]).toEqual(['pr-create-slash-pending', 'issue-create-slash-pending', 'issue-pending'])
    expect([FLAG_WIP_BRANCH_LINKED, FLAG_MERGE_SLASH_PENDING]).toEqual(['.wip-branch-linked', 'merge-slash-pending'])
  })
})

describe('formatSessionTitle', () => {
  it('先頭の種別接頭辞 [Task] を落として「#番号 タイトル」にする', () => {
    expect(formatSessionTitle(12, '[Task] 題名')).toBe('#12 題名')
  })

  it('全体を 40 文字で切る', () => {
    const result = formatSessionTitle(1253, 'あ'.repeat(50))
    expect(result).toBe(`#1253 ${'あ'.repeat(SESSION_TITLE_MAX_CHARS - '#1253 '.length)}`)
    expect(result).toHaveLength(SESSION_TITLE_MAX_CHARS)
  })

  it('ちょうど 40 文字なら切らない', () => {
    const title = 'あ'.repeat(SESSION_TITLE_MAX_CHARS - '#1253 '.length)
    expect(formatSessionTitle(1253, title)).toBe(`#1253 ${title}`)
  })

  it('切った位置が空白なら末尾の空白を落とす', () => {
    expect(formatSessionTitle(1253, `${'あ'.repeat(33)} ${'い'.repeat(10)}`)).toBe(`#1253 ${'あ'.repeat(33)}`)
  })

  it('[Task]/[Bug]/[Epic] 以外の先頭の [...] は残す', () => {
    expect(formatSessionTitle(9, '[pecot-visual] 修正')).toBe('#9 [pecot-visual] 修正')
    expect(formatSessionTitle(9, '[Epic] 親')).toBe('#9 親')
  })

  it('タイトルが空、もしくは接頭辞のみなら、セッション名は番号になる', () => {
    expect(formatSessionTitle(7, '')).toBe('#7')
    expect(formatSessionTitle(7, '[Bug]   ')).toBe('#7')
  })

  it('絵文字はコードポイント 1 つとして数える（Python の len と同じ）', () => {
    const result = formatSessionTitle(1, '\u{1F600}'.repeat(60))
    expect(splitCodePoints(result)).toHaveLength(SESSION_TITLE_MAX_CHARS)
  })
})

describe('workDirectoryName', () => {
  it('owner/repo/N 形式は末尾の番号', () => {
    expect(workDirectoryName('acme-labs/aist-plugin/655')).toBe('655')
  })

  it('番号だけを渡すと、その番号を返す', () => {
    expect(workDirectoryName('42')).toBe('42')
  })

  it('末尾のスラッシュは無視', () => {
    expect(workDirectoryName('o/r/7//')).toBe('7')
  })

  it('全角数字などの ASCII 以外の数字は通さない（.pecot/work の直下は Issue 番号の数字だけ）', () => {
    expect(workDirectoryName('o/r/\u{FF11}\u{FF12}')).toBeUndefined()
    expect(workDirectoryName('\u{663}')).toBeUndefined()
  })

  it('末尾が番号でなければ undefined', () => {
    expect(workDirectoryName('not-a-ref')).toBeUndefined()
  })
})

describe('planWorkTarget', () => {
  it('active と session-title の内容を返す', () => {
    expect(planWorkTarget('acme-labs/aist-plugin/1253', '[Task] 題名')).toEqual({ active: 'acme-labs/aist-plugin/1253', sessionTitle: '#1253 題名' })
  })

  it('タイトルが空なら番号だけのセッション名', () => {
    expect(planWorkTarget('owner/repo/5', '').sessionTitle).toBe('#5')
  })

  it('番号が数字でなければ値の不正。文は int() と同じ', () => {
    expect(() => planWorkTarget('owner/repo/abc', '題名')).toThrow(InvalidValueError)
    expect(() => planWorkTarget('owner/repo/abc', '題名')).toThrow('invalid literal for int() with base 10: \'abc\'')
  })
})

describe('.pecot-base の 1 行', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567'
  const issue = createIssueReference(createRepositoryReference('Acme', 'Demo'), 3)

  it('ファイル名は .pecot-base', () => {
    expect(FLAG_PECOT_BASE).toBe('.pecot-base')
  })

  it('積んだときは、ブランチ・SHA・積んだ先を空白で区切る', () => {
    expect(formatBaseRecord({ branch: 'feat/3', sha: SHA, stackedOn: issue })).toBe(`feat/3 ${SHA} Acme/Demo#3`)
  })

  it('開発ブランチから着手したときは、ブランチと SHA だけにする', () => {
    expect(formatBaseRecord({ branch: 'main', sha: SHA, stackedOn: undefined })).toBe(`main ${SHA}`)
  })

  it('書いた形を読み戻す', () => {
    const stacked = interpretBaseRecord(formatBaseRecord({ branch: 'feat/3', sha: SHA, stackedOn: issue }))
    expect(stacked).toMatchObject({ kind: 'stacked', record: { branch: 'feat/3', sha: SHA }, stackedOn: { repository: { owner: 'Acme', repository: 'Demo' }, number: 3 } })
    expect(interpretBaseRecord(`main ${SHA}`)).toEqual({ kind: 'development', record: { branch: 'main', sha: SHA, stackedOn: undefined } })
  })

  it('リポ名の大文字小文字を残して書き、読み戻しても残る', () => {
    const written = formatBaseRecord({ branch: 'feat/3', sha: SHA, stackedOn: issue })
    expect(written).toBe(`feat/3 ${SHA} Acme/Demo#3`)
    expect(interpretBaseRecord(written)).toMatchObject({ kind: 'stacked', stackedOn: { repository: { owner: 'Acme', repository: 'Demo' } } })
  })

  it('ファイルが無ければ、開発ブランチから着手したものとして読む', () => {
    expect(interpretBaseRecord(undefined)).toEqual({ kind: 'development', record: undefined })
  })

  it.for([
    { name: '空', content: '' },
    { name: 'SHA が無い', content: 'main' },
    { name: 'SHA の形が違う', content: 'main abc123' },
    { name: '積んだ先の形が違う', content: `main ${SHA} #3` },
    { name: '積んだ先の番号が 0', content: `main ${SHA} acme/demo#0` },
    { name: '項目が多い', content: `main ${SHA} acme/demo#3 extra` },
  ])('形が誤っている（$name）と malformed', ({ content }) => {
    expect(interpretBaseRecord(content)).toEqual({ kind: 'malformed', content })
  })
})
