import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { evaluateRequirements, findWorkflowTemplate, isOutdated, npxWorkflowMcpLines, pecotActionReferences, pinPecotActions, readTemplateVersion, userLines, hasPecotActionStep, WORKFLOW_TEMPLATES } from '../workflow-template.js'
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
  it('review の行が、名前・雛形のファイル・置き先・要る変数と secret を持つ', async () => {
    await explains('ワークフローのテンプレート一覧のテストです。一覧が `board-sync`・`review`・`handoff`・`auto` の順に並び、`review` の行がテンプレートのファイル名・配置先・必要な変数と secret を持つことを確認します。')
    expect(WORKFLOW_TEMPLATES.map(template => template.name)).toEqual(['board-sync', 'review', 'handoff', 'auto'])
    const template = review()
    expect(template.templateFile).toBe('pecot-review.yml')
    expect(template.destination).toBe('.github/workflows/pecot-review.yml')
    expect(template.requirements.map(requirement => requirement.missing)).toEqual([
      'secret PECOT_AGENT_APP_PRIVATE_KEY',
      'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*',
    ])
  })

  it('handoff の行は、引き継ぎのテンプレートと配置先を持ち、review と同じエージェント用の認証を必要とする', async () => {
    await explains('ワークフローのテンプレート一覧のテストです。`handoff` の行が、引き継ぎのテンプレートと配置先を持ち、`review` と同じエージェント用の認証を必要とすることを確認します。')
    const template = findWorkflowTemplate('handoff')
    expect(template?.templateFile).toBe('pecot-handoff.yml')
    expect(template?.destination).toBe('.github/workflows/pecot-handoff.yml')
    expect(template?.requirements).toBe(review().requirements)
  })

  it('auto の行は、自動処理のテンプレートと配置先を持ち、App の変数と secret とモデルの認証を必要とし、Claude の App を使わない', async () => {
    await explains('ワークフローのテンプレート一覧のテストです。`auto` の行が、自動処理のテンプレートと配置先を持ち、App の変数と secret とモデルの認証を必要とし、Claude の App を使わないことを確認します。')
    const template = findWorkflowTemplate('auto')
    expect(template?.templateFile).toBe('pecot-auto.yml')
    expect(template?.destination).toBe('.github/workflows/pecot-auto.yml')
    expect(template?.requirements.map(requirement => requirement.missing)).toEqual([
      'variable PECOT_AGENT_APP_CLIENT_ID',
      'secret PECOT_AGENT_APP_PRIVATE_KEY',
      'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*',
    ])
    expect(template?.requirements[2]).toBe(review().requirements[1])
    expect(template?.claudeApp).toBe(false)
  })

  it('一覧に存在しない名前を渡すと、undefined を返す', async () => {
    await explains('ワークフローのテンプレート一覧のテストです。一覧に存在しない名前を渡した場合に、`undefined` を返すことを確認します。')
    expect(findWorkflowTemplate('deploy')).toBeUndefined()
  })
})

describe('readTemplateVersion', () => {
  it('1 行目のマーカーから、名前と版を読み取る', async () => {
    await explains('テンプレートの版を読み取る関数のテストです。1 行目に `# pecot-workflow-template: review 2` のマーカーがある場合に、名前 `review` と版 `2` を返すことを確認します。')
    expect(readTemplateVersion(BUNDLED)).toEqual({ name: 'review', version: 2 })
  })

  it('1 行目にマーカーが存在しない場合は、undefined を返す', async () => {
    await explains('テンプレートの版を読み取る関数のテストです。1 行目にマーカーが存在しない場合に、`undefined` を返すことを確認します。')
    expect(readTemplateVersion('name: review\n# pecot-workflow-template: review 2\n')).toBeUndefined()
  })
})

describe('isOutdated', () => {
  it('版が同じ場合は、古くないと判定する', async () => {
    await explains('テンプレートが古いかを判定する関数のテストです。インストール済みのファイルと同梱のテンプレートの版が同じ場合に、古くないと判定することを確認します。')
    expect(isOutdated(BUNDLED, BUNDLED)).toBe(false)
  })

  it('版が小さい場合は、古いと判定する', async () => {
    await explains('テンプレートが古いかを判定する関数のテストです。インストール済みのファイルの版が同梱のテンプレートより小さい場合に、古いと判定することを確認します。')
    expect(isOutdated(BUNDLED.replace('review 2', 'review 1'), BUNDLED)).toBe(true)
  })

  it('マーカーが存在しないファイルは、古いと判定する', async () => {
    await explains('テンプレートが古いかを判定する関数のテストです。マーカーが存在しないファイルを、古いと判定することを確認します。')
    expect(isOutdated('name: review\n', BUNDLED)).toBe(true)
  })

  it('マーカーの名前が異なる場合は、古いと判定する', async () => {
    await explains('テンプレートが古いかを判定する関数のテストです。マーカーの名前が同梱のテンプレートと異なる場合に、古いと判定することを確認します。')
    expect(isOutdated(BUNDLED.replace('review 2', 'deploy 9'), BUNDLED)).toBe(true)
  })
})

