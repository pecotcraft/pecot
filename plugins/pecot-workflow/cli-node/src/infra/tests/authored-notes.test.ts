/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { readAuthoredNotes } from '../authored-notes.js'

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
    stdin: none
  PW-OTHER:
    constraints: []
    details: []
    examples: []
`

describe('readAuthoredNotes', () => {
  it('項目の details・constraints・examples を返す', () => {
    expect(readAuthoredNotes('PW-DEMO', rootWith(VALID))).toEqual({
      details: ['First detail.', 'yes', 'Third: detail.'],
      constraints: [{ requires: { message: ['issue', 'template'] } }, { conflicts: ['file', 'screenshot'] }],
      examples: [{ run: 'pecot demo a', note: 'Run a.' }],
    })
  })

  it('YAML 1.2 として読む（yes を真偽値にしない）ので、文字列の yes を保つ', () => {
    expect(readAuthoredNotes('PW-DEMO', rootWith(VALID))?.details[1]).toBe('yes')
  })

  it('空の欄は空の配列で返す', () => {
    expect(readAuthoredNotes('PW-OTHER', rootWith(VALID))).toEqual({ details: [], constraints: [], examples: [] })
  })

  it('ファイルが無ければ undefined', () => {
    expect(readAuthoredNotes('PW-DEMO', rootWith(undefined))).toBeUndefined()
  })

  it('YAML として読めなければ undefined', () => {
    expect(readAuthoredNotes('PW-DEMO', rootWith('entries: [unclosed\n  - : :'))).toBeUndefined()
  })

  it('entries が無ければ undefined', () => {
    expect(readAuthoredNotes('PW-DEMO', rootWith('format: 1\nplugin: demo\n'))).toBeUndefined()
  })

  it('項目が無ければ undefined', () => {
    expect(readAuthoredNotes('PW-MISSING', rootWith(VALID))).toBeUndefined()
  })

  it('欄の形が違えば undefined', () => {
    expect(readAuthoredNotes('PW-DEMO', rootWith('entries:\n  PW-DEMO:\n    details: text\n    constraints: []\n    examples: []\n'))).toBeUndefined()
    expect(readAuthoredNotes('PW-DEMO', rootWith('entries:\n  PW-DEMO:\n    details: []\n    constraints: [{unknown: [a]}]\n    examples: []\n'))).toBeUndefined()
    expect(readAuthoredNotes('PW-DEMO', rootWith('entries:\n  PW-DEMO:\n    details: []\n    constraints: []\n'))).toBeUndefined()
  })

  it('root を渡さなければ、配布している authored.yaml から読む', () => {
    const notes = readAuthoredNotes('PW-CREATE-BRANCH')
    expect(notes?.details.length).toBeGreaterThan(0)
    expect(notes?.examples.length).toBeGreaterThan(0)
  })
})
