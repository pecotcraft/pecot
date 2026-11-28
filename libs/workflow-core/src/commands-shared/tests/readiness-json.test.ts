import { describe, expect, it } from 'vitest'
import { stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'

import { createIssueReference } from '../../domain/reference-parser.js'
import { createRepositoryReference } from '../../domain/repository-resolver.js'
import { readinessJson } from '../readiness-json.js'

const DEMO = createRepositoryReference('acme', 'demo')

describe('readinessJson', () => {
  it('スタック先と理由のコードが存在しない場合は、null として JSON に出力する', async () => {
    await explains('判定を JSON の形に変換する関数（`readinessJson`）のテストです。スタック先が存在しない場合は `null`、存在する場合は番号・リポジトリ・ブランチの形になり、理由のコードは `null` になることを確認します。')
    const stackOn = { issue: createIssueReference(DEMO, 2), branch: 'feat/2' }
    stepSync('結果を確認する', () => {
      expect([
        readinessJson({ kind: 'startable', stackOn: undefined, reason: undefined, needsReview: false, attention: [] }, '着手できる'),
        readinessJson({ kind: 'stackable', stackOn, reason: undefined, needsReview: false, attention: [] }, 'スタック'),
      ]).toEqual([
        // eslint-disable-next-line unicorn/no-null -- JSON の出力の null
        { kind: 'startable', stackOn: null, reason: null, text: '着手できる' },
        // eslint-disable-next-line unicorn/no-null -- JSON の出力の null
        { kind: 'stackable', stackOn: { number: 2, repository: 'acme/demo', branch: 'feat/2' }, reason: null, text: 'スタック' },
      ])
    })
  })
})
