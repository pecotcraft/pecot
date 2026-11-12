/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod の型は変えられない */
// コマンドの --help に出すはずの説明が欠けている項目を返す。
// 説明の欠けは、--help が名前だけの行になって読めない。全コマンドでこれが空であることを help-definition.test.ts が見る。
import { z } from 'zod'

import type { AuthoredNotes } from '../../src/infra/authored-notes.js'
import { normalizeInput } from '../../src/commands/input-schema.js'
import type { CommandDefinition } from '../../src/commands/registry.js'

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

/**
説明の欠けた項目の名前。コマンドの説明は `description`、引数は `argument:<名前>`、定義書の details が空なら `details`
*/
export function missingHelpItems(definition: Readonly<CommandDefinition>, notes: Readonly<AuthoredNotes> | undefined): readonly string[] {
  const input = normalizeInput(z.toJSONSchema(definition.input, { io: 'input' }), definition.path.join(' '), definition.hasOwnRepo)
  return [
    ...isBlank(definition.description) ? ['description'] : [],
    ...Object.entries(input.properties).filter(([, property]) => isBlank(property['description'])).map(([name]) => `argument:${name}`),
    ...notes === undefined || notes.details.length === 0 ? ['details'] : [],
  ]
}
