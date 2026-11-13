// 配布する board sync のワークフローの雛形が、安全な形と版の追従を保つことを確かめる。
// actionlint は pre-commit が掛ける（.pre-commit-config.yaml の actionlint-system が雛形も対象にする）。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const pluginRoot = path.resolve(import.meta.dirname, '..', '..')
const template = readFileSync(path.join(pluginRoot, 'cli/templates/workflow/pecot-board-sync.yml'), 'utf8')
const manifest: unknown = JSON.parse(readFileSync(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8'))
const active = template.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')

function pluginMajor(): string {
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || typeof manifest.version !== 'string') {
    throw new TypeError('plugin.json に version が無い')
  }
  const [major = ''] = manifest.version.split('.', 1)
  return major
}

describe('board sync のワークフローの雛形', () => {
  it('npx の版指定が plugin.json の major と一致する', () => {
    expect(active).toContain(`@pecot/workflow-mcp@${pluginMajor()} board sync`)
  })

  it('pull_request_target を使い、pull_request は使わない', () => {
    expect(active).toMatch(/^ {2}pull_request_target:/m)
    expect(active).not.toMatch(/^ {2}pull_request:/m)
  })

  it('checkout は ref を指定せず、資格情報を残さない', () => {
    const checkout = active.split(/\n {6}- /).find(step => step.includes('actions/checkout'))
    expect(checkout).toBeDefined()
    expect(checkout).not.toMatch(/\bref:/)
    expect(checkout).toContain('persist-credentials: false')
  })

  it('permissions は contents: read だけで、cancel-in-progress は false', () => {
    expect(active).toMatch(/^permissions:\n {2}contents: read\n(?! {2})/m)
    expect(active).toContain('cancel-in-progress: false')
  })

  it('run に式を埋め込まない', () => {
    const commands = Array.from(active.matchAll(/^\s*run: ([^\n]*)/gm), match => match[1])
    expect(commands).toEqual(['npx -y --prefix=/ @pecot/workflow-mcp@' + pluginMajor() + ' board sync'])
  })

  it('action は SHA で固定する', () => {
    const uses = Array.from(active.matchAll(/uses: (\S+)/g), match => match[1])
    expect(uses).toHaveLength(3)
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/)
  })
})
