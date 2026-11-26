import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

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
  sessionTitleNumber,
  workDirectoryName,
} from '../state.js'

describe('フラグ名', () => {
  it('セッション名のフラグのファイル名は、hooks が読み書きする .pecot-session-title と一致する', async () => {
    await explains('セッション名のフラグのファイル名のテストです。定数 `FLAG_PECOT_SESSION_TITLE` が、hooks の読み書きするファイル名 `.pecot-session-title` と一致することを確認します。')
    expect([FLAG_PECOT_SESSION_TITLE]).toEqual(['.pecot-session-title'])
  })
})

describe('formatSessionTitle', () => {
  it('先頭の種別接頭辞 [Task] を落として「#番号 タイトル」にする', async () => {
    await explains('セッション名を作成する関数のテストです。タイトルの先頭の種別接頭辞 `[Task]` を取り除き、`#12 題名` の形式になることを確認します。')
    expect(formatSessionTitle(12, '[Task] 題名')).toBe('#12 題名')
  })

  it('全体を 40 文字で切る', async () => {
    await explains('セッション名の長さの上限のテストです。50 文字のタイトルを渡した場合に、全体が 40 文字に切り詰められることを確認します。')
    const result = formatSessionTitle(1253, 'あ'.repeat(50))
    expect(result).toBe(`#1253 ${'あ'.repeat(SESSION_TITLE_MAX_CHARS - '#1253 '.length)}`)
    expect(result).toHaveLength(SESSION_TITLE_MAX_CHARS)
  })

  it('ちょうど 40 文字なら切らない', async () => {
    await explains('セッション名の長さの上限のテストです。全体がちょうど 40 文字の場合に、タイトルが切り詰められずに残ることを確認します。')
    const title = 'あ'.repeat(SESSION_TITLE_MAX_CHARS - '#1253 '.length)
    expect(formatSessionTitle(1253, title)).toBe(`#1253 ${title}`)
  })

  it('切った位置が空白なら末尾の空白を落とす', async () => {
    await explains('セッション名を切り詰める位置のテストです。切り詰めた位置が空白の場合に、末尾の空白が取り除かれることを確認します。')
    expect(formatSessionTitle(1253, `${'あ'.repeat(33)} ${'い'.repeat(10)}`)).toBe(`#1253 ${'あ'.repeat(33)}`)
  })

  it('[Task]/[Bug]/[Epic] 以外の先頭の [...] は残す', async () => {
    await explains('セッション名から取り除く接頭辞のテストです。`[Task]`・`[Bug]`・`[Epic]` は取り除かれ、`[pecot-visual]` のようなそれ以外の接頭辞は残ることを確認します。')
    expect(formatSessionTitle(9, '[pecot-visual] 修正')).toBe('#9 [pecot-visual] 修正')
    expect(formatSessionTitle(9, '[Epic] 親')).toBe('#9 親')
  })

  it('タイトルが空、もしくは接頭辞のみなら、セッション名は番号になる', async () => {
    await explains('セッション名を作成する関数のテストです。タイトルが空の場合と接頭辞だけの場合に、セッション名が `#7` のように番号だけになることを確認します。')
    expect(formatSessionTitle(7, '')).toBe('#7')
    expect(formatSessionTitle(7, '[Bug]   ')).toBe('#7')
  })

  it('絵文字はコードポイント 1 つとして数える（Python の len と同じ）', async () => {
    await explains('セッション名を切り詰める際の文字の数え方のテストです。絵文字 60 個のタイトルを渡した場合に、絵文字を 1 文字として数え（Python の `len` と同じ）、40 文字に切り詰められることを確認します。')
    const result = formatSessionTitle(1, '\u{1F600}'.repeat(60))
    expect(splitCodePoints(result)).toHaveLength(SESSION_TITLE_MAX_CHARS)
  })
})

