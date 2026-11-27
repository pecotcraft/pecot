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
  /**
  Claude の GitHub App を使うか。使う雛形だけ、doctor の項目と install の案内に App を入れる
  */
  readonly claudeApp: boolean
}

const AGENT_ANTHROPIC_VARIABLES: readonly SettingName[] = ['FEDERATION_RULE_ID', 'ORGANIZATION_ID', 'SERVICE_ACCOUNT_ID', 'WORKSPACE_ID']
  .map(suffix => ({ kind: 'variable', name: `PECOT_AGENT_ANTHROPIC_${suffix}` }))

const APP_CLIENT_ID: SettingName = { kind: 'variable', name: 'PECOT_AGENT_APP_CLIENT_ID' }
const APP_PRIVATE_KEY: SettingName = { kind: 'secret', name: 'PECOT_AGENT_APP_PRIVATE_KEY' }

const MODEL_AUTH_REQUIREMENT: SettingRequirement = {
  type: 'anyOf',
  options: [[{ kind: 'secret', name: 'CLAUDE_CODE_OAUTH_TOKEN' }], AGENT_ANTHROPIC_VARIABLES],
  missing: 'secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*',
}

/**
エージェント用の認証。自動処理が同じ名前で読む（spec 027 の data-model の「エージェント用の認証」）
*/
const AGENT_REQUIREMENTS: readonly SettingRequirement[] = [
  { type: 'when', when: APP_CLIENT_ID, require: APP_PRIVATE_KEY, missing: 'secret PECOT_AGENT_APP_PRIVATE_KEY' },
  MODEL_AUTH_REQUIREMENT,
]

/**
自動処理は自前の App を必須にする（spec 023 の data-model の「エージェント用の認証」）。必須の 1 つの名前は、候補 1 つの anyOf で書く
*/
const AUTO_REQUIREMENTS: readonly SettingRequirement[] = [
  { type: 'anyOf', options: [[APP_CLIENT_ID]], missing: 'variable PECOT_AGENT_APP_CLIENT_ID' },
  { type: 'anyOf', options: [[APP_PRIVATE_KEY]], missing: 'secret PECOT_AGENT_APP_PRIVATE_KEY' },
  MODEL_AUTH_REQUIREMENT,
]

/**
github-ops は自前の App だけを使い、モデルの認証は要らない。AUTO_REQUIREMENTS の先頭 2 行と同じ形
*/
const GITHUB_OPS_REQUIREMENTS: readonly SettingRequirement[] = [
  { type: 'anyOf', options: [[APP_CLIENT_ID]], missing: 'variable PECOT_AGENT_APP_CLIENT_ID' },
  { type: 'anyOf', options: [[APP_PRIVATE_KEY]], missing: 'secret PECOT_AGENT_APP_PRIVATE_KEY' },
]

/**
ボードの同期は App か PAT のどちらかの組を使う（雛形の先頭のコメント）
*/
const BOARD_SYNC_REQUIREMENTS: readonly SettingRequirement[] = [
  {
    type: 'anyOf',
    options: [
      [{ kind: 'variable', name: 'PECOT_BOARD_SYNC_APP_CLIENT_ID' }, { kind: 'secret', name: 'PECOT_BOARD_SYNC_APP_PRIVATE_KEY' }],
      [{ kind: 'variable', name: 'PECOT_BOARD_SYNC_USE_PAT' }, { kind: 'secret', name: 'PECOT_BOARD_SYNC_TOKEN' }],
    ],
    missing: 'variable PECOT_BOARD_SYNC_APP_CLIENT_ID and secret PECOT_BOARD_SYNC_APP_PRIVATE_KEY, or variable PECOT_BOARD_SYNC_USE_PAT and secret PECOT_BOARD_SYNC_TOKEN',
  },
]

/**
雛形の一覧。雛形を足すときは行を足す
*/
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  { name: 'board-sync', templateFile: 'pecot-board-sync.yml', destination: '.github/workflows/pecot-board-sync.yml', requirements: BOARD_SYNC_REQUIREMENTS, claudeApp: false },
  { name: 'review', templateFile: 'pecot-review.yml', destination: '.github/workflows/pecot-review.yml', requirements: AGENT_REQUIREMENTS, claudeApp: true },
  { name: 'handoff', templateFile: 'pecot-handoff.yml', destination: '.github/workflows/pecot-handoff.yml', requirements: AGENT_REQUIREMENTS, claudeApp: false },
  { name: 'auto', templateFile: 'pecot-auto.yml', destination: '.github/workflows/pecot-auto.yml', requirements: AUTO_REQUIREMENTS, claudeApp: false },
  { name: 'github-ops', templateFile: 'pecot-github-ops.yml', destination: '.github/workflows/pecot-github-ops.yml', requirements: GITHUB_OPS_REQUIREMENTS, claudeApp: false },
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

