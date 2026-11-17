import { describe, expect, it } from 'vitest'

import { evaluateRequirements, findWorkflowTemplate, isOutdated, readTemplateVersion, userLines, WORKFLOW_TEMPLATES } from '../workflow-template.js'
import type { SettingList, SettingNames } from '../workflow-template.js'

const BUNDLED = [
  '# pecot-workflow-template: review 2',
  'jobs:',
  '  # pecot-review:prepare:begin',
  '  # Add steps here.',
  '  # pecot-review:prepare:end',
  '',
].join('\n')

function review(): NonNullable<ReturnType<typeof findWorkflowTemplate>> {
  const template = findWorkflowTemplate('review')
  if (template === undefined) throw new Error('review is not in the list')
  return template
}

describe('雛形の一覧', () => {
  it('review の行が、名前・雛形のファイル・置き先・要る変数と secret を持つ', () => {
    expect(WORKFLOW_TEMPLATES.map(template => template.name)).toEqual(['review'])
    const template = review()
    expect(template.templateFile).toBe('pecot-review.yml')
    expect(template.destination).toBe('.github/workflows/pecot-review.yml')
    expect(template.requirements.map(requirement => requirement.missing)).toEqual([
      'secret PECOT_AGENT_APP_PRIVATE_KEY',
      'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*',
    ])
  })

  it('一覧に無い名前は undefined', () => {
    expect(findWorkflowTemplate('deploy')).toBeUndefined()
  })
})

describe('readTemplateVersion', () => {
  it('1 行目の目印から名前と版を読む', () => {
    expect(readTemplateVersion(BUNDLED)).toEqual({ name: 'review', version: 2 })
  })

  it('1 行目に目印が無ければ undefined', () => {
    expect(readTemplateVersion('name: review\n# pecot-workflow-template: review 2\n')).toBeUndefined()
  })
})

describe('isOutdated', () => {
  it('版が同じなら古くない', () => {
    expect(isOutdated(BUNDLED, BUNDLED)).toBe(false)
  })

  it('版が小さいものを古いとする', () => {
    expect(isOutdated(BUNDLED.replace('review 2', 'review 1'), BUNDLED)).toBe(true)
  })

  it('目印の無いファイルを古いとする', () => {
    expect(isOutdated('name: review\n', BUNDLED)).toBe(true)
  })

  it('名前の違う目印を古いとする', () => {
    expect(isOutdated(BUNDLED.replace('review 2', 'deploy 9'), BUNDLED)).toBe(true)
  })
})

describe('userLines', () => {
  it('囲みの中で、同梱の雛形に無い行を返す', () => {
    const installed = BUNDLED.replace('  # Add steps here.', '  # Add steps here.\n  - run: pnpm install')
    expect(userLines(installed, BUNDLED)).toEqual(['  - run: pnpm install'])
  })

  it('囲みの外の行と、同梱の雛形と同じ行は返さない', () => {
    expect(userLines(`${BUNDLED}extra: true\n`, BUNDLED)).toEqual([])
  })
})

// undefined は読めなかった一覧（名前は無し）
function list(found: readonly string[] | undefined): SettingList {
  return { names: new Set(found), complete: found !== undefined }
}

function names(secrets: readonly string[] | undefined, variables: readonly string[] | undefined): SettingNames {
  return {
    secrets: list(secrets),
    variables: list(variables),
  }
}

describe('evaluateRequirements', () => {
  const requirements = review().requirements
  const anthropicVariables = ['FEDERATION_RULE_ID', 'ORGANIZATION_ID', 'SERVICE_ACCOUNT_ID', 'WORKSPACE_ID'].map(suffix => `PECOT_AGENT_ANTHROPIC_${suffix}`)

  it('何も無ければ、モデルの認証だけを足りないとし、条件の付いた秘密鍵の項目は出さない', () => {
    expect(evaluateRequirements(requirements, names([], []))).toEqual([{ name: 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*', state: 'missing' }])
  })

  it('secret のトークンがあれば、そろっている', () => {
    expect(evaluateRequirements(requirements, names(['CLAUDE_CODE_OAUTH_TOKEN'], [])).map(result => result.state)).toEqual(['ok'])
  })

  it('Workload Identity Federation の 4 つの変数がそろえば、そろっている。3 つでは足りない', () => {
    expect(evaluateRequirements(requirements, names([], anthropicVariables))[0]?.state).toBe('ok')
    const threeVariables = names([], anthropicVariables.slice(1))
    expect(evaluateRequirements(requirements, threeVariables)[0]?.state).toBe('missing')
  })

  it('App の Client ID の変数があり秘密鍵の secret の無いとき、秘密鍵を足りないとする', () => {
    expect(evaluateRequirements(requirements, names(['CLAUDE_CODE_OAUTH_TOKEN'], ['PECOT_AGENT_APP_CLIENT_ID']))[0]).toEqual({ name: 'secret PECOT_AGENT_APP_PRIVATE_KEY', state: 'missing' })
  })

  it('secret の一覧を読めなければ、secret に頼る項目を skipped にし、足りないとしない', () => {
    expect(evaluateRequirements(requirements, names(undefined, ['PECOT_AGENT_APP_CLIENT_ID'])).map(result => result.state)).toEqual(['skipped', 'skipped'])
  })

  it('一部の一覧を読めなくても、読めた一覧に名前があれば ok にする', () => {
    const partial: SettingNames = { secrets: { names: new Set(['CLAUDE_CODE_OAUTH_TOKEN']), complete: false }, variables: list([]) }
    expect(evaluateRequirements(requirements, partial)).toEqual([{ name: 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*', state: 'ok' }])
  })

  it('読めない一覧があっても、読めた一覧でそろえば ok にする', () => {
    expect(evaluateRequirements(requirements, names(undefined, anthropicVariables)).map(result => result.state)).toEqual(['ok'])
  })
})