describe('workDirectoryName', () => {
  it('owner/repo/N 形式の参照を渡すと、末尾の番号を返す', async () => {
    await explains('作業ディレクトリ名を求める関数のテストです。`owner/repo/N` の形式の参照を渡した場合に、末尾の番号を返すことを確認します。')
    expect(workDirectoryName('acme-labs/aist-plugin/655')).toBe('655')
  })

  it('番号だけを渡すと、その番号を返す', async () => {
    await explains('作業ディレクトリ名を求める関数のテストです。番号だけを渡した場合に、その番号をそのまま返すことを確認します。')
    expect(workDirectoryName('42')).toBe('42')
  })

  it('参照の末尾にスラッシュが続く場合は、無視して番号を返す', async () => {
    await explains('作業ディレクトリ名を求める関数のテストです。参照の末尾にスラッシュが続く場合に、スラッシュを無視して番号を返すことを確認します。')
    expect(workDirectoryName('o/r/7//')).toBe('7')
  })

  it('全角数字などの ASCII 以外の数字は通さない（.pecot/work の直下は Issue 番号の数字だけ）', async () => {
    await explains('作業ディレクトリ名を求める関数のテストです。全角数字など ASCII 以外の数字を渡した場合に、`.pecot/work` の直下に使えない値として `undefined` を返すことを確認します。')
    expect(workDirectoryName('o/r/\u{FF11}\u{FF12}')).toBeUndefined()
    expect(workDirectoryName('\u{663}')).toBeUndefined()
  })

  it('末尾が番号でない参照を渡すと、undefined を返す', async () => {
    await explains('作業ディレクトリ名を求める関数のテストです。末尾が番号でない参照を渡した場合に、`undefined` を返すことを確認します。')
    expect(workDirectoryName('not-a-ref')).toBeUndefined()
  })
})

describe('planWorkTarget', () => {
  it('参照とタイトルを渡すと、#番号 タイトル の形のセッション名を返す', async () => {
    await explains('着手対象からセッション名を作成する関数のテストです。参照とタイトルを渡した場合に、`#1253 題名` の形式のセッション名を返すことを確認します。')
    expect(planWorkTarget('acme-labs/aist-plugin/1253', '[Task] 題名')).toBe('#1253 題名')
  })

  it('タイトルが空の場合は、番号だけのセッション名を返す', async () => {
    await explains('着手対象からセッション名を作成する関数のテストです。タイトルが空の場合に、`#5` のように番号だけのセッション名を返すことを確認します。')
    expect(planWorkTarget('owner/repo/5', '')).toBe('#5')
  })

  it('番号が数字でない場合は、Python の int() と同じ文の InvalidValueError が発生する', async () => {
    await explains('着手対象からセッション名を作成する関数のテストです。番号が数字でない場合に、`InvalidValueError` が発生し、メッセージが Python の `int()` と同じ文になることを確認します。')
    expect(() => planWorkTarget('owner/repo/abc', '題名')).toThrow(InvalidValueError)
    expect(() => planWorkTarget('owner/repo/abc', '題名')).toThrow('invalid literal for int() with base 10: \'abc\'')
  })
})

describe('sessionTitleNumber', () => {
  it('先頭の #番号 を取り出し、取り出せない場合は undefined を返す', async () => {
    await explains('セッション名から番号を取り出す関数のテストです。先頭が `#30` の形式の場合は番号を返し、それ以外の文字列や `undefined` の場合は `undefined` を返すことを確認します。')
    expect(sessionTitleNumber('#30 次の作業')).toBe(30)
    expect(sessionTitleNumber('x')).toBeUndefined()
    expect(sessionTitleNumber(undefined)).toBeUndefined()
  })
})

