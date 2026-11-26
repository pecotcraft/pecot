// pecot-workflow の cli の registry.ts が登録するコマンドの形を、案内を描くテストのために登録する。
// hint-commands.json が registry と同じかは、cli の registry.test.ts が確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { registerHintCommands } from '../../src/domain/command-hint.js'

const Names = z.array(z.string())
const ShapeSchema = z.object({ path: Names, positional: Names, inputs: Names, cliOnly: Names, hasOwnRepo: z.boolean() })

const text = readFileSync(path.join(import.meta.dirname, 'hint-commands.json'), 'utf8')
registerHintCommands(z.array(ShapeSchema).parse(JSON.parse(text)))
