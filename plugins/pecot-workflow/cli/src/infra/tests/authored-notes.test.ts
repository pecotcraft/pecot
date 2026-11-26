/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { readAuthoredNotes } from '../authored-notes.js'
import type { AuthoredNotes, NotesResult } from '../authored-notes.js'

useIsolatedEnvironment()

/**
interface/authored.yaml を置いた plugin ルートを作る
*/
function rootWith(content: string | undefined): string {
  const root = makeTemporaryDirectory()
  if (content !== undefined) {
    mkdirSync(path.join(root, 'interface'))
    writeFileSync(path.join(root, 'interface', 'authored.yaml'), content, 'utf8')
  }
  return root
}

const VALID = `format: 1
plugin: demo
entries:
  PW-DEMO:
    constraints:
      - requires: {message: [issue, template]}
      - conflicts: [file, screenshot]
    details:
      - First detail.
      - yes
      - "Third: detail."
    examples:
      - run: pecot demo a
        note: Run a.
    default_notes:
      base: The base of the demo.
    stdin: none
  PW-OTHER:
    constraints: []
    details: []
    examples: []
    default_notes: {}
`

/**
読めたときの notes。読めなかったら失敗にする
*/
function notesFrom(result: NotesResult): AuthoredNotes {
  if (result.kind !== 'read') throw new Error(`読めなかった: ${result.reason}`)
  return result.notes
}

function reasonOf(result: NotesResult): string {
  return result.kind === 'unreadable' ? result.reason : 'read'
}

function notesFor(id: string): AuthoredNotes {
  return notesFrom(readAuthoredNotes(id, rootWith(VALID)))
}

function reasonFor(id: string, content: string): string {
  return reasonOf(readAuthoredNotes(id, rootWith(content)))
}

