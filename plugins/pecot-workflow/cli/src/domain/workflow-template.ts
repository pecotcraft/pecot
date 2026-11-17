// 導入先のリポに置くワークフローの雛形の一覧と、版・利用者の行・要る設定の判定。

/**
secret か変数の名前 1 つ
*/
export interface SettingName {
  readonly kind: 'secret' | 'variable'
  readonly name: string
}

/**
雛形が動くのに要る設定。
- when: 変数 `when` があるときだけ、`require` が要る
- anyOf: 候補のどれか 1 つの組が、全部そろっている
*/
export type SettingRequirement
  = | { readonly type: 'when', readonly when: SettingName, readonly require: SettingName, readonly missing: string }
    | { readonly type: 'anyOf', readonly options: readonly (readonly SettingName[])[], readonly missing: string }

export interface WorkflowTemplate {
  readonly name: string
  /**
  `cli/templates/workflow/` の下のファイル名
  */
  readonly templateFile: string
  /**
  リポのルートからの置き先
  */
  readonly destination: string
  readonly requirements: readonly SettingRequirement[]
}

const AGENT_ANTHROPIC_VARIABLES: readonly SettingName[] = ['FEDERATION_RULE_ID', 'ORGANIZATION_ID', 'SERVICE_ACCOUNT_ID', 'WORKSPACE_ID']
  .map(suffix => ({ kind: 'variable', name: `PECOT_AGENT_ANTHROPIC_${suffix}` }))

/**
エージェント用の認証。自動処理が同じ名前で読む（spec 027 の data-model の「エージェント用の認証」）
*/
const AGENT_REQUIREMENTS: readonly SettingRequirement[] = [
  {
    type: 'when',
    when: { kind: 'variable', name: 'PECOT_AGENT_APP_CLIENT_ID' },
    require: { kind: 'secret', name: 'PECOT_AGENT_APP_PRIVATE_KEY' },
    missing: 'secret PECOT_AGENT_APP_PRIVATE_KEY',
  },
  {
    type: 'anyOf',
    options: [[{ kind: 'secret', name: 'CLAUDE_CODE_OAUTH_TOKEN' }], AGENT_ANTHROPIC_VARIABLES],
    missing: 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*',
  },
]

/**
雛形の一覧。雛形を足すときは行を足す
*/
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  { name: 'review', templateFile: 'pecot-review.yml', destination: '.github/workflows/pecot-review.yml', requirements: AGENT_REQUIREMENTS },
]

export function findWorkflowTemplate(name: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find(template => template.name === name)
}

export interface TemplateVersion {
  readonly name: string
  readonly version: number
}

const VERSION_MARKER = /^# pecot-workflow-template: (\S+) (\d+)\s*$/u

/**
1 行目の `# pecot-workflow-template: <名前> <版>` を読む。無ければ undefined
*/
export function readTemplateVersion(text: string): TemplateVersion | undefined {
  const match = VERSION_MARKER.exec(text.split('\n', 1)[0] ?? '')
  return match === null ? undefined : { name: match[1] ?? '', version: Number(match[2]) }
}

/**
置いたファイルが同梱の雛形より古いか。目印の無いもの、名前の違うもの、版の小さいものを古いとする
*/
export function isOutdated(installed: string, bundled: string): boolean {
  const current = readTemplateVersion(installed)
  const latest = readTemplateVersion(bundled)
  if (latest === undefined) throw new Error('the bundled template has no version marker')
  return current?.name !== latest.name || current.version < latest.version
}

const BLOCK_MARKER = /^\s*# pecot-[\w-]+:([\w-]+):(begin|end)\s*$/u

function blocksOf(text: string): ReadonlyMap<string, readonly string[]> {
  const blocks = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of text.split('\n')) {
    const match = BLOCK_MARKER.exec(line)
    if (match === null) {
      current?.push(line)
      continue
    }
    if (match[2] === 'begin') {
      current = []
      blocks.set(match[1] ?? '', current)
    }
    else {
      current = undefined
    }
  }
  return blocks
}

/**
置いたファイルの begin・end の囲みの中で、同梱の雛形の同じ囲みに無い行。
同梱の雛形と比べるので、後の版で囲みの中の既定の行を変えると、古い既定の行もここに出る（警告に出るだけなので許す）
*/
export function userLines(installed: string, bundled: string): readonly string[] {
  const bundledBlocks = blocksOf(bundled)
  return [...blocksOf(installed)].flatMap(([block, lines]) => {
    const known = new Set(bundledBlocks.get(block))
    return lines.filter(line => line.trim() !== '' && !known.has(line))
  })
}

/**
置いた先で読めた名前。読めなかった一覧は undefined
*/
export interface SettingNames {
  readonly secrets: ReadonlySet<string> | undefined
  readonly variables: ReadonlySet<string> | undefined
}

export type RequirementState = 'ok' | 'missing' | 'skipped'

export interface RequirementResult {
  readonly name: string
  readonly state: RequirementState
}

// 名前の有無。読めない一覧に頼るなら undefined
function has(names: Readonly<SettingNames>, setting: Readonly<SettingName>): boolean | undefined {
  return (setting.kind === 'secret' ? names.secrets : names.variables)?.has(setting.name)
}

function allPresent(names: Readonly<SettingNames>, settings: readonly SettingName[]): boolean | undefined {
  const found = new Set(settings.map(setting => has(names, setting)))
  if (found.has(false)) return false
  return found.has(undefined) ? undefined : true
}

function stateOf(names: Readonly<SettingNames>, requirement: Readonly<SettingRequirement>): RequirementState {
  if (requirement.type === 'when') {
    const condition = has(names, requirement.when)
    if (condition === false) return 'ok'
    const required = has(names, requirement.require)
    if (required === true) return 'ok'
    return condition === undefined || required === undefined ? 'skipped' : 'missing'
  }
  const found = new Set(requirement.options.map(option => allPresent(names, option)))
  if (found.has(true)) return 'ok'
  return found.has(undefined) ? 'skipped' : 'missing'
}

/**
要件ごとに、そろっているか（ok）・足りないか（missing）・読めない一覧に頼るので決まらないか（skipped）を返す
*/
export function evaluateRequirements(requirements: readonly SettingRequirement[], names: Readonly<SettingNames>): readonly RequirementResult[] {
  return requirements.map(requirement => ({ name: requirement.missing, state: stateOf(names, requirement) }))
}
