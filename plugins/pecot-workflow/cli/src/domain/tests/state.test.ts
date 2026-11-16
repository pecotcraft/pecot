import { describe, expect, it } from 'vitest'

import { InvalidValueError } from '../errors.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'
import { splitCodePoints } from '../python-format.js'
import {
  FLAG_PECOT_BASE,
  FLAG_PECOT_RESTACK,
  formatBaseRecord,
  formatRestackProgress,
  interpretRestackProgress,
  interpretBaseRecord,
  FLAG_PECOT_SESSION_TITLE,
  formatSessionTitle,
  planWorkTarget,
  SESSION_TITLE_MAX_CHARS,
  workDirectoryName,
} from '../state.js'

describe('フラグ名', () => {
  it('hooks が読み書きするファイル名と同じ', () => {
    expect([FLAG_PECOT_SESSION_TITLE]).toEqual(['.pecot-session-title'])
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
  it('セッション名を返す', () => {
    expect(planWorkTarget('acme-labs/aist-plugin/1253', '[Task] 題名')).toBe('#1253 題名')
  })

  it('タイトルが空なら番号だけのセッション名', () => {
    expect(planWorkTarget('owner/repo/5', '')).toBe('#5')
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

describe('.pecot-restack の 1 行', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567'
  const LEASE = 'fedcba9876543210fedcba9876543210fedcba98'
  const issue = createIssueReference(createRepositoryReference('Acme', 'Demo'), 3)

  it('ファイル名は .pecot-restack', () => {
    expect(FLAG_PECOT_RESTACK).toBe('.pecot-restack')
  })

  it('積んだ記録を保つときは、7 つの項目を空白で区切る', () => {
    const progress = { remote: 'origin', branch: 'feat/4', originalSha: SHA, ontoBranch: 'feat/3', ontoSha: SHA, leaseSha: LEASE, stackedOn: issue }
    expect(formatRestackProgress(progress)).toBe(`origin feat/4 ${SHA} feat/3 ${SHA} ${LEASE} Acme/Demo#3`)
    expect(interpretRestackProgress(formatRestackProgress(progress))).toEqual({ kind: 'progress', progress })
  })

  it('remote にブランチが無く、開発ブランチへ載せ直すときは、無い項目を - にする', () => {
    const progress = { remote: 'origin', branch: 'feat/4', originalSha: SHA, ontoBranch: 'main', ontoSha: SHA, leaseSha: undefined, stackedOn: undefined }
    expect(formatRestackProgress(progress)).toBe(`origin feat/4 ${SHA} main ${SHA} - -`)
    expect(interpretRestackProgress(formatRestackProgress(progress))).toEqual({ kind: 'progress', progress })
  })

  it('ファイルが無ければ none', () => {
    expect(interpretRestackProgress(undefined)).toEqual({ kind: 'none' })
  })

  it.for([
    { name: '空', content: '' },
    { name: '項目が足りない', content: `origin feat/4 ${SHA} main ${SHA} -` },
    { name: '項目が多い', content: `origin feat/4 ${SHA} main ${SHA} - - extra` },
    { name: 'SHA の形が違う', content: `origin feat/4 ${SHA} main abc - -` },
    { name: 'lease の形が違う', content: `origin feat/4 ${SHA} main ${SHA} abc -` },
    { name: '積んだ先の形が違う', content: `origin feat/4 ${SHA} main ${SHA} - #3` },
  ])('形が誤っている（$name）と malformed', ({ content }) => {
    expect(interpretRestackProgress(content)).toEqual({ kind: 'malformed', content })
  })
})
