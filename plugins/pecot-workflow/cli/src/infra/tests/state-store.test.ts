/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { InvalidValueError, ProjectRootNotFoundError } from '@pecot/workflow-core/domain/errors.js'
import { createIssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { createRepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import {
  ensureWorkDirectory,
  hasFlag,
  getStateDirectory,
  readBaseRecord,
  readFlag,
  removeFlag,
  touchFlag,
  writeBaseRecord,
  writeFlag,
  writeSessionTitle,
} from '../state-store.js'

useIsolatedEnvironment()

function useProject(): string {
  const root = makeTemporaryDirectory()
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  return root
}

describe('getStateDirectory', () => {
  it('プロジェクトルートの下の .pecot/state のパスを返す', async () => {
    await explains('状態の保存先を求める `getStateDirectory` のテストです。環境変数 `CLAUDE_PROJECT_DIR` を指定した場合に、その下の `.pecot/state` のパスを返すことを確認します。')
    const root = useProject()
    expect(getStateDirectory()).toBe(path.join(root, '.pecot', 'state'))
  })

  it('create を指定した場合は、ディレクトリが存在しなければ作成する', async () => {
    await explains('状態の保存先を求める `getStateDirectory` のテストです。`create: true` を指定した場合に、`.pecot/state` が存在しなくても作成してそのパスを返すことを確認します。')
    const root = useProject()
    const stateDirectory = path.join(root, '.pecot', 'state')
    expect(existsSync(stateDirectory)).toBe(false)
    expect(getStateDirectory({ create: true })).toBe(stateDirectory)
    expect(existsSync(stateDirectory)).toBe(true)
  })

  it('create を指定しない場合は、ディレクトリを作成しない', async () => {
    await explains('状態の保存先を求める `getStateDirectory` のテストです。`create` を指定しない場合に、`.pecot` ディレクトリを作成しないことを確認します。')
    const root = useProject()
    getStateDirectory()
    expect(existsSync(path.join(root, '.pecot'))).toBe(false)
  })
})

describe('touchFlag', () => {
  it('フラグファイルを作成する', async () => {
    await explains('フラグファイルを作成する `touchFlag` のテストです。`.pecot/state` が存在する場合に、`.test-flag` のファイルを作成することを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    touchFlag('.test-flag')
    expect(existsSync(path.join(root, '.pecot', 'state', '.test-flag'))).toBe(true)
  })

  it('状態のディレクトリが存在しない場合は、ディレクトリも作成してフラグファイルを作成する', async () => {
    await explains('フラグファイルを作成する `touchFlag` のテストです。`.pecot/state` が存在しない場合でも、ディレクトリを作成して `.test-flag` のファイルを作成することを確認します。')
    const root = useProject()
    touchFlag('.test-flag')
    expect(existsSync(path.join(root, '.pecot', 'state', '.test-flag'))).toBe(true)
  })
})

describe('removeFlag', () => {
  it('フラグファイルを削除する', async () => {
    await explains('フラグファイルを削除する `removeFlag` のテストです。作成済みの `.test-flag` を削除した場合に、ファイルが存在しなくなることを確認します。')
    const root = useProject()
    touchFlag('.test-flag')
    removeFlag('.test-flag')
    expect(existsSync(path.join(root, '.pecot', 'state', '.test-flag'))).toBe(false)
  })

  it('存在しないフラグファイルを指定しても、例外が発生しない', async () => {
    await explains('フラグファイルを削除する `removeFlag` のテストです。存在しない `.nonexistent-flag` を指定した場合でも、例外が発生しないことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    expect(() => {
      removeFlag('.nonexistent-flag')
    }).not.toThrow()
  })
})

describe('hasFlag', () => {
  it('フラグファイルが存在する場合は、true を返す', async () => {
    await explains('フラグファイルの有無を判定する `hasFlag` のテストです。`.test-flag` のファイルが存在する場合に、`true` を返すことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(root, '.pecot', 'state', '.test-flag'), '')
    expect(hasFlag('.test-flag')).toBe(true)
  })

  it('フラグファイルが存在しない場合は、false を返す', async () => {
    await explains('フラグファイルの有無を判定する `hasFlag` のテストです。`.nonexistent-flag` が存在しない場合に、`false` を返すことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    expect(hasFlag('.nonexistent-flag')).toBe(false)
  })

  it('状態のディレクトリが存在しない場合でも、false を返す', async () => {
    await explains('フラグファイルの有無を判定する `hasFlag` のテストです。`.pecot/state` が存在しない場合でも、例外が発生せずに `false` を返すことを確認します。')
    useProject()
    expect(hasFlag('.test-flag')).toBe(false)
  })

  it('ディレクトリは通常のファイルではないため、false を返す', async () => {
    await explains('フラグファイルの有無を判定する `hasFlag` のテストです。同じ名前のディレクトリが存在する場合に、通常のファイルではないため `false` を返すことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state', '.dir-flag'), { recursive: true })
    expect(hasFlag('.dir-flag')).toBe(false)
  })
})

describe('readFlag（存在の確認と読み取りの間に消えた場合）', () => {
  it('フラグの名前がディレクトリの場合は、undefined を返す', async () => {
    await explains('フラグファイルを読み込む `readFlag` のテストです。存在の確認から読み込みまでの間に状態が変わり、名前がディレクトリになっていた場合に、`undefined` を返すことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state', '.dir-flag'), { recursive: true })
    expect(readFlag('.dir-flag')).toBeUndefined()
  })

  it('リンク先が存在しないシンボリックリンクの場合は、undefined を返す', async () => {
    await explains('フラグファイルを読み込む `readFlag` のテストです。リンク先が存在しないシンボリックリンクを指定した場合に、ファイルが存在しないものとして `undefined` を返すことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    symlinkSync(path.join(root, 'nowhere'), path.join(root, '.pecot', 'state', '.dangling'))
    expect(readFlag('.dangling')).toBeUndefined()
  })
})

describe('writeFlag / readFlag', () => {
  it('フラグに内容を書き込み、読み込むときは前後の空白を取り除く', async () => {
    await explains('フラグファイルを書き込む `writeFlag` と、読み込む `readFlag` のテストです。前後に空白と改行がある `  #1 題名 ` を書き込んだ場合に、空白を取り除いた `#1 題名` を返すことを確認します。')
    useProject()
    writeFlag('.pecot-session-title', '  #1 題名 \n')
    expect(readFlag('.pecot-session-title')).toBe('#1 題名')
  })

  it('フラグファイルが存在しない場合は、undefined を返す', async () => {
    await explains('フラグファイルを読み込む `readFlag` のテストです。`.missing` のファイルが存在しない場合に、`undefined` を返すことを確認します。')
    useProject()
    expect(readFlag('.missing')).toBeUndefined()
  })

  it('読み込むときは、改行を LF に統一する', async () => {
    await explains('フラグファイルを読み込む `readFlag` のテストです。改行が CRLF のファイルを読み込んだ場合に、改行を LF に統一した `a` と `b` の 2 行を返すことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(root, '.pecot', 'state', '.crlf'), 'a\r\nb\r\n')
    expect(readFlag('.crlf')).toBe('a\nb')
  })
})

describe('ensureWorkDirectory', () => {
  it('owner/repo/N の形式の参照から、.pecot/work/N を作成して返す', async () => {
    await explains('作業ディレクトリを作成する `ensureWorkDirectory` のテストです。`acme-labs/aist-plugin/655` を指定した場合に、`.pecot/work/655` を作成してそのパスを返すことを確認します。')
    const root = useProject()
    const result = ensureWorkDirectory('acme-labs/aist-plugin/655')
    expect(result).toBe(path.join(root, '.pecot', 'work', '655'))
    expect(existsSync(path.join(root, '.pecot', 'work', '655'))).toBe(true)
  })

  it('番号だけを指定した場合でも、作業ディレクトリを作成できる', async () => {
    await explains('作業ディレクトリを作成する `ensureWorkDirectory` のテストです。番号だけ（`42`）を指定した場合に、`.pecot/work/42` のパスを返すことを確認します。')
    const root = useProject()
    expect(ensureWorkDirectory('42')).toBe(path.join(root, '.pecot', 'work', '42'))
  })

  it('作業ディレクトリが既に存在する場合でも、例外が発生しない', async () => {
    await explains('作業ディレクトリを作成する `ensureWorkDirectory` のテストです。`.pecot/work/655` が既に存在する場合でも、例外が発生せずにそのパスを返すことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'work', '655'), { recursive: true })
    expect(ensureWorkDirectory('acme-labs/aist-plugin/655')).toBe(path.join(root, '.pecot', 'work', '655'))
  })

  it('全角数字の番号の場合は、undefined を返し、作業ディレクトリを作成しない', async () => {
    await explains('作業ディレクトリを作成する `ensureWorkDirectory` のテストです。番号が全角数字の `o/r/１２` を指定した場合に、`undefined` を返し、`.pecot/work` を作成しないことを確認します。')
    const root = useProject()
    expect(ensureWorkDirectory('o/r/\u{FF11}\u{FF12}')).toBeUndefined()
    expect(existsSync(path.join(root, '.pecot', 'work'))).toBe(false)
  })

  it('末尾が番号ではない参照の場合は、undefined を返し、作業ディレクトリを作成しない', async () => {
    await explains('作業ディレクトリを作成する `ensureWorkDirectory` のテストです。末尾が番号でない `not-a-ref` を指定した場合に、`undefined` を返し、`.pecot/work` を作成しないことを確認します。')
    const root = useProject()
    expect(ensureWorkDirectory('not-a-ref')).toBeUndefined()
    expect(existsSync(path.join(root, '.pecot', 'work'))).toBe(false)
  })

  it('プロジェクトルートが不明な場合でも、例外が発生せず undefined を返す', async () => {
    await explains('作業ディレクトリを作成する `ensureWorkDirectory` のテストです。プロジェクトルートを特定できないディレクトリで実行した場合に、例外が発生せず `undefined` を返すことを確認します。')
    const outside = makeTemporaryDirectory()
    const previous = process.cwd()
    process.chdir(outside)
    try {
      expect(ensureWorkDirectory('acme-labs/aist-plugin/655')).toBeUndefined()
    }
    finally {
      process.chdir(previous)
    }
  })

  it('作業ディレクトリを作成できない場合（work がファイルの場合）は、undefined を返す', async () => {
    await explains('作業ディレクトリを作成する `ensureWorkDirectory` のテストです。`.pecot/work` がファイルとして存在し、ディレクトリを作成できない場合に、`undefined` を返すことを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot'), { recursive: true })
    writeFileSync(path.join(root, '.pecot', 'work'), 'file')
    expect(ensureWorkDirectory('o/r/1')).toBeUndefined()
  })
})

describe('writeSessionTitle', () => {
  it('.pecot-session-title だけを書き込む', async () => {
    await explains('セッション名を書き込む `writeSessionTitle` のテストです。`[Task] 題名` を指定した場合に、`.pecot/state` の中は `.pecot-session-title` だけが作成され、内容が `#1253 題名` になることを確認します。')
    const root = useProject()
    writeSessionTitle('acme-labs/aist-plugin/1253', '[Task] 題名')
    const stateDirectory = path.join(root, '.pecot', 'state')
    expect(readdirSync(stateDirectory)).toEqual(['.pecot-session-title'])
    expect(readFileSync(path.join(stateDirectory, '.pecot-session-title'), 'utf8')).toBe('#1253 題名')
  })

  it('タイトルを取得できなかった場合は、番号だけのセッション名にする', async () => {
    await explains('セッション名を書き込む `writeSessionTitle` のテストです。タイトルが空文字列の場合に、`.pecot-session-title` の内容が `#5` になることを確認します。')
    const root = useProject()
    writeSessionTitle('owner/repo/5', '')
    expect(readFileSync(path.join(root, '.pecot', 'state', '.pecot-session-title'), 'utf8')).toBe('#5')
  })

  it('番号が数字ではない場合は、InvalidValueError を送出し、何も書き込まない', async () => {
    await explains('セッション名を書き込む `writeSessionTitle` のテストです。番号が `abc` の場合に、`InvalidValueError` が発生し、`.pecot/state` にファイルが作成されないことを確認します。')
    const root = useProject()
    expect(() => {
      writeSessionTitle('owner/repo/abc', '題名')
    }).toThrow(InvalidValueError)
    const stateDirectory = path.join(root, '.pecot', 'state')
    expect(!existsSync(stateDirectory) || readdirSync(stateDirectory).length === 0).toBe(true)
  })

  it('プロジェクトルートを特定できない場合は、ProjectRootNotFoundError を送出する', async () => {
    await explains('セッション名を書き込む `writeSessionTitle` のテストです。プロジェクトルートを特定できないディレクトリで実行した場合に、`ProjectRootNotFoundError` が発生することを確認します。')
    const outside = makeTemporaryDirectory()
    const previous = process.cwd()
    process.chdir(outside)
    try {
      expect(() => {
        writeSessionTitle('o/r/1', 't')
      }).toThrow(ProjectRootNotFoundError)
    }
    finally {
      process.chdir(previous)
    }
  })
})

describe('writeBaseRecord / readBaseRecord', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567'

  it('スタックした base の記録を書き込み、読み込んで同じ内容を取得する', async () => {
    await explains('base の記録を書き込む `writeBaseRecord` と、読み込む `readBaseRecord` のテストです。ブランチ・SHA・親の Issue を書き込んだ場合に、`.pecot-base` が `feat/3 <SHA> acme/demo#3` の形になり、`stacked` として読み込めることを確認します。')
    const root = useProject()
    writeBaseRecord({ branch: 'feat/3', sha: SHA, stackedOn: createIssueReference(createRepositoryReference('acme', 'demo'), 3) })
    expect(readFileSync(path.join(root, '.pecot', 'state', '.pecot-base'), 'utf8')).toBe(`feat/3 ${SHA} acme/demo#3`)
    expect(readBaseRecord()).toMatchObject({ kind: 'stacked', record: { branch: 'feat/3', sha: SHA }, stackedOn: { number: 3 } })
  })

  it('記録のファイルが存在しない場合は、開発ブランチから着手したものとして読み込む', async () => {
    await explains('base の記録を読み込む `readBaseRecord` のテストです。`.pecot-base` が存在しない場合に、`kind` が `development` で `record` が `undefined` の結果を返すことを確認します。')
    useProject()
    expect(readBaseRecord()).toEqual({ kind: 'development', record: undefined })
  })

  it('記録の形式が不正な場合は、malformed として読み込む', async () => {
    await explains('base の記録を読み込む `readBaseRecord` のテストです。`.pecot-base` の内容が `garbage` のように不正な場合に、`kind` が `malformed` で内容を含む結果を返すことを確認します。')
    useProject()
    writeFlag('.pecot-base', 'garbage')
    expect(readBaseRecord()).toEqual({ kind: 'malformed', content: 'garbage' })
  })
})