describe('.pecot-base の 1 行', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567'
  const issue = createIssueReference(createRepositoryReference('Acme', 'Demo'), 3)

  it('フラグのファイル名は .pecot-base と一致する', async () => {
    await explains('`.pecot-base` のファイル名のテストです。定数 `FLAG_PECOT_BASE` が `.pecot-base` であることを確認します。')
    expect(FLAG_PECOT_BASE).toBe('.pecot-base')
  })

  it('スタックしたときは、ブランチ・SHA・スタック先を空白で区切る', async () => {
    await explains('`.pecot-base` の 1 行を作成する関数のテストです。スタックした場合に、ブランチ・SHA・スタック先の Issue を空白で区切った 1 行になることを確認します。')
    expect(formatBaseRecord({ branch: 'feat/3', sha: SHA, stackedOn: issue })).toBe(`feat/3 ${SHA} Acme/Demo#3`)
  })

  it('開発ブランチから着手したときは、ブランチと SHA だけにする', async () => {
    await explains('`.pecot-base` の 1 行を作成する関数のテストです。開発ブランチから着手した場合に、ブランチと SHA だけの 1 行になることを確認します。')
    expect(formatBaseRecord({ branch: 'main', sha: SHA, stackedOn: undefined })).toBe(`main ${SHA}`)
  })

  it('作成した 1 行を読み取ると、元の値に戻る', async () => {
    await explains('`.pecot-base` の 1 行を読み取る関数のテストです。作成した 1 行を読み取った場合に、スタックした記録と開発ブランチの記録のどちらも元の値に戻ることを確認します。')
    const stacked = interpretBaseRecord(formatBaseRecord({ branch: 'feat/3', sha: SHA, stackedOn: issue }))
    expect(stacked).toMatchObject({ kind: 'stacked', record: { branch: 'feat/3', sha: SHA }, stackedOn: { repository: { owner: 'Acme', repository: 'Demo' }, number: 3 } })
    expect(interpretBaseRecord(`main ${SHA}`)).toEqual({ kind: 'development', record: { branch: 'main', sha: SHA, stackedOn: undefined } })
  })

  it('リポジトリ名の大文字と小文字を保って書き、読み取った結果にも保たれる', async () => {
    await explains('`.pecot-base` の 1 行のテストです。リポジトリ名の大文字と小文字が、書いた 1 行と、それを読み取った結果の両方に保たれることを確認します。')
    const written = formatBaseRecord({ branch: 'feat/3', sha: SHA, stackedOn: issue })
    expect(written).toBe(`feat/3 ${SHA} Acme/Demo#3`)
    expect(interpretBaseRecord(written)).toMatchObject({ kind: 'stacked', stackedOn: { repository: { owner: 'Acme', repository: 'Demo' } } })
  })

  it('ファイルが存在しない場合は、開発ブランチから着手したものとして読み取る', async () => {
    await explains('`.pecot-base` の 1 行を読み取る関数のテストです。ファイルが存在しない場合に、開発ブランチから着手したものとして扱うことを確認します。')
    expect(interpretBaseRecord(undefined)).toEqual({ kind: 'development', record: undefined })
  })

  it.for([
    { name: '空', content: '' },
    { name: 'SHA が無い', content: 'main' },
    { name: 'SHA の形が違う', content: 'main abc123' },
    { name: 'スタック先の形が違う', content: `main ${SHA} #3` },
    { name: 'スタック先の番号が 0', content: `main ${SHA} acme/demo#0` },
    { name: '項目が多い', content: `main ${SHA} acme/demo#3 extra` },
  ])('形が誤っている（$name）と malformed', async ({ content }) => {
    await explains('`.pecot-base` の 1 行を読み取る関数のテストです。空の内容や SHA の形式が誤っている内容などの場合に、内容をそのまま持つ `malformed` として扱うことを確認します。')
    expect(interpretBaseRecord(content)).toEqual({ kind: 'malformed', content })
  })
})

