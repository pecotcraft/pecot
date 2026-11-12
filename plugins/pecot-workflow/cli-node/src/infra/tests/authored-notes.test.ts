/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
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
  it('項目の details・constraints・examples・default_notes を返す', () => {
    expect(notesFor('PW-DEMO')).toEqual({
      details: ['First detail.', 'yes', 'Third: detail.'],
      constraints: [{ requires: { message: ['issue', 'template'] } }, { conflicts: ['file', 'screenshot'] }],
      examples: [{ run: 'pecot demo a', note: 'Run a.' }],
      defaultNotes: new Map([['base', 'The base of the demo.']]),
    })
  })

  it('YAML 1.2 として読む（yes を真偽値にしない）ので、文字列の yes を保つ', () => {
    expect(notesFor('PW-DEMO').details[1]).toBe('yes')
  })

  it('空の欄は空の配列と空の Map で返す', () => {
    expect(notesFor('PW-OTHER')).toEqual({ details: [], constraints: [], examples: [], defaultNotes: new Map() })
  })

  it('ファイルが無ければ、読もうとした絶対パスと理由を返す', () => {
    const root = rootWith(undefined)
    expect(readAuthoredNotes('PW-DEMO', root)).toEqual({ kind: 'unreadable', file: path.join(root, 'interface', 'authored.yaml'), reason: 'the file does not exist' })
  })

  it('ファイルが読めなければ（ディレクトリなど）、読めない理由を返す', () => {
    const root = makeTemporaryDirectory()
    mkdirSync(path.join(root, 'interface', 'authored.yaml'), { recursive: true })
    expect(reasonOf(readAuthoredNotes('PW-DEMO', root))).toBe('the file cannot be read')
  })

  it('YAML として読めなければ、その理由を返す', () => {
    expect(reasonFor('PW-DEMO', 'entries: [unclosed\n  - : :')).toBe('it is not valid YAML')
  })

  it('entries が無ければ、その理由を返す', () => {
    expect(reasonFor('PW-DEMO', 'format: 1\nplugin: demo\n')).toBe('it has no entries')
  })

  it('項目が無ければ、ID を含む理由を返す', () => {
    expect(reasonFor('PW-MISSING', VALID)).toBe('it has no entry PW-MISSING')
  })

  it('欄の形が違えば、ID を含む理由を返す', () => {
    const wrong = 'the fields of PW-DEMO have the wrong shape'
    expect(reasonFor('PW-DEMO', 'entries:\n  PW-DEMO:\n    details: text\n    constraints: []\n    examples: []\n    default_notes: {}\n')).toBe(wrong)
    expect(reasonFor('PW-DEMO', 'entries:\n  PW-DEMO:\n    details: []\n    constraints: [{unknown: [a]}]\n    examples: []\n    default_notes: {}\n')).toBe(wrong)
    expect(reasonFor('PW-DEMO', 'entries:\n  PW-DEMO:\n    details: []\n    constraints: []\n    default_notes: {}\n')).toBe(wrong)
    expect(reasonFor('PW-DEMO', 'entries:\n  PW-DEMO:\n    details: []\n    constraints: []\n    examples: []\n')).toBe(wrong)
  })

  it('yaml の警告（未知のタグ）を process.emitWarning で出さず、項目は読む', async () => {
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

  it('root を渡さなければ、配布している authored.yaml から読む', () => {
    const notes = notesFrom(readAuthoredNotes('PW-CREATE-BRANCH'))
    expect(notes.details.length).toBeGreaterThan(0)
    expect(notes.examples.length).toBeGreaterThan(0)
    expect(notes.defaultNotes.get('base')).toContain('develop_branch')
  })
})