describe('userLines', () => {
  it('囲みの中にある、同梱のテンプレートに存在しない行を返す', async () => {
    await explains('利用者が追加した行を取り出す関数のテストです。囲みの中に、同梱のテンプレートに存在しない行がある場合に、その行を返すことを確認します。')
    const installed = BUNDLED.replace('  # Add steps here.', '  # Add steps here.\n  - run: pnpm install')
    expect(userLines(installed, BUNDLED)).toEqual(['  - run: pnpm install'])
  })

  it('囲みの外の行と、同梱のテンプレートと同じ行は返さない', async () => {
    await explains('利用者が追加した行を取り出す関数のテストです。囲みの外の行と、同梱のテンプレートと同じ行を、返さないことを確認します。')
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

  it('secret と変数が存在しない場合は、モデルの認証だけを不足と判定し、条件付きの秘密鍵の項目は含めない', async () => {
    await explains('必要な設定の判定のテストです。secret と変数が存在しない場合に、モデルの認証だけを `missing` と判定し、条件付きの秘密鍵の項目は結果に含めないことを確認します。')
    expect(evaluateRequirements(requirements, names([], []))).toEqual([{ name: 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*', state: 'missing' }])
  })

  it('secret のトークンが存在する場合は、条件を満たすと判定する', async () => {
    await explains('必要な設定の判定のテストです。secret のトークンが存在する場合に、モデルの認証を `ok` と判定することを確認します。')
    expect(evaluateRequirements(requirements, names(['CLAUDE_CODE_OAUTH_TOKEN'], [])).map(result => result.state)).toEqual(['ok'])
  })

  it('Workload Identity Federation の 4 つの変数がそろっている場合は条件を満たし、3 つでは満たさない', async () => {
    await explains('必要な設定の判定のテストです。Workload Identity Federation 用の 4 つの変数がそろっている場合は `ok` と判定し、3 つだけの場合は `missing` と判定することを確認します。')
    expect(evaluateRequirements(requirements, names([], anthropicVariables))[0]?.state).toBe('ok')
    const threeVariables = names([], anthropicVariables.slice(1))
    expect(evaluateRequirements(requirements, threeVariables)[0]?.state).toBe('missing')
  })

  it('App の Client ID の変数が存在し秘密鍵の secret が存在しない場合は、秘密鍵を不足と判定する', async () => {
    await explains('必要な設定の判定のテストです。App の Client ID の変数は存在するが秘密鍵の secret が存在しない場合に、秘密鍵を `missing` と判定することを確認します。')
    expect(evaluateRequirements(requirements, names(['CLAUDE_CODE_OAUTH_TOKEN'], ['PECOT_AGENT_APP_CLIENT_ID']))[0]).toEqual({ name: 'secret PECOT_AGENT_APP_PRIVATE_KEY', state: 'missing' })
  })

  it('secret の一覧を取得できない場合は、secret に依存する項目を skipped と判定し、不足とは判定しない', async () => {
    await explains('必要な設定の判定のテストです。secret の一覧を取得できなかった場合に、secret に依存する項目を `missing` でなく `skipped` と判定することを確認します。')
    expect(evaluateRequirements(requirements, names(undefined, ['PECOT_AGENT_APP_CLIENT_ID'])).map(result => result.state)).toEqual(['skipped', 'skipped'])
  })

  it('一部の一覧を取得できなくても、取得できた一覧に名前が存在すれば ok と判定する', async () => {
    await explains('必要な設定の判定のテストです。一部の一覧を取得できなくても、取得できた一覧に名前が存在する場合に、`ok` と判定することを確認します。')
    const partial: SettingNames = { secrets: { names: new Set(['CLAUDE_CODE_OAUTH_TOKEN']), complete: false }, variables: list([]) }
    expect(evaluateRequirements(requirements, partial)).toEqual([{ name: 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*', state: 'ok' }])
  })

  it('取得できない一覧があっても、取得できた一覧で条件がそろえば ok と判定する', async () => {
    await explains('必要な設定の判定のテストです。取得できない一覧があっても、取得できた一覧で条件がそろう場合に、`ok` と判定することを確認します。')
    expect(evaluateRequirements(requirements, names(undefined, anthropicVariables)).map(result => result.state)).toEqual(['ok'])
  })
})

describe('evaluateRequirements（auto）', () => {
  const requirements = findWorkflowTemplate('auto')?.requirements ?? []

  it('変数と secret が 1 つも存在しない場合は、App の変数と secret を不足と判定する', async () => {
    await explains('`auto` のテンプレートの、必要な設定の判定のテストです。変数と secret が 1 つも存在しない場合に、App の変数と secret とモデルの認証をすべて `missing` と判定することを確認します。')
    expect(evaluateRequirements(requirements, names([], []))).toEqual([
      { name: 'variable PECOT_AGENT_APP_CLIENT_ID', state: 'missing' },
      { name: 'secret PECOT_AGENT_APP_PRIVATE_KEY', state: 'missing' },
      { name: 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*', state: 'missing' },
    ])
  })

  it('App の変数と secret とトークンがそろっている場合は、すべて ok と判定する', async () => {
    await explains('`auto` のテンプレートの、必要な設定の判定のテストです。App の変数と secret とトークンがそろっている場合に、すべての項目を `ok` と判定することを確認します。')
    const ready = names(['PECOT_AGENT_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], ['PECOT_AGENT_APP_CLIENT_ID'])
    expect(evaluateRequirements(requirements, ready).map(result => result.state)).toEqual(['ok', 'ok', 'ok'])
  })
})

describe('evaluateRequirements（board-sync）', () => {
  const requirements = findWorkflowTemplate('board-sync')?.requirements ?? []

  it.for([
    { name: 'App の変数と secret', secrets: ['PECOT_BOARD_SYNC_APP_PRIVATE_KEY'], variables: ['PECOT_BOARD_SYNC_APP_CLIENT_ID'], state: 'ok' },
    { name: 'PAT の変数と secret', secrets: ['PECOT_BOARD_SYNC_TOKEN'], variables: ['PECOT_BOARD_SYNC_USE_PAT'], state: 'ok' },
    { name: 'App の変数だけ', secrets: [], variables: ['PECOT_BOARD_SYNC_APP_CLIENT_ID'], state: 'missing' },
  ])('$name があると、token の組の項目を $state にする', async (row) => {
    await explains(`\`board-sync\` のテンプレートの、必要な設定の判定のテストです。${row.name}がある場合に、トークンの組の項目を \`${row.state}\` と判定することを確認します。`)
    expect(evaluateRequirements(requirements, names(row.secrets, row.variables)).map(result => result.state)).toEqual([row.state])
  })
})

const PECOT_ACTION_STEPS = [
  '      - name: Sync the board',
  '        uses: pecotcraft/pecot/actions/board-sync@pecot-actions/v1.2.0',
  '      - uses: pecotcraft/pecot/actions/session-finish@pecot-actions/v1.2.0',
  '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '',
].join('\n')

describe('pecot の action の参照', () => {
  it('タグで pecot の action を指す行から、action の名前とタグを出てくる順に読む', async () => {
    await explains('雛形の中の pecot の action の参照を読む `pecotActionReferences` のテストです。タグで pecot の action を指す行から、action の名前とタグを出現順に返し、ほかの action の行は含めないことを確認します。')
    expect(pecotActionReferences(PECOT_ACTION_STEPS)).toEqual([
      { action: 'board-sync', tag: 'pecot-actions/v1.2.0' },
      { action: 'session-finish', tag: 'pecot-actions/v1.2.0' },
    ])
  })

  it('タグを SHA に直し、行の末尾にタグのコメントを付ける。ほかの行は変えない', async () => {
    await explains('pecot の action のタグを固定する `pinPecotActions` のテストです。タグを commit の SHA に置き換えて行の末尾にタグのコメントを付け、ほかの行は変更しないことを確認します。')
    const sha = 'a'.repeat(40)
    expect(pinPecotActions(PECOT_ACTION_STEPS, () => sha)).toBe([
      '      - name: Sync the board',
      `        uses: pecotcraft/pecot/actions/board-sync@${sha} # pecot-actions/v1.2.0`,
      `      - uses: pecotcraft/pecot/actions/session-finish@${sha} # pecot-actions/v1.2.0`,
      '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      '',
    ].join('\n'))
  })

  it.for([
    { name: 'タグの参照', text: '        uses: pecotcraft/pecot/actions/board-sync@pecot-actions/v1.2.0', expected: true },
    { name: 'SHA の参照', text: `        uses: pecotcraft/pecot/actions/board-sync@${'b'.repeat(40)} # pecot-actions/v1.2.0`, expected: true },
    { name: 'このリポの参照', text: '        uses: ./actions/board-sync', expected: true },
    { name: 'npx の行', text: '        run: npx -y --prefix=/ @pecot/workflow-mcp@latest board sync', expected: false },
  ])('$name を hasPecotActionStep が $expected と読む', async (row) => {
    await explains(`pecot の action を呼ぶ step の有無を判定する \`hasPecotActionStep\` のテストです。${row.name}の行の場合に、\`${String(row.expected)}\` を返すことを確認します。`)
    expect(hasPecotActionStep(row.text)).toBe(row.expected)
  })

  it('npx で @pecot/workflow-mcp を呼ぶ行を返し、コメントの行は返さない', async () => {
    await explains('`npx` で `@pecot/workflow-mcp` を呼ぶ行を探す `npxWorkflowMcpLines` のテストです。`npx` で呼ぶ行だけを返し、コメントの行は含めないことを確認します。')
    const text = [
      '      # npx @pecot/workflow-mcp was used before',
      '        run: npx -y --prefix=/ @pecot/workflow-mcp@latest board sync',
      '          npx -y @pecot/workflow-mcp@next review finish "$PR"',
    ].join('\n')
    expect(npxWorkflowMcpLines(text)).toEqual([
      '        run: npx -y --prefix=/ @pecot/workflow-mcp@latest board sync',
      '          npx -y @pecot/workflow-mcp@next review finish "$PR"',
    ])
  })
})
