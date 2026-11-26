/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

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
  it('プロジェクトルート配下の .pecot/state を返す', () => {
    const root = useProject()
    expect(getStateDirectory()).toBe(path.join(root, '.pecot', 'state'))
  })

  it('create なら無ければ作る', () => {
    const root = useProject()
    const stateDirectory = path.join(root, '.pecot', 'state')
    expect(existsSync(stateDirectory)).toBe(false)
    expect(getStateDirectory({ create: true })).toBe(stateDirectory)
    expect(existsSync(stateDirectory)).toBe(true)
  })

  it('create でなければ作らない', () => {
    const root = useProject()
    getStateDirectory()
    expect(existsSync(path.join(root, '.pecot'))).toBe(false)
  })
})

describe('touchFlag', () => {
  it('フラグファイルを作る', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    touchFlag('.test-flag')
    expect(existsSync(path.join(root, '.pecot', 'state', '.test-flag'))).toBe(true)
  })

  it('状態ディレクトリが無ければ作る', () => {
    const root = useProject()
    touchFlag('.test-flag')
    expect(existsSync(path.join(root, '.pecot', 'state', '.test-flag'))).toBe(true)
  })
})

describe('removeFlag', () => {
  it('フラグファイルを消す', () => {
    const root = useProject()
    touchFlag('.test-flag')
    removeFlag('.test-flag')
    expect(existsSync(path.join(root, '.pecot', 'state', '.test-flag'))).toBe(false)
  })

  it('無いファイルでもエラーにならない', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    expect(() => {
      removeFlag('.nonexistent-flag')
    }).not.toThrow()
  })
})

describe('hasFlag', () => {
  it('ファイルがあれば true', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(root, '.pecot', 'state', '.test-flag'), '')
    expect(hasFlag('.test-flag')).toBe(true)
  })

  it('無ければ false', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    expect(hasFlag('.nonexistent-flag')).toBe(false)
  })

  it('状態ディレクトリが無くても false', () => {
    useProject()
    expect(hasFlag('.test-flag')).toBe(false)
  })

  it('ディレクトリは false（通常ファイルだけ）', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state', '.dir-flag'), { recursive: true })
    expect(hasFlag('.dir-flag')).toBe(false)
  })
})

describe('readFlag（存在の確認と読み取りの間に消えた場合）', () => {
  it('ディレクトリは undefined', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state', '.dir-flag'), { recursive: true })
    expect(readFlag('.dir-flag')).toBeUndefined()
  })

  it('指す先が無いシンボリックリンクは undefined（読む時点で無かった扱い）', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    symlinkSync(path.join(root, 'nowhere'), path.join(root, '.pecot', 'state', '.dangling'))
    expect(readFlag('.dangling')).toBeUndefined()
  })
})

describe('writeFlag / readFlag', () => {
  it('内容を書き、前後の空白を除いて読む', () => {
    useProject()
    writeFlag('.pecot-session-title', '  #1 題名 \n')
    expect(readFlag('.pecot-session-title')).toBe('#1 題名')
  })

  it('無ければ undefined', () => {
    useProject()
    expect(readFlag('.missing')).toBeUndefined()
  })

  it('改行は \\n に揃えて読む（universal newlines）', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(root, '.pecot', 'state', '.crlf'), 'a\r\nb\r\n')
    expect(readFlag('.crlf')).toBe('a\nb')
  })
})

describe('ensureWorkDirectory', () => {
  it('owner/repo/N 形式から .pecot/work/N を作って返す', () => {
    const root = useProject()
    const result = ensureWorkDirectory('acme-labs/aist-plugin/655')
    expect(result).toBe(path.join(root, '.pecot', 'work', '655'))
    expect(existsSync(path.join(root, '.pecot', 'work', '655'))).toBe(true)
  })

  it('番号のみでも作れる', () => {
    const root = useProject()
    expect(ensureWorkDirectory('42')).toBe(path.join(root, '.pecot', 'work', '42'))
  })

  it('既存のディレクトリでもエラーにならない', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'work', '655'), { recursive: true })
    expect(ensureWorkDirectory('acme-labs/aist-plugin/655')).toBe(path.join(root, '.pecot', 'work', '655'))
  })

  it('全角数字の番号は作らない', () => {
    const root = useProject()
    expect(ensureWorkDirectory('o/r/\u{FF11}\u{FF12}')).toBeUndefined()
    expect(existsSync(path.join(root, '.pecot', 'work'))).toBe(false)
  })

  it('末尾が番号でない参照は undefined。ディレクトリも作らない', () => {
    const root = useProject()
    expect(ensureWorkDirectory('not-a-ref')).toBeUndefined()
    expect(existsSync(path.join(root, '.pecot', 'work'))).toBe(false)
  })

  it('プロジェクトルートが不明でも例外を投げず undefined', () => {
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

  it('作れない（work がファイル）ときも undefined', () => {
    const root = useProject()
    mkdirSync(path.join(root, '.pecot'), { recursive: true })
    writeFileSync(path.join(root, '.pecot', 'work'), 'file')
    expect(ensureWorkDirectory('o/r/1')).toBeUndefined()
  })
})

describe('writeSessionTitle', () => {
  it('.pecot-session-title だけを書く', () => {
    const root = useProject()
    writeSessionTitle('acme-labs/aist-plugin/1253', '[Task] 題名')
    const stateDirectory = path.join(root, '.pecot', 'state')
    expect(readdirSync(stateDirectory)).toEqual(['.pecot-session-title'])
    expect(readFileSync(path.join(stateDirectory, '.pecot-session-title'), 'utf8')).toBe('#1253 題名')
  })

  it('タイトルが取れなかったときは番号だけのセッション名', () => {
    const root = useProject()
    writeSessionTitle('owner/repo/5', '')
    expect(readFileSync(path.join(root, '.pecot', 'state', '.pecot-session-title'), 'utf8')).toBe('#5')
  })

  it('番号が数字でなければ値の不正で止まり、何も書かない', () => {
    const root = useProject()
    expect(() => {
      writeSessionTitle('owner/repo/abc', '題名')
    }).toThrow(InvalidValueError)
    const stateDirectory = path.join(root, '.pecot', 'state')
    expect(!existsSync(stateDirectory) || readdirSync(stateDirectory).length === 0).toBe(true)
  })

  it('プロジェクトルートが解決できなければ例外', () => {
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

  it('スタックした base を書いて読み戻す', () => {
    const root = useProject()
    writeBaseRecord({ branch: 'feat/3', sha: SHA, stackedOn: createIssueReference(createRepositoryReference('acme', 'demo'), 3) })
    expect(readFileSync(path.join(root, '.pecot', 'state', '.pecot-base'), 'utf8')).toBe(`feat/3 ${SHA} acme/demo#3`)
    expect(readBaseRecord()).toMatchObject({ kind: 'stacked', record: { branch: 'feat/3', sha: SHA }, stackedOn: { number: 3 } })
  })

  it('ファイルが無ければ、開発ブランチから着手したものとして読む', () => {
    useProject()
    expect(readBaseRecord()).toEqual({ kind: 'development', record: undefined })
  })

  it('形が誤っていれば malformed', () => {
    useProject()
    writeFlag('.pecot-base', 'garbage')
    expect(readBaseRecord()).toEqual({ kind: 'malformed', content: 'garbage' })
  })
})