describe('.pecot-restack の 1 行', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567'
  const LEASE = 'fedcba9876543210fedcba9876543210fedcba98'
  const issue = createIssueReference(createRepositoryReference('Acme', 'Demo'), 3)

  it('フラグのファイル名は .pecot-restack と一致する', async () => {
    await explains('`.pecot-restack` のファイル名のテストです。定数 `FLAG_PECOT_RESTACK` が `.pecot-restack` であることを確認します。')
    expect(FLAG_PECOT_RESTACK).toBe('.pecot-restack')
  })

  it('スタックの記録を保つときは、8 つの項目を空白で区切る', async () => {
    await explains('`.pecot-restack` の 1 行を作成する関数のテストです。スタックの記録を保つ場合に、8 つの項目を空白で区切った 1 行になり、読み取ると元の値に戻ることを確認します。')
    const progress = { remote: 'origin', branch: 'feat/4', originalSha: SHA, ontoBranch: 'feat/3', ontoSha: SHA, leaseSha: LEASE, stackedOn: issue, recordSha: LEASE }
    expect(formatRestackProgress(progress)).toBe(`origin feat/4 ${SHA} feat/3 ${SHA} ${LEASE} Acme/Demo#3 ${LEASE}`)
    expect(interpretRestackProgress(formatRestackProgress(progress))).toEqual({ kind: 'progress', progress })
  })

  it('remote にブランチが存在せず、開発ブランチへスタックし直す場合は、存在しない項目を - にする', async () => {
    await explains('`.pecot-restack` の 1 行を作成する関数のテストです。remote にブランチが存在せず開発ブランチへスタックし直す場合に、存在しない項目が `-` で表され、読み取ると元の値に戻ることを確認します。')
    const progress = { remote: 'origin', branch: 'feat/4', originalSha: SHA, ontoBranch: 'main', ontoSha: SHA, leaseSha: undefined, stackedOn: undefined, recordSha: undefined }
    expect(formatRestackProgress(progress)).toBe(`origin feat/4 ${SHA} main ${SHA} - - -`)
    expect(interpretRestackProgress(formatRestackProgress(progress))).toEqual({ kind: 'progress', progress })
  })

  it('古い版が書いた 7 項目の行を読み取る場合は、記録の位置を未設定として扱う', async () => {
    await explains('`.pecot-restack` の 1 行を読み取る関数のテストです。古い版が書いた 7 項目の行を渡した場合に、記録の位置を未設定として扱うことを確認します。')
    expect(interpretRestackProgress(`origin feat/4 ${SHA} feat/3 ${SHA} ${LEASE} Acme/Demo#3`)).toEqual({
      kind: 'progress',
      progress: { remote: 'origin', branch: 'feat/4', originalSha: SHA, ontoBranch: 'feat/3', ontoSha: SHA, leaseSha: LEASE, stackedOn: issue, recordSha: undefined },
    })
  })

  it('ファイルが存在しない場合は、none として扱う', async () => {
    await explains('`.pecot-restack` の 1 行を読み取る関数のテストです。ファイルが存在しない場合に、`none` として扱うことを確認します。')
    expect(interpretRestackProgress(undefined)).toEqual({ kind: 'none' })
  })

  it.for([
    { name: '空', content: '' },
    { name: '項目が足りない', content: `origin feat/4 ${SHA} main ${SHA} -` },
    { name: '項目が多い', content: `origin feat/4 ${SHA} main ${SHA} - - - extra` },
    { name: '記録の位置の形が違う', content: `origin feat/4 ${SHA} main ${SHA} - - abc` },
    { name: 'SHA の形が違う', content: `origin feat/4 ${SHA} main abc - -` },
    { name: 'lease の形が違う', content: `origin feat/4 ${SHA} main ${SHA} abc -` },
    { name: 'スタック先の形が違う', content: `origin feat/4 ${SHA} main ${SHA} - #3` },
  ])('形が誤っている（$name）と malformed', async ({ content }) => {
    await explains('`.pecot-restack` の 1 行を読み取る関数のテストです。空の内容や項目の数が誤っている内容などの場合に、内容をそのまま持つ `malformed` として扱うことを確認します。')
    expect(interpretRestackProgress(content)).toEqual({ kind: 'malformed', content })
  })
})
