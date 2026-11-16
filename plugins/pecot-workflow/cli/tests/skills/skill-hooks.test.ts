// スキルの frontmatter に置く hooks（ExitPlanMode の PostToolUse）の検証。
import { accessSync, constants, globSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings } from '../parity/baseline.js'
import { asRecord, frontmatter } from './_helpers/frontmatter.js'
import { pluginRoot } from './_helpers/documents.js'

const PREFIX = '"${CLAUDE_PLUGIN_ROOT}"/hooks/post-tool-use-exit-plan-mode.sh'
const WITH_HOOKS: Readonly<Record<string, string>> = { 'w-active': '--mode=active', 'w-quick': '--mode=quick' }

function skillFile(name: string): string {
  return path.join(pluginRoot, 'skills', name, 'SKILL.md')
}

function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError('配列ではありません')
  return value
}

describe('スキルの frontmatter のフック', () => {
  for (const [name, mode] of Object.entries(WITH_HOOKS)) {
    describe(`skill ${name}`, () => {
      const hooks = asRecord(frontmatter(skillFile(name))['hooks'])

      it('PostToolUse だけを持ち、1 組で ExitPlanMode に一致する', () => {
        expect(Object.keys(hooks)).toEqual(['PostToolUse'])
        const groups = asArray(hooks['PostToolUse'])
        expect(groups).toHaveLength(1)
        const group = asRecord(groups[0])
        expect(group['matcher']).toBe('ExitPlanMode')
        expect(String(group['matcher'])).not.toContain('|')
      })

      it('handler は 1 つで、once: true の command', () => {
        const group = asRecord(asArray(hooks['PostToolUse'])[0])
        const handlers = asArray(group['hooks'])
        expect(handlers).toHaveLength(1)
        const handler = asRecord(handlers[0])
        expect(handler['type']).toBe('command')
        expect(handler['once']).toBe(true)
        expect(handler['timeout']).toBe(10)
      })

      it('command は PREFIX で始まり mode で終わる', () => {
        const group = asRecord(asArray(hooks['PostToolUse'])[0])
        const command = String(asRecord(asArray(group['hooks'])[0])['command'])
        expect(command).toBe(`${PREFIX} ${mode}`)
        expect(command).not.toContain('CLAUDE_SKILL_DIR')
      })

      it('command の指すスクリプトがあり、実行の権限を持つ', () => {
        const script = path.join(pluginRoot, 'hooks', 'post-tool-use-exit-plan-mode.sh')
        expect(() => {
          accessSync(script, constants.X_OK)
        }).not.toThrow()
      })
    })
  }

  it('ほかのスキルは hooks を持たない', () => {
    const others = globSync('skills/*/SKILL.md', { cwd: pluginRoot })
      .toSorted(compareStrings)
      .filter(file => !Object.keys(WITH_HOOKS).includes(path.basename(path.dirname(file))))
    expect(others.length).toBeGreaterThan(0)
    const offenders = others.filter(file => 'hooks' in frontmatter(path.join(pluginRoot, file)))
    expect(offenders).toEqual([])
  })
})