describe('readAuthoredNotes', () => {
  it('項目の details・constraints・examples・default_notes を読み込んで返す', async () => {
    await explains('コマンドの補足情報を読み込む `readAuthoredNotes` のテストです。`interface/authored.yaml` の項目に `details`・`constraints`・`examples`・`default_notes` がある場合に、それぞれを読み込んで返すことを確認します。')
    expect(notesFor('PW-DEMO')).toEqual({
      details: ['First detail.', 'yes', 'Third: detail.'],
      constraints: [{ requires: { message: ['issue', 'template'] } }, { conflicts: ['file', 'screenshot'] }],
      examples: [{ run: 'pecot demo a', note: 'Run a.' }],
      defaultNotes: new Map([['base', 'The base of the demo.']]),
    })
  })

  it('項目に help があると、details・examples・default_notes を help から返す', async () => {
    await explains('項目に `help` がある場合の `readAuthoredNotes` のテストです。`details`・`examples`・`default_notes` は `help` の中の値（英語の文）を返し、`constraints` は項目の値を返すことを確認します。')
    const content = `entries:
  PW-DEMO:
    constraints:
      - conflicts: [file, screenshot]
    details: [Site detail.]
    examples: [{run: pecot demo a, note: Site note.}]
    default_notes: {base: Site base.}
    help:
      details: [English detail.]
      examples: [{run: pecot demo a, note: Run a.}]
      default_notes: {base: The base of the demo.}
`
    const result = readAuthoredNotes('PW-DEMO', rootWith(content))
    expect(notesFrom(result)).toEqual({
      details: ['English detail.'],
      constraints: [{ conflicts: ['file', 'screenshot'] }],
      examples: [{ run: 'pecot demo a', note: 'Run a.' }],
      defaultNotes: new Map([['base', 'The base of the demo.']]),
    })
  })

  it('examples が MCP の呼び出し（arguments）の形でも、help の examples を返す', async () => {
    await explains('項目の `examples` が MCP の呼び出し（`arguments`）の形の場合の `readAuthoredNotes` のテストです。CLI で実行する形の `help` の `examples` を返すことを確認します。')
    const content = `entries:
  PW-DEMO:
    constraints: []
    details: [Site detail.]
    examples: [{arguments: {target: a}, note: Site note.}]
    default_notes: {}
    help:
      details: [English detail.]
      examples: [{run: pecot demo a, note: Run a.}]
      default_notes: {}
`
    const { examples } = notesFrom(readAuthoredNotes('PW-DEMO', rootWith(content)))
    expect(examples).toEqual([{ run: 'pecot demo a', note: 'Run a.' }])
  })

  it('YAML 1.2 として読み込み、文字列の yes を真偽値にしない', async () => {
    await explains('`readAuthoredNotes` の YAML の読み込みのテストです。YAML 1.2 として読み込むため、`details` の `yes` が真偽値にならず、文字列の `yes` のままであることを確認します。')
    expect(notesFor('PW-DEMO').details[1]).toBe('yes')
  })

  it('空の欄は、空の配列と空の Map にして返す', async () => {
    await explains('項目の欄が空の場合の `readAuthoredNotes` のテストです。`details`・`constraints`・`examples` は空の配列、`default_notes` は空の `Map` として返すことを確認します。')
    expect(notesFor('PW-OTHER')).toEqual({ details: [], constraints: [], examples: [], defaultNotes: new Map() })
  })

  it('ファイルが存在しない場合は、読み込もうとした絶対パスと理由を返す', async () => {
    await explains('`interface/authored.yaml` が存在しない場合の `readAuthoredNotes` のテストです。`unreadable` として、読み込もうとした絶対パスと、`the file does not exist` の理由を返すことを確認します。')
    const root = rootWith(undefined)
    expect(readAuthoredNotes('PW-DEMO', root)).toEqual({ kind: 'unreadable', file: path.join(root, 'interface', 'authored.yaml'), reason: 'the file does not exist' })
  })

  it('ファイルを読み込めない場合（ディレクトリなど）は、読み込めない理由を返す', async () => {
    await explains('`authored.yaml` がディレクトリの場合の `readAuthoredNotes` のテストです。ファイルとして読み込めないため、`the file cannot be read` の理由を返すことを確認します。')
    const root = makeTemporaryDirectory()
    mkdirSync(path.join(root, 'interface', 'authored.yaml'), { recursive: true })
    expect(reasonOf(readAuthoredNotes('PW-DEMO', root))).toBe('the file cannot be read')
  })

  it('YAML として解釈できない場合は、その理由を返す', async () => {
    await explains('YAML として不正な内容の場合の `readAuthoredNotes` のテストです。`it is not valid YAML` の理由を返すことを確認します。')
    expect(reasonFor('PW-DEMO', 'entries: [unclosed\n  - : :')).toBe('it is not valid YAML')
  })

  it('entries が存在しない場合は、その理由を返す', async () => {
    await explains('`entries` を持たない YAML の場合の `readAuthoredNotes` のテストです。`it has no entries` の理由を返すことを確認します。')
    expect(reasonFor('PW-DEMO', 'format: 1\nplugin: demo\n')).toBe('it has no entries')
  })

  it('指定した ID の項目が存在しない場合は、ID を含む理由を返す', async () => {
    await explains('存在しない ID を指定した場合の `readAuthoredNotes` のテストです。`it has no entry PW-MISSING` のように、ID を含む理由を返すことを確認します。')
    expect(reasonFor('PW-MISSING', VALID)).toBe('it has no entry PW-MISSING')
  })

  it('欄の形が不正な場合は、ID を含む理由を返す', async () => {
    await explains('項目の欄の形が不正な場合の `readAuthoredNotes` のテストです。欄の型の誤りや、未定義のキー、欄の欠落のどれでも、ID を含む `the fields of PW-DEMO have the wrong shape` の理由を返すことを確認します。')
    const wrong = 'the fields of PW-DEMO have the wrong shape'
    expect(reasonFor('PW-DEMO', 'entries:\n  PW-DEMO:\n    details: text\n    constraints: []\n    examples: []\n    default_notes: {}\n')).toBe(wrong)
    expect(reasonFor('PW-DEMO', 'entries:\n  PW-DEMO:\n    details: []\n    constraints: [{unknown: [a]}]\n    examples: []\n    default_notes: {}\n')).toBe(wrong)
    expect(reasonFor('PW-DEMO', 'entries:\n  PW-DEMO:\n    details: []\n    constraints: []\n    default_notes: {}\n')).toBe(wrong)
    expect(reasonFor('PW-DEMO', 'entries:\n  PW-DEMO:\n    details: []\n    constraints: []\n    examples: []\n')).toBe(wrong)
  })

  it('yaml の警告（未知のタグ）を process.emitWarning で通知せず、項目を読み込む', async () => {
    await explains('未知のタグを含む YAML を読み込む `readAuthoredNotes` のテストです。`process.emitWarning` で警告を通知せず、項目を `read` として読み込めることを確認します。')
    const warnings: unknown[] = []
    const listener = (warning: unknown): void => {
      warnings.push(warning)
    }
    process.on('warning', listener)
    try {
      expect(readAuthoredNotes('PW-DEMO', rootWith(`${VALID}tagged: !unknown 1\n`)).kind).toBe('read')
      // process.emitWarning の通知は次の tick に届く
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    finally {
      process.off('warning', listener)
    }
    expect(warnings).toEqual([])
  })

  it('root を指定しない場合は、配布している authored.yaml から読み込む', async () => {
    await explains('`root` を省略した `readAuthoredNotes` のテストです。`PW-SESSION-START` の場合に、`authored.yaml` から読み込み、`default_notes` の `base` に `develop_branch` が含まれることを確認します。')
    const notes = notesFrom(readAuthoredNotes('PW-SESSION-START'))
    expect(notes.details.length).toBeGreaterThan(0)
    expect(notes.examples.length).toBeGreaterThan(0)
    expect(notes.defaultNotes.get('base')).toContain('develop_branch')
  })
})