/**
雛形が pecot の action を指す行の、action の名前とタグ
*/
export interface PecotActionReference {
  readonly action: string
  readonly tag: string
}

// eslint-disable-next-line security/detect-unsafe-regex -- 行ごとに当てる。繰り返す群は空白と `- ` だけで、再試行は行の長さに比例して増えない
const PECOT_ACTION_TAG = /^(\s*(?:-\s+)?uses:\s*)pecotcraft\/pecot\/actions\/([a-z][a-z-]*)@(pecot-actions\/v\S+)\s*$/u
// eslint-disable-next-line security/detect-unsafe-regex -- 各行の先頭に錨がある。省ける群は空白と `- ` だけで、ほかの群は固定の文字列
const PECOT_ACTION_USE = /^\s*(?:-\s+)?uses:\s*(?:pecotcraft\/pecot\/actions\/|\.\/(?:\.pecot-actions\/)?actions\/)/mu
const NPX_WORKFLOW_MCP = /\bnpx\b.*@pecot\/workflow-mcp\b/u

/**
タグで pecot の action を指す行を、出てくる順に返す
*/
export function pecotActionReferences(text: string): readonly PecotActionReference[] {
  return text.split('\n').flatMap((line) => {
    const match = PECOT_ACTION_TAG.exec(line)
    return match === null ? [] : { action: match[2] ?? '', tag: match[3] ?? '' }
  })
}

/**
タグで pecot の action を指す行を、`<SHA> # <タグ>` の形に直す。SHA は shaOf がタグごとに返す
*/
export function pinPecotActions(text: string, shaOf: (tag: string) => string): string {
  return text.split('\n').map((line) => {
    const match = PECOT_ACTION_TAG.exec(line)
    if (match === null) return line
    const [, prefix = '', action = '', tag = ''] = match
    return `${prefix}pecotcraft/pecot/actions/${action}@${shaOf(tag)} # ${tag}`
  }).join('\n')
}

/**
`@pecot/workflow-mcp` を npx で呼ぶ行。pecot の action に移す前の雛形にある
*/
export function npxWorkflowMcpLines(text: string): readonly string[] {
  return text.split('\n').filter(line => NPX_WORKFLOW_MCP.test(line) && !line.trimStart().startsWith('#'))
}

/**
pecot の action を uses で呼ぶ行があるか
*/
export function hasPecotActionStep(text: string): boolean {
  return PECOT_ACTION_USE.test(text)
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
読めた一覧の名前と、読めなかった一覧が無いか（complete）
*/
export interface SettingList {
  readonly names: ReadonlySet<string>
  readonly complete: boolean
}

export interface SettingNames {
  readonly secrets: SettingList
  readonly variables: SettingList
}

export type RequirementState = 'ok' | 'missing' | 'skipped'

export interface RequirementResult {
  readonly name: string
  readonly state: RequirementState
}

// 名前の有無。見つからず、読めなかった一覧があるなら undefined
function has(names: Readonly<SettingNames>, setting: Readonly<SettingName>): boolean | undefined {
  const list = setting.kind === 'secret' ? names.secrets : names.variables
  if (list.names.has(setting.name)) return true
  return list.complete ? false : undefined
}

function allPresent(names: Readonly<SettingNames>, settings: readonly SettingName[]): boolean | undefined {
  const found = new Set(settings.map(setting => has(names, setting)))
  if (found.has(false)) return false
  return found.has(undefined) ? undefined : true
}

// 条件の付いた要件で、条件の名前が無いと undefined（項目にしない）
function stateOf(names: Readonly<SettingNames>, requirement: Readonly<SettingRequirement>): RequirementState | undefined {
  if (requirement.type === 'when') {
    const condition = has(names, requirement.when)
    if (condition === false) return undefined
    const required = has(names, requirement.require)
    if (required === true) return 'ok'
    return condition === undefined || required === undefined ? 'skipped' : 'missing'
  }
  const found = new Set(requirement.options.map(option => allPresent(names, option)))
  if (found.has(true)) return 'ok'
  return found.has(undefined) ? 'skipped' : 'missing'
}

/**
要件ごとに、そろっているか（ok）・足りないか（missing）・読めない一覧に頼るので決まらないか（skipped）を返す。
条件の名前が無い要件は返さない
*/
export function evaluateRequirements(requirements: readonly SettingRequirement[], names: Readonly<SettingNames>): readonly RequirementResult[] {
  const results: RequirementResult[] = []
  for (const requirement of requirements) {
    const state = stateOf(names, requirement)
    if (state !== undefined) results.push({ name: requirement.missing, state })
  }
  return results
}
